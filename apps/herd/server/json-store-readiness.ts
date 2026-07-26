import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveHerdDataDir, resolveModuleDataDir } from '../modules/data-dir.js'
import {
  resolveCommanderDataDir,
  resolveCommanderSessionStorePath,
} from '../modules/commanders/paths.js'
import {
  CommanderSecretsStore,
  isEncryptedCommanderSecretsFile,
} from '../modules/commanders/secrets-store.js'
import { isPersistedCommanderSessionsValid } from '../modules/commanders/store.js'
import { isPersistedCommanderQuestsValid } from '../modules/commanders/quest-store.js'
import { parseMachineRegistry } from '../modules/agents/machines.js'
import {
  inspectMachineCredentialsEncryptionReadiness,
  isEncryptedMachineEnvRecord,
} from '../modules/agents/machine-credentials.js'
import { isPersistedAutomationValid } from '../modules/automations/store.js'
import { isPersistedCommanderChannelBindingsValid } from '../modules/channels/store.js'
import { isPersistedOrgIdentityValid } from '../modules/org-identity/store.js'
import { isPersistedOperatorValid } from '../modules/operators/store.js'
import { isPersistedPolicyStoreValid } from '../modules/policies/store.js'
import { isPersistedPendingSnapshotValid } from '../modules/policies/pending-store.js'
import { isPersistedAppSettingsValid } from '../modules/settings/store.js'
import { JSON_STORE_SCHEMA_VERSION, withJsonStoreSchema } from '../modules/json-store-schema.js'
import { quarantineJsonFile, writeJsonFileAtomically } from '../modules/json-file.js'
import { ProviderSecretsStore } from './api-keys/provider-secrets-store.js'

export type HerdJsonStoreMigrationStatus =
  | 'ready'
  | 'migrated'
  | 'quarantined'
  | 'stale'
  | 'corrupt'
  | 'unwritable'

export interface HerdJsonStoreReadinessEntry {
  id: string
  path: string
  ready: boolean
  schemaVersion: number | null
  requiredSchemaVersion: number
  migrationStatus: HerdJsonStoreMigrationStatus
  error: string | null
  quarantinePath?: string | null
}

export interface HerdJsonStoreReadiness {
  ready: boolean
  sourceRoot: string
  requiredSchemaVersion: number
  migrationStatus: HerdJsonStoreMigrationStatus
  stores: HerdJsonStoreReadinessEntry[]
  error: string | null
}

interface JsonStoreContract {
  id: string
  filePath: string
  acceptsLegacyPayload: (payload: Record<string, unknown>) => boolean
  corruptPolicy?: 'fail' | 'quarantine'
  required?: boolean
  schemaMode?: 'versioned' | 'plain'
  validateRuntimeInvariant?: () => Promise<string | null>
}

export class HerdJsonStoresNotReadyError extends Error {
  constructor(readonly readiness: HerdJsonStoreReadiness) {
    super(formatJsonStoresNotReadyMessage(readiness))
    this.name = 'HerdJsonStoresNotReadyError'
  }
}

function formatJsonStoresNotReadyMessage(readiness: HerdJsonStoreReadiness): string {
  const failedStores = readiness.stores
    .filter((store) => !store.ready)
    .map((store) => {
      const detail = store.error ? `\n  ${store.error}` : ''
      return `- ${store.id}: ${store.migrationStatus} at ${store.path}${detail}`
    })

  return [
    '[json-stores] Herd JSON data stores are not ready.',
    `status: ${readiness.migrationStatus}`,
    `data dir: ${readiness.sourceRoot}`,
    `required schema: ${readiness.requiredSchemaVersion}`,
    ...failedStores,
  ].join('\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function acceptsStringMap(payload: Record<string, unknown>): boolean {
  return Object.values(payload).every((value) => typeof value === 'string')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function acceptsSurfaceBinding(value: unknown): boolean {
  return (
    isObject(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.provider)
    && isNonEmptyString(value.accountId)
    && isNonEmptyString(value.peerId)
    && isNonEmptyString(value.surfaceKey)
    && isNonEmptyString(value.commanderId)
    && isNonEmptyString(value.conversationId)
    && isNonEmptyString(value.createdAt)
    && (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.config === undefined || isObject(value.config))
  )
}

function acceptsSurfaceBindingsPayload(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.bindings)
    && payload.bindings.every(acceptsSurfaceBinding)
}

const PROVIDER_AUTH_STORE_VERSION = 1
const PROVIDER_AUTH_STATUSES = new Set(['ready', 'auth_required', 'unknown'])
const PROVIDER_AUTH_METHODS = new Set(['oauth', 'api-key', 'login', 'missing'])
const CREDENTIAL_POOL_PROVIDERS = new Set(['claude', 'codex'])
const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/iu
const CREDENTIAL_REMOTE_HOME_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u
const CLAUDE_OAUTH_HASH_PATTERN = /^[a-f0-9]{64}$/u

function acceptsOptionalNonEmptyString(
  payload: Record<string, unknown>,
  field: string,
): boolean {
  return payload[field] === undefined || isNonEmptyString(payload[field])
}

function acceptsProviderToken(value: unknown): boolean {
  if (!isObject(value)) {
    return false
  }

  return (
    isNonEmptyString(value.access)
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt)
    && ['refresh', 'idToken', 'accountId', 'email', 'updatedAt']
      .every((field) => acceptsOptionalNonEmptyString(value, field))
  )
}

function acceptsProviderSnapshot(value: unknown): boolean {
  if (!isObject(value)) {
    return false
  }

  return (
    isNonEmptyString(value.provider)
    && isNonEmptyString(value.scopeId)
    && isNonEmptyString(value.host)
    && typeof value.status === 'string'
    && PROVIDER_AUTH_STATUSES.has(value.status)
    && isNonEmptyString(value.lastCheckedAt)
    && ['accountId', 'accountEmail', 'detail', 'reauthUrl']
      .every((field) => acceptsOptionalNonEmptyString(value, field))
    && (
      value.authMethod === undefined
      || (isNonEmptyString(value.authMethod) && PROVIDER_AUTH_METHODS.has(value.authMethod))
    )
  )
}

function acceptsProviderOauthFlow(value: unknown): boolean {
  if (!isObject(value)) {
    return false
  }

  return (
    ['provider', 'scopeId', 'host', 'state', 'codeVerifier', 'codeChallenge', 'redirectUri']
      .every((field) => isNonEmptyString(value[field]))
    && isNonEmptyString(value.createdAt)
    && Number.isFinite(Date.parse(value.createdAt))
    && isNonEmptyString(value.expiresAt)
    && Number.isFinite(Date.parse(value.expiresAt))
  )
}

function acceptsCredentialPoolDir(provider: string, credentialId: string, value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!isNonEmptyString(value) || path.isAbsolute(value)) {
    return false
  }
  const parts = value.replace(/\\/gu, '/').split('/')
  return (
    parts.length === 2
    && parts[0] === provider
    && parts[1] === credentialId
    && parts.every((part) => part !== '.' && part !== '..')
  )
}

function acceptsOptionalIsoTimestamp(
  payload: Record<string, unknown>,
  field: string,
): boolean {
  const value = payload[field]
  return value === undefined || (isNonEmptyString(value) && Number.isFinite(Date.parse(value)))
}

function acceptsCredentialPoolCredential(
  provider: string,
  credentialId: string,
  value: unknown,
): boolean {
  if (!isObject(value)) {
    return false
  }

  return (
    (value.id === undefined || value.id === credentialId)
    && acceptsOptionalNonEmptyString(value, 'label')
    && acceptsCredentialPoolDir(provider, credentialId, value.dir)
    && ['email', 'accountId', 'remoteToken', 'createdAt', 'lastUsedAt', 'authBrokenReason']
      .every((field) => acceptsOptionalNonEmptyString(value, field))
    && (
      value.remoteHomeKey === undefined
      || (
        isNonEmptyString(value.remoteHomeKey)
        && CREDENTIAL_REMOTE_HOME_KEY_PATTERN.test(value.remoteHomeKey)
      )
    )
    && ['exhaustedAt', 'exhaustedUntil', 'authBrokenAt']
      .every((field) => acceptsOptionalIsoTimestamp(value, field))
  )
}

function acceptsCredentialPool(provider: string, value: unknown): boolean {
  if (!isObject(value) || !isObject(value.credentials)) {
    return false
  }

  const credentials = Object.entries(value.credentials)
  if (
    credentials.length === 0
    || !credentials.every(([credentialId, credential]) => (
      CREDENTIAL_ID_PATTERN.test(credentialId)
      && acceptsCredentialPoolCredential(provider, credentialId, credential)
    ))
  ) {
    return false
  }

  const credentialIds = new Set(credentials.map(([credentialId]) => credentialId))
  if (
    value.exhausted !== undefined
    && (
      !Array.isArray(value.exhausted)
      || new Set(value.exhausted).size !== value.exhausted.length
      || !value.exhausted.every((credentialId) => (
        typeof credentialId === 'string'
        && CREDENTIAL_ID_PATTERN.test(credentialId)
        && credentialIds.has(credentialId)
      ))
    )
  ) {
    return false
  }

  if (
    value.active !== undefined
    && (
      typeof value.active !== 'string'
      || !CREDENTIAL_ID_PATTERN.test(value.active)
      || !credentialIds.has(value.active)
    )
  ) {
    return false
  }

  if (value.installedGlobalClaude !== undefined) {
    if (provider !== 'claude' || !isObject(value.installedGlobalClaude)) {
      return false
    }
    const { credentialId, oauthHash } = value.installedGlobalClaude
    if (
      typeof credentialId !== 'string'
      || !credentialIds.has(credentialId)
      || typeof oauthHash !== 'string'
      || !CLAUDE_OAUTH_HASH_PATTERN.test(oauthHash)
    ) {
      return false
    }
  }

  return true
}

function acceptsProviderAuthPayload(payload: Record<string, unknown>): boolean {
  if (
    payload.version !== PROVIDER_AUTH_STORE_VERSION
    || !isObject(payload.providers)
    || !isObject(payload.snapshots)
  ) {
    return false
  }

  const validProviders = Object.entries(payload.providers).every(([provider, scopes]) => (
    isNonEmptyString(provider)
    && isObject(scopes)
    && Object.entries(scopes).every(([scopeId, token]) => (
      isNonEmptyString(scopeId) && acceptsProviderToken(token)
    ))
  ))
  if (!validProviders || !Object.values(payload.snapshots).every(acceptsProviderSnapshot)) {
    return false
  }

  if (
    payload.oauthFlows !== undefined
    && (
      !isObject(payload.oauthFlows)
      || !Object.values(payload.oauthFlows).every(acceptsProviderOauthFlow)
    )
  ) {
    return false
  }

  if (payload.credentialPools !== undefined) {
    if (!isObject(payload.credentialPools)) {
      return false
    }
    const validCredentialPools = Object.entries(payload.credentialPools).every(([provider, pool]) => (
      CREDENTIAL_POOL_PROVIDERS.has(provider) && acceptsCredentialPool(provider, pool)
    ))
    if (!validCredentialPools) {
      return false
    }
  }

  return true
}

const API_KEY_RECORD_SCHEMA_VERSION = 1
const API_KEY_PURPOSES = new Set(['bootstrap', 'permanent'])

function acceptsApiKeyRecord(value: unknown, allowLegacyPurposeInference: boolean): boolean {
  if (!isObject(value)) {
    return false
  }

  const hasBaseShape = (
    ['id', 'name', 'keyHash', 'prefix', 'createdBy', 'createdAt']
      .every((field) => typeof value[field] === 'string')
    && (
      value.expiresAt === undefined
      || value.expiresAt === null
      || typeof value.expiresAt === 'string'
    )
    && (value.lastUsedAt === null || typeof value.lastUsedAt === 'string')
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === 'string')
  )
  if (!hasBaseShape) {
    return false
  }

  if (typeof value.purpose === 'string' && API_KEY_PURPOSES.has(value.purpose)) {
    return true
  }
  return allowLegacyPurposeInference && value.purpose === undefined
}

function acceptsApiKeyPayload(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.keys)) {
    return false
  }
  const recordSchemaVersion = payload.apiKeyRecordSchemaVersion
  if (
    recordSchemaVersion !== undefined
    && recordSchemaVersion !== API_KEY_RECORD_SCHEMA_VERSION
  ) {
    return false
  }
  if (
    payload.bootstrapInitializedAt !== undefined
    && !isNonEmptyString(payload.bootstrapInitializedAt)
  ) {
    return false
  }
  const allowLegacyPurposeInference = recordSchemaVersion === undefined
  return payload.keys.every((key) => acceptsApiKeyRecord(key, allowLegacyPurposeInference))
}

function acceptsEncryptedProviderSecret(value: unknown): boolean {
  return (
    isObject(value)
    && ['iv', 'authTag', 'ciphertext', 'updatedAt']
      .every((field) => typeof value[field] === 'string' && value[field].length > 0)
  )
}

function acceptsProviderSecretsPayload(payload: Record<string, unknown>): boolean {
  return (
    isObject(payload.secrets)
    && Object.values(payload.secrets).every(acceptsEncryptedProviderSecret)
  )
}

function acceptsWorkspaceTargetsPayload(payload: Record<string, unknown>): boolean {
  const targetMap = isObject(payload.targets)
    ? payload.targets
    : isObject(payload.conversations)
      ? payload.conversations
      : payload
  return Object.entries(targetMap).every(([key, value]) => {
    if (key === 'schemaVersion') {
      return true
    }
    if (!isObject(value)) {
      return false
    }
    const machine = value.machine
    return (
      isNonEmptyString(value.targetId)
      && isNonEmptyString(value.label)
      && isNonEmptyString(value.host)
      && isNonEmptyString(value.rootPath)
      && (value.readOnly === undefined || typeof value.readOnly === 'boolean')
      && (machine === undefined || (
        isObject(machine)
        && isNonEmptyString(machine.id)
        && isNonEmptyString(machine.label)
        && isNonEmptyString(machine.host)
      ))
    )
  })
}

function acceptsWorkspacePreferencesPayload(payload: Record<string, unknown>): boolean {
  return payload.panelDefault === undefined
    || payload.panelDefault === 'open'
    || payload.panelDefault === 'closed'
    || payload.panelDefault === 'last-used'
}

function hasStringField(payload: Record<string, unknown>, field: string): boolean {
  return typeof payload[field] === 'string' && payload[field].trim().length > 0
}

function acceptsConversationPayload(payload: Record<string, unknown>): boolean {
  return (
    hasStringField(payload, 'id') &&
    hasStringField(payload, 'commanderId') &&
    hasStringField(payload, 'surface') &&
    hasStringField(payload, 'status')
  )
}

function acceptsMachineRegistryPayload(payload: Record<string, unknown>): boolean {
  try {
    parseMachineRegistry(payload)
    return true
  } catch {
    return false
  }
}

function toReadinessEnv(
  sourceRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!sourceRoot) {
    return env
  }
  return {
    ...env,
    HERD_DATA_DIR: sourceRoot,
  }
}

function resolveSourceRoot(options: {
  sourceRoot?: string
  env: NodeJS.ProcessEnv
}): string {
  return path.resolve(options.sourceRoot ?? resolveHerdDataDir(options.env))
}

async function pathIsFile(filePath: string): Promise<boolean | 'missing'> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    ) {
      return 'missing'
    }
    throw error
  }
}

async function probeJsonStoreWritable(filePath: string, fileExists: boolean): Promise<void> {
  if (fileExists) {
    await access(filePath, constants.W_OK)
  }
  const probePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.readiness-${process.pid}-${randomUUID()}`,
  )
  try {
    await writeJsonFileAtomically(
      probePath,
      { readinessProbe: true },
      { mode: 0o600, trailingNewline: true },
    )
  } finally {
    await rm(probePath, { force: true })
  }
}

async function addOptionalFile(
  stores: JsonStoreContract[],
  contract: JsonStoreContract,
): Promise<void> {
  const status = await pathIsFile(contract.filePath)
  if (status === 'missing') {
    return
  }
  stores.push(contract)
}

async function addCommanderScopedStores(
  stores: JsonStoreContract[],
  commanderDataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(commanderDataDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const commanderRoot = path.join(commanderDataDir, entry.name)
    await addOptionalFile(stores, {
      id: `commanders.${entry.name}.quests`,
      filePath: path.join(commanderRoot, 'quests.json'),
      acceptsLegacyPayload: isPersistedCommanderQuestsValid,
    })
    await addOptionalFile(stores, {
      id: `commanders.${entry.name}.secrets`,
      filePath: path.join(commanderRoot, 'secrets.enc'),
      acceptsLegacyPayload: isEncryptedCommanderSecretsFile,
      schemaMode: 'plain',
      validateRuntimeInvariant: async () => {
        const readiness = await new CommanderSecretsStore({
          dataDir: commanderDataDir,
          keyFilePath: path.join(commanderDataDir, 'master.key'),
          env,
        }).inspectEncryptionReadiness(entry.name)
        return readiness.error
      },
    })

    const conversationsDir = path.join(commanderRoot, 'conversations')
    let conversationFiles: import('node:fs').Dirent[]
    try {
      conversationFiles = await readdir(conversationsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }

    for (const conversationFile of conversationFiles) {
      if (!conversationFile.isFile() || !conversationFile.name.endsWith('.json')) {
        continue
      }
      stores.push({
        id: `commanders.${entry.name}.conversation.${path.basename(conversationFile.name, '.json')}`,
        filePath: path.join(conversationsDir, conversationFile.name),
        acceptsLegacyPayload: acceptsConversationPayload,
        corruptPolicy: 'quarantine',
      })
    }
  }
}

async function addMachineCredentialStores(
  stores: JsonStoreContract[],
  sourceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let machines: ReturnType<typeof parseMachineRegistry>
  try {
    const parsed = JSON.parse(await readFile(path.join(sourceRoot, 'machines.json'), 'utf8')) as unknown
    machines = parseMachineRegistry(parsed)
  } catch {
    // The machines registry contract reports missing/corrupt registry state.
    // Credential contracts can only be enumerated after that registry parses.
    return
  }

  for (const machine of machines) {
    const configuredPath = machine.envFile?.trim()
    if (!configuredPath || !configuredPath.endsWith('.enc')) {
      continue
    }
    const envFilePath = path.resolve(configuredPath)
    await addOptionalFile(stores, {
      id: `machines.${machine.id}.credentials`,
      filePath: envFilePath,
      acceptsLegacyPayload: isEncryptedMachineEnvRecord,
      schemaMode: 'plain',
      validateRuntimeInvariant: async () => {
        const readiness = await inspectMachineCredentialsEncryptionReadiness(machine, {
          envFilePath,
          keyFilePath: path.join(sourceRoot, 'master.key'),
          env,
        })
        return readiness.error
      },
    })
  }
}

async function addAutomationStores(
  stores: JsonStoreContract[],
  automationDataDir: string,
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(automationDataDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'manifest.json') {
      continue
    }
    stores.push({
      id: `automations.${path.basename(entry.name, '.json')}`,
      filePath: path.join(automationDataDir, entry.name),
      acceptsLegacyPayload: isPersistedAutomationValid,
      corruptPolicy: 'quarantine',
    })
  }
}

async function collectJsonStoreContracts(options: {
  sourceRoot?: string
  env: NodeJS.ProcessEnv
}): Promise<JsonStoreContract[]> {
  const sourceRoot = resolveSourceRoot(options)
  const env = toReadinessEnv(sourceRoot, options.env)
  const commanderDataDir = path.resolve(
    options.sourceRoot ? path.join(sourceRoot, 'commander') : resolveCommanderDataDir(env),
  )
  const automationDataDir = path.resolve(
    options.sourceRoot ? path.join(sourceRoot, 'automations') : resolveModuleDataDir('automations', env),
  )
  const stores: JsonStoreContract[] = []

  stores.push({
    id: 'commanders.sessions',
    filePath: resolveCommanderSessionStorePath(commanderDataDir),
    acceptsLegacyPayload: isPersistedCommanderSessionsValid,
    required: true,
  })
  stores.push({
    id: 'commanders.names',
    filePath: path.join(commanderDataDir, 'names.json'),
    acceptsLegacyPayload: acceptsStringMap,
    required: true,
    schemaMode: 'plain',
  })
  await addCommanderScopedStores(stores, commanderDataDir, env)
  await addAutomationStores(stores, automationDataDir)

  // These singleton stores are owned by factories in the default runtime
  // mount graph. Missing files are valid first-boot state, but their target
  // paths must be writable before the process advertises health. Dynamic
  // commander/automation records are discovered above; caches, JSONL logs,
  // credential-pool internals, and channel-adapter auth are intentionally not
  // boot requirements because their owning features are conditional.
  stores.push(
    {
      id: 'agents.provider-auth',
      filePath: path.join(sourceRoot, 'provider-secrets.json'),
      acceptsLegacyPayload: acceptsProviderAuthPayload,
      required: true,
      schemaMode: 'plain',
    },
    {
      id: 'api-keys.keys',
      filePath: path.join(sourceRoot, 'api-keys', 'keys.json'),
      acceptsLegacyPayload: acceptsApiKeyPayload,
      required: true,
    },
    {
      id: 'api-keys.provider-secrets',
      filePath: path.join(sourceRoot, 'api-keys', 'provider-secrets.json'),
      acceptsLegacyPayload: acceptsProviderSecretsPayload,
      required: true,
      validateRuntimeInvariant: async () => {
        const readiness = await new ProviderSecretsStore({
          filePath: path.join(sourceRoot, 'api-keys', 'provider-secrets.json'),
          keyFilePath: path.join(sourceRoot, 'api-keys', 'provider-secrets.key'),
          env,
        }).inspectEncryptionReadiness()
        return readiness.error
      },
    },
    {
      id: 'channels.bindings',
      filePath: path.join(sourceRoot, 'channels.json'),
      acceptsLegacyPayload: isPersistedCommanderChannelBindingsValid,
      required: true,
      schemaMode: 'plain',
    },
    {
      id: 'channels.surface-bindings',
      filePath: path.join(sourceRoot, 'channels', 'surface-bindings.json'),
      acceptsLegacyPayload: acceptsSurfaceBindingsPayload,
      required: true,
      schemaMode: 'plain',
    },
    {
      id: 'org.identity',
      filePath: path.join(sourceRoot, 'org.json'),
      acceptsLegacyPayload: isPersistedOrgIdentityValid,
      required: true,
      schemaMode: 'plain',
    },
    {
      id: 'policies.policies',
      filePath: path.join(sourceRoot, 'policies', 'policies.json'),
      acceptsLegacyPayload: isPersistedPolicyStoreValid,
      required: true,
    },
    {
      id: 'policies.pending',
      filePath: path.join(sourceRoot, 'policies', 'pending.json'),
      acceptsLegacyPayload: isPersistedPendingSnapshotValid,
      required: true,
    },
    {
      id: 'operators.founder',
      filePath: path.join(sourceRoot, 'operators.json'),
      acceptsLegacyPayload: isPersistedOperatorValid,
      required: true,
    },
    {
      id: 'settings.app',
      filePath: path.join(sourceRoot, 'settings', 'app-settings.json'),
      acceptsLegacyPayload: isPersistedAppSettingsValid,
      required: true,
    },
    {
      id: 'machines.registry',
      filePath: path.join(sourceRoot, 'machines.json'),
      acceptsLegacyPayload: acceptsMachineRegistryPayload,
      required: true,
    },
    {
      id: 'workspace.targets',
      filePath: path.join(sourceRoot, 'workspace', 'conversation-targets.json'),
      acceptsLegacyPayload: acceptsWorkspaceTargetsPayload,
      required: true,
      schemaMode: 'plain',
    },
    {
      id: 'workspace.preferences',
      filePath: path.join(sourceRoot, 'workspace', 'preferences.json'),
      acceptsLegacyPayload: acceptsWorkspacePreferencesPayload,
      required: true,
      schemaMode: 'plain',
    },
  )

  await addMachineCredentialStores(stores, sourceRoot, env)

  return stores.sort((left, right) => left.filePath.localeCompare(right.filePath))
}

async function inspectStore(
  contract: JsonStoreContract,
  options: { migrateLegacy: boolean },
): Promise<HerdJsonStoreReadinessEntry> {
  const requiredSchemaVersion = JSON_STORE_SCHEMA_VERSION
  async function runtimeInvariantFailure(
    schemaVersion: number | null,
  ): Promise<HerdJsonStoreReadinessEntry | null> {
    if (!contract.validateRuntimeInvariant) {
      return null
    }
    let error: string | null
    try {
      error = await contract.validateRuntimeInvariant()
    } catch {
      error = 'JSON store runtime invariant validation failed.'
    }
    if (!error) {
      return null
    }
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion,
      requiredSchemaVersion,
      migrationStatus: 'corrupt',
      error,
    }
  }

  async function readyAfterWritableProbe(
    schemaVersion: number | null,
    migrationStatus: HerdJsonStoreMigrationStatus = 'ready',
    fileExists = true,
  ): Promise<HerdJsonStoreReadinessEntry> {
    if (contract.required) {
      try {
        await probeJsonStoreWritable(contract.filePath, fileExists)
      } catch (error) {
        return {
          id: contract.id,
          path: contract.filePath,
          ready: false,
          schemaVersion,
          requiredSchemaVersion,
          migrationStatus: 'unwritable',
          error: `JSON store write probe failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return {
      id: contract.id,
      path: contract.filePath,
      ready: true,
      schemaVersion,
      requiredSchemaVersion,
      migrationStatus,
      error: null,
    }
  }

  async function quarantineCorruptStore(reason: string): Promise<HerdJsonStoreReadinessEntry> {
    try {
      const quarantinePath = await quarantineJsonFile(contract.filePath)
      return {
        id: contract.id,
        path: contract.filePath,
        ready: true,
        schemaVersion: null,
        requiredSchemaVersion,
        migrationStatus: 'quarantined',
        error: `${reason}; quarantined to ${quarantinePath}`,
        quarantinePath,
      }
    } catch (quarantineError) {
      return {
        id: contract.id,
        path: contract.filePath,
        ready: false,
        schemaVersion: null,
        requiredSchemaVersion,
        migrationStatus: 'unwritable',
        error: `${reason}; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
      }
    }
  }

  const fileStatus = await pathIsFile(contract.filePath)
  if (fileStatus === false) {
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'corrupt',
      error: 'JSON store path exists but is not a regular file.',
    }
  }
  if (fileStatus === 'missing') {
    const invariantFailure = await runtimeInvariantFailure(null)
    if (invariantFailure) {
      return invariantFailure
    }
    return readyAfterWritableProbe(null, 'ready', false)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(contract.filePath, 'utf8')) as unknown
  } catch {
    const parseFailure = 'JSON parse failed; raw store bytes were preserved.'
    if (contract.corruptPolicy === 'quarantine') {
      return quarantineCorruptStore(parseFailure)
    }
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'corrupt',
      error: parseFailure,
    }
  }

  if (!isObject(parsed)) {
    if (contract.corruptPolicy === 'quarantine') {
      return quarantineCorruptStore('JSON store root must be an object')
    }
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'corrupt',
      error: 'JSON store root must be an object.',
    }
  }

  if (contract.schemaMode === 'plain') {
    if (!contract.acceptsLegacyPayload(parsed)) {
      return {
        id: contract.id,
        path: contract.filePath,
        ready: false,
        schemaVersion: null,
        requiredSchemaVersion,
        migrationStatus: 'corrupt',
        error: 'JSON store does not match the expected store shape.',
      }
    }
    const invariantFailure = await runtimeInvariantFailure(null)
    if (invariantFailure) {
      return invariantFailure
    }
    return readyAfterWritableProbe(null)
  }

  const schemaVersion = parsed.schemaVersion
  if (schemaVersion !== undefined) {
    if (schemaVersion !== requiredSchemaVersion) {
      return {
        id: contract.id,
        path: contract.filePath,
        ready: false,
        schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : null,
        requiredSchemaVersion,
        migrationStatus: 'stale',
        error: 'JSON store schemaVersion does not match the required version.',
      }
    }
    if (!contract.acceptsLegacyPayload(parsed)) {
      if (contract.corruptPolicy === 'quarantine') {
        return quarantineCorruptStore('JSON store has the current schemaVersion but does not match the expected store shape')
      }
      return {
        id: contract.id,
        path: contract.filePath,
        ready: false,
        schemaVersion: requiredSchemaVersion,
        requiredSchemaVersion,
        migrationStatus: 'corrupt',
        error: 'JSON store has the current schemaVersion but does not match the expected store shape.',
      }
    }
    const invariantFailure = await runtimeInvariantFailure(requiredSchemaVersion)
    if (invariantFailure) {
      return invariantFailure
    }
    return readyAfterWritableProbe(requiredSchemaVersion)
  }

  if (!contract.acceptsLegacyPayload(parsed)) {
    if (contract.corruptPolicy === 'quarantine') {
      return quarantineCorruptStore('JSON store is missing schemaVersion and does not match a known legacy shape')
    }
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'corrupt',
      error: 'JSON store is missing schemaVersion and does not match a known legacy shape.',
    }
  }

  const invariantFailure = await runtimeInvariantFailure(null)
  if (invariantFailure) {
    return invariantFailure
  }

  if (!options.migrateLegacy) {
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'stale',
      error: 'JSON store is missing schemaVersion. Run store:ready without --no-migrate to tag the legacy store.',
    }
  }

  try {
    await writeJsonFileAtomically(
      contract.filePath,
      withJsonStoreSchema(parsed),
      { backup: true, trailingNewline: true },
    )
  } catch (error) {
    return {
      id: contract.id,
      path: contract.filePath,
      ready: false,
      schemaVersion: null,
      requiredSchemaVersion,
      migrationStatus: 'unwritable',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return {
    id: contract.id,
    path: contract.filePath,
    ready: true,
    schemaVersion: requiredSchemaVersion,
    requiredSchemaVersion,
    migrationStatus: 'migrated',
    error: null,
  }
}

function aggregateStatus(
  entries: readonly HerdJsonStoreReadinessEntry[],
): HerdJsonStoreMigrationStatus {
  const failed = entries.find((entry) => !entry.ready)
  if (failed) {
    return failed.migrationStatus
  }
  if (entries.some((entry) => entry.migrationStatus === 'quarantined')) {
    return 'quarantined'
  }
  return entries.some((entry) => entry.migrationStatus === 'migrated')
    ? 'migrated'
    : 'ready'
}

export async function inspectHerdJsonStoreReadiness(options: {
  env?: NodeJS.ProcessEnv
  sourceRoot?: string
  migrateLegacy?: boolean
} = {}): Promise<HerdJsonStoreReadiness> {
  const env = options.env ?? process.env
  const sourceRoot = resolveSourceRoot({ sourceRoot: options.sourceRoot, env })
  const contracts = await collectJsonStoreContracts({ sourceRoot, env })
  const stores: HerdJsonStoreReadinessEntry[] = []
  let migrationAllowed = options.migrateLegacy !== false
  for (const contract of contracts) {
    const entry = await inspectStore(contract, { migrateLegacy: migrationAllowed })
    stores.push(entry)
    if (!entry.ready) {
      // Contracts are path-sorted. Once one store fails closed, later stores
      // are inspected but not mutated, avoiding nondeterministic partial work.
      migrationAllowed = false
    }
  }
  const migrationStatus = aggregateStatus(stores)
  const ready = stores.every((entry) => entry.ready)
  const firstError = stores.find((entry) => !entry.ready)?.error ?? null

  return {
    ready,
    sourceRoot,
    requiredSchemaVersion: JSON_STORE_SCHEMA_VERSION,
    migrationStatus,
    stores,
    error: firstError,
  }
}

export async function ensureHerdJsonStoresReadyForBoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdJsonStoreReadiness> {
  const readiness = await inspectHerdJsonStoreReadiness({
    env,
    migrateLegacy: true,
  })
  if (!readiness.ready) {
    throw new HerdJsonStoresNotReadyError(readiness)
  }
  return readiness
}
