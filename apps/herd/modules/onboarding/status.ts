import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type { AuthUser } from '@gehirn/auth-providers'
import {
  DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES,
  type ApiKeyRecord,
  type ApiKeyStoreLike,
} from '../../server/api-keys/store.js'
import { DEFAULT_CLAUDE_EFFORT_LEVEL } from '../claude-effort.js'
import { createMachineRegistryStore } from '../agents/machines.js'
import {
  type ProviderExecutionCapability,
  type ProviderExecutionReadiness,
} from '../agents/provider-execution-mode.js'
import { mapStreamEventsToMessages } from '../agents/messages/history.js'
import { resolveDefaultProviderId } from '../agents/providers/registry.js'
import { readTranscriptHeadPage } from '../agents/transcript-store.js'
import type { ProviderAdapter } from '../agents/providers/provider-adapter.js'
import type { AutomationScheduler } from '../automations/scheduler.js'
import type { AutomationStore } from '../automations/store.js'
import { resolveSkill } from '../automations/skills.js'
import { createDefaultHeartbeatConfig } from '../commanders/heartbeat.js'
import {
  readCommanderDisplayNames,
  setCommanderDisplayName,
} from '../commanders/names-lock.js'
import { createDefaultCommanderRuntimeConfig } from '../commanders/runtime-config.shared.js'
import type { Conversation, ConversationStore } from '../commanders/conversation-store.js'
import type { CommanderSession, CommanderSessionStore } from '../commanders/store.js'
import { mergeIdentityOperatingStyleIntoCommanderWorkflow } from '../commanders/templates/workflow.js'
import { ensureCommanderVisualProfile } from '../commanders/commander-visual-profile.js'
import {
  GAIA_COMMANDER_AVATAR_URL,
  readCommanderUiProfile,
  resolveCommanderAvatarUrl,
  writeCommanderUiProfile,
} from '../commanders/commander-profile.js'
import { resolveHerdDataDir } from '../data-dir.js'
import { defaultTelemetryStorePath, TelemetryJsonlStore } from '../telemetry/store.js'
import { createFounderBootstrapCandidate } from '../operators/founder-bootstrap.js'
import type { OperatorStore } from '../operators/store.js'
import { OrgIdentityStore } from '../org-identity/store.js'
import {
  CommanderBundledPackagesRootNotFoundError,
  STARTER_COMMANDER_PACKAGE_IDS,
  STARTER_COMMANDER_PACKAGE_STATUS_DEFAULTS,
  loadCommanderPackage,
} from '../commanders/packages/registry.js'
import { buildCommandRoomLaunchTarget } from '../command-room/route-metadata.js'
import type { CommanderPackageDefinition } from '../commanders/packages/types.js'
import {
  cleanupCommanderPackageInstall,
  CommanderPackageRollbackError,
  getCommanderPackageInstallState,
  installCommanderPackage,
  runInCommanderPackageTransaction,
  type CommanderPackageCleanupFailure,
  type CommanderPackageCleanupReceipt,
  type CommanderPackageTransaction,
} from '../commanders/packages/install.js'
import {
  DEFAULT_FOUNDER_ORG_SETUP_FORM_VALUES,
  FOUNDER_SETUP_COMPLETED_PATH,
  FOUNDER_SETUP_PATH,
  validateFounderOrgSetupFormValues,
  type FounderSetupStatus,
  type GaiaOnboardingStatus,
  type MachineOnboardingReadiness,
  type OnboardingCredentialAuth,
  type OnboardingCredentialStatus,
  type OnboardingReadinessState,
  type OnboardingReceipt,
  type OnboardingFirstReplyMetric,
  type OnboardingStatus,
  type OnboardingStep,
  type OnboardingStepId,
  type ProviderOnboardingReadiness,
  type ProviderExecutionOnboardingStatus,
  type StarterCommanderPackageStatus,
  type StarterWorkforceOnboardingStatus,
} from './contracts.js'

const execFile = promisify(execFileCallback)

const GAIA_HOST = 'gaia'
const GAIA_DISPLAY_NAME = 'Gaia'
const GAIA_TEMPLATE_ID = 'gaia-onboarding'
const GAIA_SPEAKING_TONE = 'Mother-of-all onboarding'
const ONBOARDING_STATE_FILE = 'onboarding.json'
const INSTALL_STARTED_AT_FILE = 'install-started-at.json'
const FIRST_REPLY_TELEMETRY_SESSION_ID = 'onboarding-install'
const FIRST_REPLY_TRANSCRIPT_HEAD_EVENT_LIMIT = 32
const GAIA_IDENTITY = [
  'Gaia is the mother-of-all onboarding commander for Herd.',
  'She helps the founder complete first-run setup, create and manage commanders,',
  'configure providers and machines, and keep onboarding decisions routed through backend APIs.',
].join(' ')

export interface ShellCommandResult {
  ok: boolean
  stdout: string
}

export type OnboardingShellRunner = (
  command: string,
  args: readonly string[],
) => Promise<ShellCommandResult>

export interface BuildOnboardingStatusOptions {
  user?: AuthUser
  operatorStore: Pick<OperatorStore, 'getFounder'>
  orgIdentityStore?: OrgIdentityStore
  sessionStore: Pick<CommanderSessionStore, 'list'>
  conversationStore?: Pick<ConversationStore, 'listByCommander' | 'getActiveChatForCommander'>
  automationStore?: Pick<AutomationStore, 'list'>
  commanderDataDir: string
  publicBaseUrl?: string
  providers: readonly ProviderAdapter[]
  providerExecution: ProviderExecutionCapability
  apiKeyStore?: ApiKeyStoreLike
  authenticatedCredential?: OnboardingCredentialAuth
  authenticatedCanManageApiKeys?: boolean
  env?: NodeJS.ProcessEnv
  shellRunner?: OnboardingShellRunner
  loadStarterPackage?: typeof loadCommanderPackage
  packageTransaction?: CommanderPackageTransaction
}

function isActiveApiKey(record: ApiKeyRecord, nowMs: number): boolean {
  if (!record.expiresAt) {
    return true
  }
  const expiresAtMs = Date.parse(record.expiresAt)
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
}

function isPermanentAdminKey(record: ApiKeyRecord): boolean {
  if (record.purpose !== 'permanent' || record.expiresAt) {
    return false
  }
  const scopes = new Set(record.scopes)
  return DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES.every((scope) => scopes.has(scope))
}

async function buildCredentialStatus(
  options: Pick<
    BuildOnboardingStatusOptions,
    'apiKeyStore' | 'authenticatedCredential' | 'authenticatedCanManageApiKeys'
  >,
): Promise<OnboardingCredentialStatus> {
  const records = options.apiKeyStore?.listKeys
    ? await options.apiKeyStore.listKeys()
    : []
  const nowMs = Date.now()
  const activeRecords = records.filter((record) => isActiveApiKey(record, nowMs))
  const activePermanentKeyCount = activeRecords.filter(isPermanentAdminKey).length
  const activeBootstrapKeys = activeRecords
    .filter((record) => record.purpose === 'bootstrap')
    .map((record) => ({
      id: record.id,
      name: record.name,
      expiresAt: record.expiresAt ?? null,
    }))
  const authenticatedAs = options.authenticatedCredential ?? 'unknown'
  const ready = activePermanentKeyCount > 0 && activeBootstrapKeys.length === 0

  return {
    ready,
    state: ready ? 'ready' : activePermanentKeyCount > 0 ? 'warning' : 'missing',
    activePermanentKeyCount,
    activeBootstrapKeys,
    authenticatedAs,
    canRevokeBootstrap: authenticatedAs === 'auth0'
      || (authenticatedAs === 'permanent' && options.authenticatedCanManageApiKeys === true),
    summary: ready
      ? 'A permanent admin API key is active and bootstrap access is revoked.'
      : activePermanentKeyCount === 0
        ? 'Create, save, and verify a non-expiring permanent admin API key before revoking bootstrap access.'
        : 'Use the permanent admin API key, then revoke every active bootstrap key.',
  }
}

export interface SeedGaiaOptions extends BuildOnboardingStatusOptions {
  sessionStore: Pick<CommanderSessionStore, 'list' | 'create' | 'update'>
  conversationStore?: Pick<ConversationStore, 'listByCommander' | 'getActiveChatForCommander' | 'ensureDefaultConversation'>
}

export interface SeedStarterWorkforceOptions extends BuildOnboardingStatusOptions {
  sessionStore: Pick<CommanderSessionStore, 'list' | 'get' | 'create' | 'delete' | 'restoreAfterFailedCleanup'>
  conversationStore?: Pick<ConversationStore, 'listByCommander' | 'getActiveChatForCommander' | 'ensureDefaultConversation' | 'delete'>
  automationStore?: Pick<AutomationStore, 'create' | 'delete' | 'list'>
  automationScheduler?: Pick<AutomationScheduler, 'createAutomation' | 'deleteAutomation'>
  automationSchedulerInitialized?: Promise<void>
  resolveAutomationSkill?: typeof resolveSkill
}

export class StarterWorkforcePreflightError extends Error {
  constructor(
    public readonly missingPackageIds: readonly string[],
    public readonly missingSkillIds: readonly string[],
  ) {
    const details = [
      missingPackageIds.length > 0
        ? `missing packages: ${missingPackageIds.join(', ')}`
        : null,
      missingSkillIds.length > 0
        ? `missing skills: ${missingSkillIds.join(', ')}`
        : null,
    ].filter((detail): detail is string => Boolean(detail))
    super(`Starter workforce preflight failed (${details.join('; ')}). Restore the packaged starter assets and retry.`)
    this.name = 'StarterWorkforcePreflightError'
  }
}

export class StarterWorkforceRollbackError extends Error {
  constructor(
    cause: unknown,
    public readonly cleanupFailures: readonly CommanderPackageCleanupFailure[],
  ) {
    super(
      `Starter workforce installation failed and batch rollback could not complete: ${cleanupFailures.map((failure) => `${failure.packageId}: ${failure.operation}`).join(', ')}`,
      { cause },
    )
    this.name = 'StarterWorkforceRollbackError'
  }
}

async function loadStarterPackageDefinitions(
  loader: typeof loadCommanderPackage,
): Promise<Array<CommanderPackageDefinition | null>> {
  return Promise.all(STARTER_COMMANDER_PACKAGE_IDS.map(async (packageId) => {
    try {
      return await loader(packageId)
    } catch (error) {
      const isMissingPath = (error as NodeJS.ErrnoException).code === 'ENOENT'
      const isMissingBundledRoot = error instanceof CommanderBundledPackagesRootNotFoundError
      if (isMissingPath || isMissingBundledRoot) {
        return null
      }
      throw error
    }
  }))
}

interface OnboardingState {
  starterWorkforceSkipped?: boolean
  installStartedAt?: string
  firstCommanderReplyAt?: string
  firstCommanderReplyElapsedMs?: number
  firstCommanderReplyTelemetryRecordedAt?: string
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function defaultShellRunner(command: string, args: readonly string[]): Promise<ShellCommandResult> {
  try {
    const { stdout } = await execFile(command, [...args], {
      timeout: 1600,
      maxBuffer: 64 * 1024,
    })
    return { ok: true, stdout }
  } catch (error) {
    const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout: string }).stdout
      : ''
    return { ok: false, stdout }
  }
}

function localMachineEnvFile(env: NodeJS.ProcessEnv): string {
  const configured = env.HERD_LOCAL_MACHINE_ENV_FILE?.trim()
  return configured || path.join(homedir(), '.herd-env')
}

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = normalized.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const key = normalized.slice(0, eq).trim()
    let value = normalized.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    parsed[key] = value
  }
  return parsed
}

async function readLocalEnvValues(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(localMachineEnvFile(env), 'utf8'))
  } catch {
    return {}
  }
}

function onboardingStatePath(commanderDataDir: string): string {
  return path.join(commanderDataDir, ONBOARDING_STATE_FILE)
}

function parseIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

async function readOnboardingState(commanderDataDir: string): Promise<OnboardingState> {
  try {
    const parsed = JSON.parse(await readFile(onboardingStatePath(commanderDataDir), 'utf8')) as OnboardingState
    return {
      starterWorkforceSkipped: parsed.starterWorkforceSkipped === true,
      installStartedAt: parseIsoTimestamp(parsed.installStartedAt),
      firstCommanderReplyAt: parseIsoTimestamp(parsed.firstCommanderReplyAt),
      firstCommanderReplyElapsedMs: parsePositiveInteger(parsed.firstCommanderReplyElapsedMs),
      firstCommanderReplyTelemetryRecordedAt: parseIsoTimestamp(parsed.firstCommanderReplyTelemetryRecordedAt),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

async function writeOnboardingState(
  commanderDataDir: string,
  state: OnboardingState,
): Promise<void> {
  await mkdir(commanderDataDir, { recursive: true })
  await writeFile(onboardingStatePath(commanderDataDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function setStarterWorkforceSkipped(
  commanderDataDir: string,
  skipped: boolean,
): Promise<void> {
  const current = await readOnboardingState(commanderDataDir)
  await writeOnboardingState(commanderDataDir, {
    ...current,
    starterWorkforceSkipped: skipped,
  })
}

function installStartedAtCandidates(commanderDataDir: string): string[] {
  const resolved = path.resolve(commanderDataDir)
  const candidates = [path.join(resolved, INSTALL_STARTED_AT_FILE)]
  if (path.basename(resolved) === 'commander') {
    candidates.unshift(path.join(path.dirname(resolved), INSTALL_STARTED_AT_FILE))
  }
  return candidates
}

async function readInstallStartedAt(commanderDataDir: string, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  const envValue = parseIsoTimestamp(env?.HERD_INSTALL_STARTED_AT_ISO)
  if (envValue) {
    return envValue
  }
  for (const filePath of installStartedAtCandidates(commanderDataDir)) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { startedAt?: unknown }
      const startedAt = parseIsoTimestamp(parsed.startedAt)
      if (startedAt) {
        return startedAt
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }
  return null
}

function conversationSessionName(commanderId: string, conversationId: string): string {
  return `commander-${commanderId}-conversation-${conversationId}`
}

async function readFirstAssistantReplyAt(
  commanderId: string | null,
  conversationId: string | null,
): Promise<string | null> {
  if (!commanderId || !conversationId) {
    return null
  }
  const { events } = await readTranscriptHeadPage(
    conversationSessionName(commanderId, conversationId),
    { maxEvents: FIRST_REPLY_TRANSCRIPT_HEAD_EVENT_LIMIT },
  )
  const messages = mapStreamEventsToMessages(events)
  const reply = messages.find((message) =>
    message.kind === 'agent' && message.text.trim().length > 0)
  return parseIsoTimestamp(reply?.timestamp) ?? null
}

async function appendFirstReplyTelemetry(input: {
  recordedAt: string
  elapsedMs: number
  commanderId: string | null
  conversationId: string | null
}): Promise<void> {
  const store = new TelemetryJsonlStore(defaultTelemetryStorePath())
  await store.append({
    type: 'heartbeat',
    recordedAt: input.recordedAt,
    payload: {
      sessionId: FIRST_REPLY_TELEMETRY_SESSION_ID,
      agentName: 'onboarding',
      model: 'local',
      currentTask: `time_to_first_reply_ms=${input.elapsedMs};commander=${input.commanderId ?? 'unknown'};conversation=${input.conversationId ?? 'unknown'}`,
      completed: true,
      timestamp: input.recordedAt,
    },
  })
}

function buildFirstReplyMetric(state: OnboardingState): OnboardingFirstReplyMetric {
  const elapsedMs = state.firstCommanderReplyElapsedMs ?? null
  return {
    installStartedAt: state.installStartedAt ?? null,
    firstReplyAt: state.firstCommanderReplyAt ?? null,
    elapsedMs,
    elapsedMinutes: elapsedMs === null ? null : Math.round((elapsedMs / 60_000) * 10) / 10,
  }
}

async function recordFirstReplyMetricIfObserved(
  options: BuildOnboardingStatusOptions,
  gaia: GaiaOnboardingStatus,
): Promise<OnboardingFirstReplyMetric> {
  const state = await readOnboardingState(options.commanderDataDir)
  const installStartedAt = state.installStartedAt ?? await readInstallStartedAt(options.commanderDataDir, options.env)
  let nextState: OnboardingState = {
    ...state,
    ...(installStartedAt ? { installStartedAt } : {}),
  }

  if (!nextState.firstCommanderReplyAt && installStartedAt) {
    const firstReplyAt = await readFirstAssistantReplyAt(gaia.commanderId, gaia.conversationId)
    if (firstReplyAt) {
      const elapsedMs = Math.max(0, Date.parse(firstReplyAt) - Date.parse(installStartedAt))
      nextState = {
        ...nextState,
        firstCommanderReplyAt: firstReplyAt,
        firstCommanderReplyElapsedMs: elapsedMs,
      }
    }
  }

  if (
    nextState.firstCommanderReplyAt &&
    nextState.firstCommanderReplyElapsedMs !== undefined &&
    !nextState.firstCommanderReplyTelemetryRecordedAt
  ) {
    try {
      await appendFirstReplyTelemetry({
        recordedAt: nextState.firstCommanderReplyAt,
        elapsedMs: nextState.firstCommanderReplyElapsedMs,
        commanderId: gaia.commanderId,
        conversationId: gaia.conversationId,
      })
      nextState = {
        ...nextState,
        firstCommanderReplyTelemetryRecordedAt: new Date().toISOString(),
      }
    } catch (error) {
      console.warn('[onboarding] Failed to record first-reply telemetry:', error)
    }
  }

  if (!isDeepStrictEqual(state, nextState)) {
    await writeOnboardingState(options.commanderDataDir, nextState)
  }
  return buildFirstReplyMetric(nextState)
}

async function buildFounderStatus(
  options: Pick<BuildOnboardingStatusOptions, 'user' | 'operatorStore' | 'orgIdentityStore'>,
): Promise<FounderSetupStatus> {
  const orgIdentityStore = options.orgIdentityStore ?? new OrgIdentityStore()
  const founder = await options.operatorStore.getFounder()
  const orgIdentity = founder ? await orgIdentityStore.get() : null
  const bootstrapCandidate = founder ? null : createFounderBootstrapCandidate(options.user)
  const defaultValues = founder
    ? {
        orgDisplayName: orgIdentity?.name ?? '',
        founderDisplayName: founder.displayName,
        founderEmail: founder.email ?? '',
      }
    : {
        ...DEFAULT_FOUNDER_ORG_SETUP_FORM_VALUES,
        founderDisplayName: bootstrapCandidate?.displayName ?? '',
        founderEmail: bootstrapCandidate?.email ?? '',
      }

  return {
    setupComplete: Boolean(founder),
    defaultValues,
    validationErrors: validateFounderOrgSetupFormValues(defaultValues),
    nextRoute: founder ? FOUNDER_SETUP_COMPLETED_PATH : FOUNDER_SETUP_PATH,
  }
}

async function getConversationId(
  conversationStore: BuildOnboardingStatusOptions['conversationStore'],
  commanderId: string,
): Promise<string | null> {
  if (!conversationStore) {
    return null
  }
  if (typeof conversationStore.getActiveChatForCommander === 'function') {
    const active = await conversationStore.getActiveChatForCommander(commanderId)
    if (active?.id) {
      return active.id
    }
  }
  const conversations = await conversationStore.listByCommander(commanderId)
  const selected = conversations
    .filter((conversation) => conversation.id && conversation.surface === 'ui')
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0]
  return selected?.id ?? null
}

async function findGaiaCommander(
  options: Pick<BuildOnboardingStatusOptions, 'sessionStore' | 'commanderDataDir'>,
): Promise<CommanderSession | null> {
  const [sessions, displayNames] = await Promise.all([
    options.sessionStore.list(),
    readCommanderDisplayNames(options.commanderDataDir),
  ])
  return sessions
    .filter((session) => session.archived !== true)
    .find((session) => (
      session.host === GAIA_HOST ||
      displayNames[session.id]?.trim().toLowerCase() === GAIA_DISPLAY_NAME.toLowerCase()
    )) ?? null
}

export async function gaiaCommanderExists(
  options: Pick<BuildOnboardingStatusOptions, 'sessionStore' | 'commanderDataDir'>,
): Promise<boolean> {
  return Boolean(await findGaiaCommander(options))
}

async function buildGaiaStatus(
  options: Pick<BuildOnboardingStatusOptions, 'sessionStore' | 'conversationStore' | 'commanderDataDir' | 'providers'>,
  providersInput: readonly ProviderOnboardingReadiness[] | Promise<readonly ProviderOnboardingReadiness[]>,
  gaiaInput?: CommanderSession | null | Promise<CommanderSession | null>,
): Promise<GaiaOnboardingStatus> {
  const gaiaPromise = gaiaInput === undefined
    ? findGaiaCommander(options)
    : Promise.resolve(gaiaInput)
  const providers = await providersInput
  const gaia = await gaiaPromise
  const defaultProviderId = gaia?.agentType
    ?? providers.find((provider) => provider.state === 'ready')?.id
    ?? options.providers[0]?.id
    ?? null

  return {
    commanderId: gaia?.id ?? null,
    displayName: GAIA_DISPLAY_NAME,
    avatarUrl: gaia
      ? await resolveCommanderAvatarUrl(
        gaia.id,
        options.commanderDataDir,
        await readCommanderUiProfile(gaia.id, options.commanderDataDir),
        { defaultAvatarUrl: GAIA_COMMANDER_AVATAR_URL },
      )
      : GAIA_COMMANDER_AVATAR_URL,
    exists: Boolean(gaia),
    conversationId: gaia ? await getConversationId(options.conversationStore, gaia.id) : null,
    defaultProviderId,
  }
}

function resolveGaiaCommanderCwd(commander?: Pick<CommanderSession, 'cwd'> | null): string {
  const configured = commander?.cwd?.trim()
  return configured && configured.length > 0 ? configured : process.cwd()
}

async function ensureGaiaCommanderSeedArtifacts(
  options: SeedGaiaOptions,
  commander: CommanderSession,
): Promise<void> {
  const cwd = resolveGaiaCommanderCwd(commander)
  const sideEffects: Array<Promise<unknown>> = [
    options.sessionStore.update(commander.id, (current) => {
      const existingCwd = current.cwd?.trim()
      return existingCwd && existingCwd.length > 0
        ? current
        : { ...current, cwd }
    }),
    mergeIdentityOperatingStyleIntoCommanderWorkflow(commander.id, GAIA_IDENTITY, {
      cwd,
      displayName: GAIA_DISPLAY_NAME,
      basePath: options.commanderDataDir,
      lifecycleScope: options.commanderDataDir,
    }),
    setCommanderDisplayName(options.commanderDataDir, commander.id, GAIA_DISPLAY_NAME),
    writeCommanderUiProfile(commander.id, options.commanderDataDir, ensureCommanderVisualProfile({
      avatar: GAIA_COMMANDER_AVATAR_URL,
      speakingTone: GAIA_SPEAKING_TONE,
    }), options.commanderDataDir),
  ]

  const results = await Promise.allSettled(sideEffects)
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[onboarding] Gaia seed side effect failed:', result.reason)
    }
  }
}

export async function buildStarterWorkforceStatus(
  options: Pick<
    BuildOnboardingStatusOptions,
    | 'sessionStore'
    | 'conversationStore'
    | 'automationStore'
    | 'commanderDataDir'
    | 'loadStarterPackage'
    | 'packageTransaction'
  >,
): Promise<StarterWorkforceOnboardingStatus> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    (packageTransaction) => buildStarterWorkforceStatusLocked({
      ...options,
      packageTransaction,
    }),
  )
}

async function buildStarterWorkforceStatusLocked(
  options: Pick<
    BuildOnboardingStatusOptions,
    | 'sessionStore'
    | 'conversationStore'
    | 'automationStore'
    | 'commanderDataDir'
    | 'loadStarterPackage'
    | 'packageTransaction'
  >,
): Promise<StarterWorkforceOnboardingStatus> {
  const loader = options.loadStarterPackage ?? loadCommanderPackage
  const [definitions, onboardingState] = await Promise.all([
    loadStarterPackageDefinitions(loader),
    readOnboardingState(options.commanderDataDir),
  ])
  const packages = await Promise.all(STARTER_COMMANDER_PACKAGE_IDS.map(
    async (packageId, index): Promise<StarterCommanderPackageStatus> => {
      const definition = definitions[index]
      if (!definition) {
        return {
          packageId,
          ...STARTER_COMMANDER_PACKAGE_STATUS_DEFAULTS[packageId],
          installed: false,
          commanderId: null,
        }
      }
      const installState = await getCommanderPackageInstallState(definition, {
        sessionStore: options.sessionStore,
        conversationStore: options.conversationStore,
        automationStore: options.automationStore,
        commanderDataDir: options.commanderDataDir,
        packageTransaction: options.packageTransaction,
      })
      return {
        packageId: definition.id,
        displayName: definition.displayName,
        role: definition.role,
        summary: definition.summary,
        installed: installState.installed,
        commanderId: installState.commanderId,
      }
    },
  ))
  const definitionsAvailable = definitions.every(Boolean)
  const installedCount = packages.filter((entry) => entry.installed).length
  const installedComplete = definitionsAvailable
    && installedCount === STARTER_COMMANDER_PACKAGE_IDS.length
  const skipped = !installedComplete && onboardingState.starterWorkforceSkipped === true

  return {
    packages,
    installedCount,
    totalCount: STARTER_COMMANDER_PACKAGE_IDS.length,
    skipped,
    complete: definitionsAvailable && (installedComplete || skipped),
  }
}

async function probeProvider(
  provider: ProviderAdapter,
  env: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
  shellRunner: OnboardingShellRunner,
): Promise<ProviderOnboardingReadiness> {
  const machineAuth = provider.machineAuth
  if (!machineAuth) {
    return {
      id: provider.id,
      label: provider.label,
      cliBinaryName: null,
      installed: null,
      authConfigured: true,
      authMode: 'not-required',
      state: 'ready',
      shortAction: 'No local CLI authentication required.',
      verificationCommand: null,
      envSourceKey: null,
    }
  }

  const cliBinaryName = machineAuth.cliBinaryName
  const envSourceKey = machineAuth.authEnvKeys.find((key) => (
    Boolean(env[key]?.trim()) || Boolean(fileEnv[key]?.trim())
  )) ?? null
  const installedPromise = shellRunner('sh', ['-lc', `command -v ${quoteShell(cliBinaryName)}`])
  const loginPromise = !envSourceKey && machineAuth.loginStatusCommand
    ? shellRunner('sh', ['-lc', machineAuth.loginStatusCommand])
    : Promise.resolve({ ok: false, stdout: '' })
  const [installedResult, loginResult] = await Promise.all([installedPromise, loginPromise])
  const installed = installedResult.ok
  const loginConfigured = loginResult.ok

  const authConfigured = Boolean(envSourceKey || loginConfigured)
  const state: OnboardingReadinessState = !installed
    ? 'missing'
    : authConfigured
      ? 'ready'
      : 'warning'
  const authMode = envSourceKey
    ? 'env'
    : loginConfigured
      ? 'login'
      : 'missing'
  const installTarget = machineAuth.installPackageName ?? cliBinaryName
  const shortAction = !installed
    ? `Install ${installTarget}.`
    : authConfigured
      ? 'Ready for local machine execution.'
      : machineAuth.supportedAuthModes.includes('device-auth')
        ? `Run ${cliBinaryName} login and return here.`
        : `Configure ${machineAuth.authEnvKeys[0] ?? `${cliBinaryName.toUpperCase()} auth`}.`

  return {
    id: provider.id,
    label: provider.label,
    cliBinaryName,
    installed,
    authConfigured,
    authMode,
    state,
    shortAction,
    verificationCommand: machineAuth.loginStatusCommand ?? `${cliBinaryName} --version`,
    envSourceKey,
  }
}

async function buildProviderReadiness(
  options: Pick<BuildOnboardingStatusOptions, 'providers' | 'env' | 'shellRunner'>,
  providerExecution: ProviderExecutionReadiness,
): Promise<ProviderOnboardingReadiness[]> {
  if (providerExecution.mode === 'daemon-only') {
    return options.providers.map((provider): ProviderOnboardingReadiness => {
      const installed = providerExecution.daemons.some((daemon) => (
        daemon.connected && daemon.installedProviderIds.includes(provider.id)
      ))
      const ready = providerExecution.readyProviderIds.includes(provider.id)
      return {
        id: provider.id,
        label: provider.label,
        cliBinaryName: provider.machineAuth?.cliBinaryName ?? null,
        installed,
        authConfigured: ready,
        authMode: ready ? 'unknown' : 'missing',
        state: ready ? 'ready' : installed ? 'warning' : 'missing',
        shortAction: ready
          ? 'Ready on a connected daemon.'
          : installed
            ? 'Authenticate this provider on a connected daemon or attach a ready host-managed credential.'
            : 'Connect a daemon with this provider installed and authenticated.',
        verificationCommand: null,
        envSourceKey: null,
      }
    })
  }
  const env = options.env ?? process.env
  const fileEnv = await readLocalEnvValues(env)
  const shellRunner = options.shellRunner ?? defaultShellRunner
  return Promise.all(options.providers.map((provider) => probeProvider(provider, env, fileEnv, shellRunner)))
}

async function buildProviderExecutionReadiness(
  options: Pick<BuildOnboardingStatusOptions, 'providerExecution'>,
): Promise<ProviderExecutionReadiness> {
  return options.providerExecution.getReadiness()
}

async function buildMachineReadiness(
  env: NodeJS.ProcessEnv,
  providerExecution: ProviderExecutionReadiness,
): Promise<MachineOnboardingReadiness[]> {
  const registry = createMachineRegistryStore(path.join(resolveHerdDataDir(env), 'machines.json'))
  const machines = await registry.readMachineRegistry()
  const defaultEnvFile = localMachineEnvFile(env)

  return machines.map((machine): MachineOnboardingReadiness => {
    const isDaemon = Boolean(machine.daemon)
    const isLocal = !isDaemon && (machine.id === 'local' || !machine.host)
    const daemonReadiness = providerExecution.daemons.find((daemon) => daemon.machineId === machine.id)
    const executionDisabled = providerExecution.mode === 'daemon-only' && !isDaemon
    const state: OnboardingReadinessState = executionDisabled
      ? 'skipped'
      : isDaemon
        ? (daemonReadiness?.connected ? 'ready' : 'warning')
        : 'ready'
    return {
      id: machine.id,
      label: machine.label,
      transport: isLocal ? 'local' : isDaemon ? 'daemon' : 'ssh',
      state,
      envFile: machine.envFile ?? (isLocal ? defaultEnvFile : null),
      cwd: machine.cwd ?? null,
      summary: executionDisabled
        ? 'Provider execution is disabled on this target by daemon-only mode.'
        : isLocal
          ? 'This server can run provider CLIs directly.'
          : isDaemon
            ? (daemonReadiness?.connected
              ? `${daemonReadiness.readyProviderIds.length} provider${daemonReadiness.readyProviderIds.length === 1 ? '' : 's'} ready on this connected daemon.`
              : 'Daemon pairing exists but is not connected.')
            : 'Remote SSH machine is registered.',
    }
  })
}

function resolveDaemonOnlyLaunchReadiness(args: {
  providerExecution: ProviderExecutionReadiness
  providers: readonly ProviderOnboardingReadiness[]
  machines: readonly MachineOnboardingReadiness[]
  providerId: string | null
  executionMachineId?: string
}): { ready: boolean; summary: string } {
  const providerId = args.providerId?.trim()
  if (!providerId) {
    return {
      ready: false,
      summary: 'Choose a provider before selecting its execution daemon.',
    }
  }

  const providerLabel = args.providers.find((provider) => provider.id === providerId)?.label ?? providerId
  const machineLabel = (machineId: string): string => (
    args.machines.find((machine) => machine.id === machineId)?.label ?? machineId
  )
  const readyDaemons = args.providerExecution.daemons.filter((daemon) => (
    daemon.connected && daemon.readyProviderIds.some((readyProviderId) => readyProviderId === providerId)
  ))

  if (args.executionMachineId) {
    const selectedReady = readyDaemons.some((daemon) => daemon.machineId === args.executionMachineId)
    return selectedReady
      ? {
          ready: true,
          summary: `${providerLabel} can launch on the selected daemon, ${machineLabel(args.executionMachineId)}.`,
        }
      : {
          ready: false,
          summary: `The selected daemon, ${machineLabel(args.executionMachineId)}, is not ready to launch ${providerLabel}.`,
        }
  }

  if (readyDaemons.length === 1) {
    return {
      ready: true,
      summary: `${providerLabel} can launch on the only provider-ready daemon, ${machineLabel(readyDaemons[0]!.machineId)}.`,
    }
  }
  if (readyDaemons.length > 1) {
    return {
      ready: false,
      summary: `${readyDaemons.length} connected daemons can launch ${providerLabel}. Select and save one execution machine before continuing.`,
    }
  }
  return {
    ready: false,
    summary: `Connect a daemon that is ready to launch ${providerLabel}.`,
  }
}

function buildSteps(args: {
  founderSetup: FounderSetupStatus
  gaia: GaiaOnboardingStatus
  gaiaCommander: Pick<CommanderSession, 'agentType' | 'executionMachineId'> | null
  starterWorkforce: StarterWorkforceOnboardingStatus
  providers: readonly ProviderOnboardingReadiness[]
  machines: readonly MachineOnboardingReadiness[]
  providerExecution: ProviderExecutionReadiness
  credentials: OnboardingCredentialStatus
}): { currentStepId: OnboardingStepId; steps: OnboardingStep[] } {
  const daemonOnlyLaunchReadiness = args.providerExecution.mode === 'daemon-only'
    ? resolveDaemonOnlyLaunchReadiness({
        providerExecution: args.providerExecution,
        providers: args.providers,
        machines: args.machines,
        providerId: args.gaia.defaultProviderId,
        executionMachineId: args.gaiaCommander?.executionMachineId,
      })
    : null
  const hasProviderReady = args.providerExecution.mode === 'daemon-only'
    ? daemonOnlyLaunchReadiness?.ready === true
    : args.providers.length === 0 || args.providers.some((provider) => provider.state === 'ready')
  const hasMachineReady = args.providerExecution.mode === 'daemon-only'
    ? daemonOnlyLaunchReadiness?.ready === true
    : args.machines.some((machine) => machine.state === 'ready')
  const currentStepId: OnboardingStepId = !args.founderSetup.setupComplete
    ? 'founder-org'
    : !args.gaia.exists
      ? 'gaia'
      : !args.starterWorkforce.complete
        ? 'starter-workforce'
        : (!hasProviderReady || !hasMachineReady)
          ? 'providers-machines'
          : !args.credentials.ready
            ? 'credentials'
            : 'launch'

  const stateFor = (id: OnboardingStepId): OnboardingStep['state'] => {
    if (id === currentStepId) return 'current'
    if (id === 'instance') return 'complete'
    if (id === 'founder-org') return args.founderSetup.setupComplete ? 'complete' : 'pending'
    if (id === 'gaia') return args.gaia.exists ? 'complete' : 'pending'
    if (id === 'starter-workforce') {
      if (args.starterWorkforce.complete) return 'complete'
      return args.gaia.exists ? 'current' : 'pending'
    }
    if (id === 'providers-machines') {
      if (hasProviderReady && hasMachineReady) return 'complete'
      return args.starterWorkforce.complete ? 'warning' : 'pending'
    }
    if (id === 'credentials') {
      if (args.credentials.ready) return 'complete'
      return currentStepId === 'credentials' ? 'current' : 'pending'
    }
    return currentStepId === 'launch' ? 'current' : 'pending'
  }

  const steps: OnboardingStep[] = [
    { id: 'instance', label: 'Instance ready', state: stateFor('instance'), summary: 'Local Herd app and bootstrap admin are available.' },
    { id: 'founder-org', label: 'Founder + organization', state: stateFor('founder-org'), summary: args.founderSetup.setupComplete ? 'Founder profile and organization exist.' : 'Create the first local operator and org identity.' },
    { id: 'gaia', label: 'Gaia commander', state: stateFor('gaia'), summary: args.gaia.exists ? 'Gaia is ready to guide onboarding.' : 'Seed Gaia as the default onboarding commander.' },
    { id: 'starter-workforce', label: 'Starter workforce', state: stateFor('starter-workforce'), summary: args.starterWorkforce.skipped ? 'Starter commanders were skipped for this install.' : args.starterWorkforce.complete ? 'Starter commanders are installed.' : 'Install the bundled engineering, research, and assistant commanders.' },
    { id: 'providers-machines', label: 'Providers + machines', state: stateFor('providers-machines'), summary: daemonOnlyLaunchReadiness?.summary ?? (hasProviderReady && hasMachineReady ? 'At least one provider and machine are ready.' : 'Review provider CLI/auth and machine readiness.') },
    { id: 'credentials', label: 'Permanent credential', state: stateFor('credentials'), summary: args.credentials.summary },
    { id: 'launch', label: 'Launch', state: stateFor('launch'), summary: 'Open the org page or command room.' },
  ]

  return { currentStepId, steps }
}

function buildReceipt(args: {
  founderSetup: FounderSetupStatus
  gaia: GaiaOnboardingStatus
  providers: readonly ProviderOnboardingReadiness[]
  machines: readonly MachineOnboardingReadiness[]
  publicBaseUrl?: string
  credentials: OnboardingCredentialStatus
}): OnboardingReceipt {
  const readyProviders = args.providers.filter((provider) => provider.state === 'ready').map((provider) => provider.label)
  const pendingProviders = args.providers.filter((provider) => provider.state !== 'ready').map((provider) => provider.label)
  const providerSummary = [
    readyProviders.length > 0 ? `${readyProviders.join(', ')} ready` : 'No provider ready',
    pendingProviders.length > 0 ? `${pendingProviders.join(', ')} follow-up` : null,
  ].filter(Boolean).join(' · ')

  return {
    url: buildReceiptUrl(args.publicBaseUrl),
    account: args.credentials.ready ? 'permanent API key' : 'temporary bootstrap admin',
    organization: args.founderSetup.defaultValues.orgDisplayName || null,
    founder: args.founderSetup.defaultValues.founderDisplayName || null,
    commander: args.gaia.exists ? args.gaia.displayName : null,
    machine: args.machines.find((machine) => machine.state === 'ready')?.label ?? null,
    providerSummary,
  }
}

function buildReceiptUrl(publicBaseUrl: string | undefined): string {
  const fallbackPort = process.env.PORT?.trim() || '20001'
  const fallbackBaseUrl = `http://localhost:${fallbackPort}`
  const baseUrl = publicBaseUrl?.trim() || fallbackBaseUrl

  try {
    return new URL(FOUNDER_SETUP_COMPLETED_PATH, baseUrl).toString()
  } catch {
    return new URL(FOUNDER_SETUP_COMPLETED_PATH, fallbackBaseUrl).toString()
  }
}

export async function buildOnboardingStatus(
  options: BuildOnboardingStatusOptions,
): Promise<OnboardingStatus> {
  const providerExecution = await buildProviderExecutionReadiness(options)
  const providersPromise = buildProviderReadiness(options, providerExecution)
  const founderSetupPromise = buildFounderStatus(options)
  const machinesPromise = buildMachineReadiness(options.env ?? process.env, providerExecution)
  const gaiaCommanderPromise = findGaiaCommander(options)
  const gaiaPromise = buildGaiaStatus(options, providersPromise, gaiaCommanderPromise)
  const starterWorkforcePromise = buildStarterWorkforceStatus(options)
  const credentialsPromise = buildCredentialStatus(options)
  const [providers, founderSetup, machines, gaia, starterWorkforce, credentials, gaiaCommander] = await Promise.all([
    providersPromise,
    founderSetupPromise,
    machinesPromise,
    gaiaPromise,
    starterWorkforcePromise,
    credentialsPromise,
    gaiaCommanderPromise,
  ])
  const { currentStepId, steps } = buildSteps({
    founderSetup,
    gaia,
    gaiaCommander,
    starterWorkforce,
    providers,
    machines,
    providerExecution,
    credentials,
  })
  const timeToFirstReply = await recordFirstReplyMetricIfObserved(options, gaia)

  return {
    currentStepId,
    steps,
    founderSetup,
    gaia,
    starterWorkforce,
    providers,
    machines,
    providerExecution: {
      mode: providerExecution.mode,
      hostExecutionAllowed: providerExecution.hostExecutionAllowed,
      daemonRequired: providerExecution.daemonRequired,
      state: providerExecution.ready
        ? 'ready'
        : providerExecution.registeredDaemonCount > 0
          ? 'warning'
          : 'missing',
      registeredDaemonCount: providerExecution.registeredDaemonCount,
      connectedDaemonCount: providerExecution.connectedDaemonCount,
      providerReadyDaemonCount: providerExecution.providerReadyDaemonCount,
      readyProviderIds: providerExecution.readyProviderIds,
      summary: providerExecution.summary,
    } satisfies ProviderExecutionOnboardingStatus,
    credentials,
    receipt: buildReceipt({
      founderSetup,
      gaia,
      providers,
      machines,
      publicBaseUrl: options.publicBaseUrl,
      credentials,
    }),
    timeToFirstReply,
    launchTarget: gaia.commanderId && gaia.conversationId
      ? buildCommandRoomLaunchTarget({
          commanderId: gaia.commanderId,
          conversationId: gaia.conversationId,
        }).path
      : FOUNDER_SETUP_COMPLETED_PATH,
  }
}

export interface SeedStarterWorkforceResult {
  starterWorkforce: StarterWorkforceOnboardingStatus
  createdAny: boolean
}

export async function seedStarterWorkforce(
  options: SeedStarterWorkforceOptions,
): Promise<SeedStarterWorkforceResult> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    (packageTransaction) => seedStarterWorkforceLocked({
      ...options,
      packageTransaction,
    }),
  )
}

async function seedStarterWorkforceLocked(
  options: SeedStarterWorkforceOptions,
): Promise<SeedStarterWorkforceResult> {
  const loadStarterPackage = options.loadStarterPackage ?? loadCommanderPackage
  const loadedDefinitions = await loadStarterPackageDefinitions(loadStarterPackage)
  const missingPackageIds = STARTER_COMMANDER_PACKAGE_IDS.filter((_, index) => (
    !loadedDefinitions[index]
  ))
  const definitions = loadedDefinitions.filter(
    (definition): definition is CommanderPackageDefinition => Boolean(definition),
  )
  const requiredSkillIds = definitions.flatMap((definition) => (
    definition.skills.filter((skill) => skill.required).map((skill) => skill.id)
  ))
  const automationSkillIds = definitions.flatMap((definition) => (
    definition.automations.flatMap((automation) => automation.skills)
  ))
  const runtimeSkillIds = [...new Set([
    ...requiredSkillIds,
    ...automationSkillIds,
  ])].sort()
  const resolveAutomationSkill = options.resolveAutomationSkill ?? resolveSkill
  const resolvedSkills = await Promise.all(runtimeSkillIds.map(async (skillId) => ({
    skillId,
    content: await resolveAutomationSkill(skillId),
  })))
  const missingSkillIds = resolvedSkills
    .filter(({ content }) => !content)
    .map(({ skillId }) => skillId)

  if (missingPackageIds.length > 0 || missingSkillIds.length > 0) {
    throw new StarterWorkforcePreflightError(missingPackageIds, missingSkillIds)
  }
  if (
    definitions.some((definition) => definition.automations.length > 0)
    && !options.automationStore
  ) {
    throw new Error('Automation store is required to install the starter workforce')
  }
  await options.automationSchedulerInitialized

  const installOptions = {
    sessionStore: options.sessionStore,
    conversationStore: options.conversationStore,
    automationStore: options.automationStore,
    automationScheduler: options.automationScheduler,
    automationSchedulerInitialized: options.automationSchedulerInitialized,
    commanderDataDir: options.commanderDataDir,
    now: () => new Date(),
    packageTransaction: options.packageTransaction,
  }
  const requestCreatedReceipts: CommanderPackageCleanupReceipt[] = []
  let createdAny = false
  try {
    for (const definition of definitions) {
      const result = await installCommanderPackage(definition, installOptions)
      if (result.created && result.cleanupReceipt) {
        createdAny = true
        requestCreatedReceipts.push(result.cleanupReceipt)
      }
    }
  } catch (error) {
    const cleanupFailures = error instanceof CommanderPackageRollbackError
      ? [...error.cleanupFailures]
      : []
    for (const receipt of [...requestCreatedReceipts].reverse()) {
      cleanupFailures.push(...await cleanupCommanderPackageInstall(receipt, installOptions))
    }
    if (cleanupFailures.length > 0) {
      throw new StarterWorkforceRollbackError(error, cleanupFailures)
    }
    throw error
  }

  await setStarterWorkforceSkipped(options.commanderDataDir, false)
  return {
    starterWorkforce: await buildStarterWorkforceStatus(options),
    createdAny,
  }
}

export async function skipStarterWorkforce(
  options: BuildOnboardingStatusOptions,
): Promise<StarterWorkforceOnboardingStatus> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    async (packageTransaction) => {
      await setStarterWorkforceSkipped(options.commanderDataDir, true)
      return buildStarterWorkforceStatus({ ...options, packageTransaction })
    },
  )
}

export async function seedGaiaCommander(options: SeedGaiaOptions): Promise<GaiaOnboardingStatus> {
  const providerExecution = await buildProviderExecutionReadiness(options)
  const providersPromise = buildProviderReadiness(options, providerExecution)
  const existing = await findGaiaCommander(options)
  if (existing) {
    await ensureGaiaCommanderSeedArtifacts(options, existing)
    return buildGaiaStatus(options, providersPromise, existing)
  }
  const providers = await providersPromise

  const runtimeConfig = createDefaultCommanderRuntimeConfig()
  const createdAt = new Date().toISOString()
  const session: CommanderSession = {
    id: randomUUID(),
    host: GAIA_HOST,
    state: 'idle',
    created: createdAt,
    agentType: (providers.find((provider) => provider.state === 'ready')?.id ?? resolveDefaultProviderId()) as CommanderSession['agentType'],
    effort: DEFAULT_CLAUDE_EFFORT_LEVEL,
    heartbeat: createDefaultHeartbeatConfig(),
    maxTurns: runtimeConfig.defaults.maxTurns,
    contextMode: 'thin',
    taskSource: null,
    cwd: resolveGaiaCommanderCwd(),
    templateId: GAIA_TEMPLATE_ID,
    system: true,
  }

  const created = await options.sessionStore.create(session)
  let conversationId: string | null = null
  const sideEffects: Array<Promise<unknown>> = [
    ensureGaiaCommanderSeedArtifacts(options, created),
  ]
  if (typeof options.conversationStore?.ensureDefaultConversation === 'function') {
    sideEffects.push(
      options.conversationStore.ensureDefaultConversation({
        commanderId: created.id,
        surface: 'ui',
        createdAt: created.created,
        currentTask: null,
      }).then((conversation: Conversation) => {
        conversationId = conversation.id
      }),
    )
  }

  const results = await Promise.allSettled(sideEffects)
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[onboarding] Gaia seed side effect failed:', result.reason)
    }
  }

  return {
    commanderId: created.id,
    displayName: GAIA_DISPLAY_NAME,
    avatarUrl: GAIA_COMMANDER_AVATAR_URL,
    exists: true,
    conversationId: conversationId ?? await getConversationId(options.conversationStore, created.id),
    defaultProviderId: created.agentType ?? providers[0]?.id ?? null,
  }
}
