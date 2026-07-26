import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createDefaultHeartbeatConfig } from '../heartbeat.js'
import {
  deleteCommanderDisplayName,
  readCommanderDisplayNames,
  setCommanderDisplayName,
} from '../names-lock.js'
import { resolveCommanderPaths } from '../paths.js'
import { createDefaultCommanderRuntimeConfig } from '../runtime-config.shared.js'
import {
  buildDefaultCommanderConversationId,
  type CommanderSession,
  type CommanderSessionStore,
} from '../store.js'
import { COMMANDER_PROFILE_FILE, writeCommanderUiProfile } from '../commander-profile.js'
import { ensureCommanderVisualProfile } from '../commander-visual-profile.js'
import { COMMANDER_WORKFLOW_FILE } from '../workflow.js'
import type { Conversation, ConversationStore } from '../conversation-store.js'
import {
  beginCommanderCleanup,
  beginCommanderProvisioning,
  captureCommanderChildMutationVersion,
  withoutCommanderMutationOwnership,
  withCommanderMutation,
  type CommanderCleanupLease,
} from '../child-mutation-coordinator.js'
import type { AutomationScheduler } from '../../automations/scheduler.js'
import type { AutomationStore, CreateAutomationInput } from '../../automations/store.js'
import type { Automation } from '../../automations/types.js'
import { writeJsonFileAtomically } from '../../json-file.js'
import {
  mergeIdentityOperatingStyleIntoCommanderWorkflow,
  scaffoldCommanderWorkflow,
} from '../templates/workflow.js'
import type {
  CommanderPackageDefinition,
  CommanderPackageInstallState,
} from './types.js'

const packageInstallLocks = new Map<string, Promise<void>>()
const packageTransactionLocks = new Map<string, Promise<void>>()
const activePackageTransactions = new Map<string, symbol>()
const PACKAGE_INSTALL_STATE_FILE = 'install-state.json'

export interface CommanderPackageTransaction {
  readonly commanderDataDir: string
  readonly id: symbol
}

export interface CommanderPackageCleanupFailure {
  packageId: string
  operation: string
  error: unknown
}

export interface CommanderPackageCleanupReceipt {
  packageId: string
  packageVersion: string
  installId: string | null
  commanderId: string
  completedAt: string
  conversationIds: readonly string[]
  automations: ReadonlyArray<{
    id: string
    templateId: string
  }>
  transactionId: symbol
  committedMutationVersion?: number
}

export interface CommanderPackageInstallResult {
  created: boolean
  commander: CommanderSession
  displayName: string
  cleanupReceipt: CommanderPackageCleanupReceipt | null
}

export class CommanderPackageRollbackError extends Error {
  constructor(
    public readonly packageId: string,
    cause: unknown,
    public readonly cleanupFailures: readonly CommanderPackageCleanupFailure[],
  ) {
    super(
      `Commander package "${packageId}" install failed and rollback could not complete: ${cleanupFailures.map((failure) => failure.operation).join(', ')}`,
      { cause },
    )
    this.name = 'CommanderPackageRollbackError'
  }
}

export class CommanderPackageInstallConflictError extends Error {
  constructor(
    public readonly packageId: string,
    message: string,
  ) {
    super(`Commander package "${packageId}" cannot be reconciled safely: ${message}`)
    this.name = 'CommanderPackageInstallConflictError'
  }
}

export interface CommanderPackageInstallOptions {
  sessionStore: Pick<
    CommanderSessionStore,
    'list' | 'get' | 'create' | 'delete' | 'restoreAfterFailedCleanup'
  >
  conversationStore?: Pick<ConversationStore, 'listByCommander' | 'getActiveChatForCommander' | 'ensureDefaultConversation' | 'delete'>
  automationStore?: Pick<AutomationStore, 'create' | 'delete' | 'list'>
  automationScheduler?: Pick<AutomationScheduler, 'createAutomation' | 'deleteAutomation'>
  automationSchedulerInitialized?: Promise<void>
  commanderDataDir: string
  commanderBasePath?: string
  now: () => Date
  packageTransaction?: CommanderPackageTransaction
}

export interface CommanderPackageInstallStateOptions {
  sessionStore: Pick<CommanderSessionStore, 'list'>
  conversationStore?: Pick<ConversationStore, 'listByCommander'>
  automationStore?: Pick<AutomationStore, 'list'>
  commanderDataDir: string
  commanderBasePath?: string
  packageTransaction?: CommanderPackageTransaction
}

interface CommanderPackageInstallStateMarker {
  schemaVersion: 1
  state: 'complete' | 'removing'
  installId: string
  packageId: string
  packageVersion: string
  commanderId: string
  completedAt: string
  removingAt?: string
  conversationId: string | null
  automations: Array<{
    id: string
    templateId: string
  }>
}

interface PackageInvariantResult {
  valid: boolean
  marker: CommanderPackageInstallStateMarker | null
  legacy: boolean
  conversationIds: string[]
  automations: Automation[]
}

export async function cleanupCommanderPackageInstall(
  receipt: CommanderPackageCleanupReceipt,
  options: Pick<
    CommanderPackageInstallOptions,
    | 'sessionStore'
    | 'conversationStore'
    | 'automationStore'
    | 'automationScheduler'
    | 'commanderDataDir'
    | 'commanderBasePath'
    | 'now'
    | 'packageTransaction'
  >,
  preacquiredLease?: CommanderCleanupLease,
): Promise<CommanderPackageCleanupFailure[]> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    async (transaction) => withPackageInstallLock(
      receipt.packageId,
      options.commanderDataDir,
      () => cleanupCommanderPackageInstallLocked(receipt, {
        ...options,
        packageTransaction: transaction,
      }, preacquiredLease),
    ),
  )
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

function buildUniqueHost(baseHost: string, existingHosts: ReadonlySet<string>): string {
  if (!existingHosts.has(baseHost)) {
    return baseHost
  }

  let suffix = 2
  let candidate = `${baseHost}-${suffix}`
  while (existingHosts.has(candidate)) {
    suffix += 1
    candidate = `${baseHost}-${suffix}`
  }
  return candidate
}

function buildUniqueDisplayName(
  displayName: string,
  existingDisplayNames: ReadonlySet<string>,
): string {
  const normalized = normalizeName(displayName)
  if (!existingDisplayNames.has(normalized)) {
    return displayName
  }

  let suffix = 2
  let candidate = `${displayName} ${suffix}`
  while (existingDisplayNames.has(normalizeName(candidate))) {
    suffix += 1
    candidate = `${displayName} ${suffix}`
  }
  return candidate
}

function packageInstallLockKey(packageId: string, commanderDataDir: string): string {
  return `${path.resolve(commanderDataDir)}\0${packageId}`
}

function withPackageInstallLock<T>(
  packageId: string,
  commanderDataDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = packageInstallLockKey(packageId, commanderDataDir)
  const previous = packageInstallLocks.get(lockKey) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const guarded = run.then(
    () => undefined,
    () => undefined,
  )
  packageInstallLocks.set(lockKey, guarded)
  return run.finally(() => {
    if (packageInstallLocks.get(lockKey) === guarded) {
      packageInstallLocks.delete(lockKey)
    }
  })
}

function packageTransactionLockKey(commanderDataDir: string): string {
  return path.resolve(commanderDataDir)
}

export function withCommanderPackageTransaction<T>(
  commanderDataDir: string,
  operation: (transaction: CommanderPackageTransaction) => Promise<T>,
): Promise<T> {
  const lockKey = packageTransactionLockKey(commanderDataDir)
  const previous = packageTransactionLocks.get(lockKey) ?? Promise.resolve()
  const transaction: CommanderPackageTransaction = {
    commanderDataDir: lockKey,
    id: Symbol(`commander-package-transaction:${lockKey}`),
  }
  const execute = async (): Promise<T> => {
    activePackageTransactions.set(lockKey, transaction.id)
    try {
      return await operation(transaction)
    } finally {
      if (activePackageTransactions.get(lockKey) === transaction.id) {
        activePackageTransactions.delete(lockKey)
      }
    }
  }
  const run = previous.then(execute, execute)
  const guarded = run.then(
    () => undefined,
    () => undefined,
  )
  packageTransactionLocks.set(lockKey, guarded)
  return run.finally(() => {
    if (packageTransactionLocks.get(lockKey) === guarded) {
      packageTransactionLocks.delete(lockKey)
    }
  })
}

function assertPackageTransaction(
  commanderDataDir: string,
  transaction: CommanderPackageTransaction,
): void {
  if (transaction.commanderDataDir !== packageTransactionLockKey(commanderDataDir)) {
    throw new Error('Commander package transaction does not own this commander data directory')
  }
  if (activePackageTransactions.get(transaction.commanderDataDir) !== transaction.id) {
    throw new Error('Commander package transaction is not the active owner')
  }
}

export function runInCommanderPackageTransaction<T>(
  commanderDataDir: string,
  transaction: CommanderPackageTransaction | undefined,
  operation: (ownedTransaction: CommanderPackageTransaction) => Promise<T>,
): Promise<T> {
  if (transaction) {
    assertPackageTransaction(commanderDataDir, transaction)
    return operation(transaction)
  }
  return withCommanderPackageTransaction(commanderDataDir, operation)
}

function packageRootForCommander(
  commanderId: string,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): string {
  const commanderBasePath = options.commanderBasePath ?? options.commanderDataDir
  return path.join(resolveCommanderPaths(commanderId, commanderBasePath).commanderRoot, '.package')
}

function packageInstallStatePath(
  commanderId: string,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): string {
  // Lifecycle admission must have one authoritative root that every runtime
  // can resolve. Package snapshots may live under a separate memory/base path,
  // but the removal marker always lives under commanderDataDir.
  return path.join(
    resolveCommanderPaths(commanderId, options.commanderDataDir).commanderRoot,
    '.package',
    PACKAGE_INSTALL_STATE_FILE,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseInstallStateMarker(value: unknown): CommanderPackageInstallStateMarker | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    value.schemaVersion !== 1
    || (value.state !== 'complete' && value.state !== 'removing')
    || typeof value.installId !== 'string'
    || !value.installId
    || typeof value.packageId !== 'string'
    || !value.packageId
    || typeof value.packageVersion !== 'string'
    || !value.packageVersion
    || typeof value.commanderId !== 'string'
    || !value.commanderId
    || typeof value.completedAt !== 'string'
    || !Array.isArray(value.automations)
    || !(value.conversationId === null || typeof value.conversationId === 'string')
  ) {
    return null
  }
  const automations: CommanderPackageInstallStateMarker['automations'] = []
  for (const rawAutomation of value.automations) {
    if (
      !isRecord(rawAutomation)
      || typeof rawAutomation.id !== 'string'
      || !rawAutomation.id
      || typeof rawAutomation.templateId !== 'string'
      || !rawAutomation.templateId
    ) {
      return null
    }
    automations.push({
      id: rawAutomation.id,
      templateId: rawAutomation.templateId,
    })
  }
  return {
    schemaVersion: 1,
    state: value.state,
    installId: value.installId,
    packageId: value.packageId,
    packageVersion: value.packageVersion,
    commanderId: value.commanderId,
    completedAt: value.completedAt,
    ...(typeof value.removingAt === 'string' ? { removingAt: value.removingAt } : {}),
    conversationId: value.conversationId,
    automations,
  }
}

async function readInstallStateMarker(
  commanderId: string,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): Promise<{ exists: boolean; marker: CommanderPackageInstallStateMarker | null }> {
  try {
    const parsed = JSON.parse(await readFile(packageInstallStatePath(commanderId, options), 'utf8')) as unknown
    return { exists: true, marker: parseInstallStateMarker(parsed) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, marker: null }
    }
    if (error instanceof SyntaxError) {
      return { exists: true, marker: null }
    }
    throw error
  }
}

async function writeInstallStateMarkerRaw(
  marker: CommanderPackageInstallStateMarker,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): Promise<void> {
  const markerPath = packageInstallStatePath(marker.commanderId, options)
  await mkdir(path.dirname(markerPath), { recursive: true })
  await writeJsonFileAtomically(markerPath, marker, { trailingNewline: true })
}

async function writeInstallStateMarker(
  marker: CommanderPackageInstallStateMarker,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): Promise<void> {
  await withCommanderMutation(marker.commanderId, options.commanderDataDir, () => (
    writeInstallStateMarkerRaw(marker, options)
  ))
}

function expectedAutomationTemplateIds(definition: CommanderPackageDefinition): string[] {
  return definition.automations
    .map((automation) => `${definition.id}:${automation.id}`)
    .sort()
}

function markerAutomationEntries(automations: readonly Automation[]): CommanderPackageInstallStateMarker['automations'] {
  return automations
    .map((automation) => ({
      id: automation.id,
      templateId: automation.templateId ?? '',
    }))
    .sort((left, right) => left.templateId.localeCompare(right.templateId))
}

async function hasRequiredPackageSnapshot(
  definition: CommanderPackageDefinition,
  commanderId: string,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): Promise<boolean> {
  const packageRoot = packageRootForCommander(commanderId, options)
  try {
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as unknown
    if (
      !isRecord(metadata)
      || metadata.id !== definition.id
      || metadata.version !== definition.version
      || metadata.schemaVersion !== definition.schemaVersion
    ) {
      return false
    }
    await Promise.all([
      'skills.manifest.json',
      'automations.manifest.json',
      'onboarding.md',
      'memory-seed.md',
      ...definition.examples.map((example) => path.join('examples', `${example.id}.md`)),
    ].map((relativePath) => access(path.join(packageRoot, relativePath))))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return false
    }
    throw error
  }
}

async function inspectPackageInvariant(
  definition: CommanderPackageDefinition,
  commander: CommanderSession,
  options: CommanderPackageInstallStateOptions,
): Promise<PackageInvariantResult> {
  if (!await hasRequiredPackageSnapshot(definition, commander.id, options)) {
    return { valid: false, marker: null, legacy: false, conversationIds: [], automations: [] }
  }

  const conversations = options.conversationStore
    ? await options.conversationStore.listByCommander(commander.id)
    : []
  const defaultConversationId = buildDefaultCommanderConversationId(commander.id)
  if (
    options.conversationStore
    && !conversations.some((conversation) => conversation.id === defaultConversationId)
  ) {
    return {
      valid: false,
      marker: null,
      legacy: false,
      conversationIds: conversations.map((conversation) => conversation.id),
      automations: [],
    }
  }

  const expectedTemplateIds = expectedAutomationTemplateIds(definition)
  if (expectedTemplateIds.length > 0 && !options.automationStore) {
    return {
      valid: false,
      marker: null,
      legacy: false,
      conversationIds: conversations.map((conversation) => conversation.id),
      automations: [],
    }
  }
  const allAutomations = options.automationStore ? await options.automationStore.list() : []
  const expectedTemplateIdSet = new Set(expectedTemplateIds)
  const packageAutomations = allAutomations.filter((automation) => (
    typeof automation.templateId === 'string'
    && expectedTemplateIdSet.has(automation.templateId)
  ))
  const actualTemplateIds = packageAutomations
    .map((automation) => automation.templateId ?? '')
    .sort()
  const hasExactAutomationOwnership = (
    actualTemplateIds.length === expectedTemplateIds.length
    && actualTemplateIds.every((templateId, index) => templateId === expectedTemplateIds[index])
    && packageAutomations.every((automation) => automation.parentCommanderId === commander.id)
  )
  if (!hasExactAutomationOwnership) {
    return {
      valid: false,
      marker: null,
      legacy: false,
      conversationIds: conversations.map((conversation) => conversation.id),
      automations: allAutomations.filter((automation) => automation.parentCommanderId === commander.id),
    }
  }

  const markerResult = await readInstallStateMarker(commander.id, options)
  if (!markerResult.exists) {
    return {
      valid: true,
      marker: null,
      legacy: true,
      conversationIds: conversations.map((conversation) => conversation.id),
      automations: packageAutomations,
    }
  }
  const marker = markerResult.marker
  const actualMarkerAutomations = markerAutomationEntries(packageAutomations)
  const markerMatches = Boolean(
    marker
    && marker.state === 'complete'
    && marker.packageId === definition.id
    && marker.packageVersion === definition.version
    && marker.commanderId === commander.id
    && marker.conversationId === (options.conversationStore ? defaultConversationId : null)
    && marker.automations.length === actualMarkerAutomations.length
    && marker.automations.every((automation, index) => (
      automation.id === actualMarkerAutomations[index]?.id
      && automation.templateId === actualMarkerAutomations[index]?.templateId
    ))
  )
  return {
    valid: markerMatches,
    marker,
    legacy: false,
    conversationIds: conversations.map((conversation) => conversation.id),
    automations: packageAutomations,
  }
}

function createCompleteInstallMarker(args: {
  definition: CommanderPackageDefinition
  commanderId: string
  installId: string
  completedAt: string
  conversationId: string | null
  automations: readonly Automation[]
}): CommanderPackageInstallStateMarker {
  return {
    schemaVersion: 1,
    state: 'complete',
    installId: args.installId,
    packageId: args.definition.id,
    packageVersion: args.definition.version,
    commanderId: args.commanderId,
    completedAt: args.completedAt,
    conversationId: args.conversationId,
    automations: markerAutomationEntries(args.automations),
  }
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function deletePackageOwnedCommanderFiles(
  commanderId: string,
  commanderBasePath: string,
  commanderDataDir: string,
): Promise<void> {
  const { commanderRoot, memoryRoot } = resolveCommanderPaths(commanderId, commanderBasePath)

  await rm(path.join(commanderRoot, '.package'), { recursive: true, force: true })
  await rm(path.join(commanderRoot, COMMANDER_WORKFLOW_FILE), { force: true })
  await rm(path.join(memoryRoot, COMMANDER_PROFILE_FILE), { force: true })

  // Every directory boundary is removed non-recursively. A late or unknown file
  // therefore makes cleanup fail closed instead of being swept away with the
  // package-owned artifacts.
  await removeEmptyDirectory(memoryRoot)
  await removeEmptyDirectory(path.join(commanderRoot, 'conversations'))
  await removeEmptyDirectory(commanderRoot)

  const canonicalCommanderRoot = resolveCommanderPaths(commanderId, commanderDataDir).commanderRoot
  if (canonicalCommanderRoot !== commanderRoot) {
    await rm(path.join(canonicalCommanderRoot, '.package', PACKAGE_INSTALL_STATE_FILE), { force: true })
    await removeEmptyDirectory(path.join(canonicalCommanderRoot, '.package'))
    await removeEmptyDirectory(path.join(canonicalCommanderRoot, 'conversations'))
    await removeEmptyDirectory(canonicalCommanderRoot)
  }
}

async function cleanupCommanderPackageInstallLocked(
  receipt: CommanderPackageCleanupReceipt,
  options: Pick<
    CommanderPackageInstallOptions,
    | 'sessionStore'
    | 'conversationStore'
    | 'automationStore'
    | 'automationScheduler'
    | 'commanderDataDir'
    | 'commanderBasePath'
    | 'now'
    | 'packageTransaction'
  >,
  preacquiredLease?: CommanderCleanupLease,
): Promise<CommanderPackageCleanupFailure[]> {
  const cleanupFailures: CommanderPackageCleanupFailure[] = []
  const ownershipFailure = (message: string): CommanderPackageCleanupFailure[] => [{
    packageId: receipt.packageId,
    operation: 'verify cleanup ownership',
    error: new Error(message),
  }]
  // Observe the generation before reading any owned child or parent state.
  // Cleanup may destroy nothing until it atomically converts this observation
  // into an exclusive lease; any normal mutation during inspection therefore
  // makes the cleanup fail closed.
  if (!preacquiredLease && receipt.committedMutationVersion === undefined) {
    return ownershipFailure(
      `Cleanup receipt for ${receipt.commanderId} has no durable child-mutation generation`,
    )
  }
  const observedChildMutationVersion = receipt.committedMutationVersion
    ?? captureCommanderChildMutationVersion(receipt.commanderId, options.commanderDataDir)
  const sessions = await options.sessionStore.list()
  const ownedSession = sessions.find((session) => session.id === receipt.commanderId)
  if (ownedSession && ownedSession.templateId !== receipt.packageId) {
    return ownershipFailure(
      `Commander ${receipt.commanderId} no longer belongs to package ${receipt.packageId}`,
    )
  }

  const markerResult = await readInstallStateMarker(receipt.commanderId, options)
  const marker = markerResult.marker
  if (markerResult.exists && !marker) {
    return ownershipFailure(`Install-state ownership for ${receipt.commanderId} is corrupt`)
  }
  if (marker) {
    if (
      marker.packageId !== receipt.packageId
      || marker.packageVersion !== receipt.packageVersion
      || marker.commanderId !== receipt.commanderId
      || marker.installId !== receipt.installId
    ) {
      return ownershipFailure(`Install-state ownership changed for ${receipt.commanderId}`)
    }
  }
  const activeTransactionId = options.packageTransaction?.id
  if (
    marker?.state !== 'removing'
    && receipt.transactionId !== activeTransactionId
  ) {
    return ownershipFailure(
      `Cleanup receipt for ${receipt.commanderId} is not owned by the active install transaction`,
    )
  }

  const packageAutomationPrefix = `${receipt.packageId}:`
  const recordedAutomations = new Map<string, string>()
  for (const automation of [
    ...receipt.automations,
    ...(marker?.automations ?? []),
  ]) {
    if (!automation.templateId.startsWith(packageAutomationPrefix)) {
      return ownershipFailure(
        `Automation ${automation.id} is not owned by package ${receipt.packageId}`,
      )
    }
    const existingTemplateId = recordedAutomations.get(automation.id)
    if (existingTemplateId && existingTemplateId !== automation.templateId) {
      return ownershipFailure(`Automation ownership changed for ${automation.id}`)
    }
    recordedAutomations.set(automation.id, automation.templateId)
  }

  let allAutomations: Automation[] = []
  if (options.automationStore) {
    try {
      allAutomations = await options.automationStore.list()
    } catch (error) {
      return [{
        packageId: receipt.packageId,
        operation: 'verify commander automation ownership',
        error,
      }]
    }
  } else if (recordedAutomations.size > 0) {
    return ownershipFailure('Automation store is unavailable for cleanup ownership verification')
  }
  const commanderAutomations = allAutomations.filter((automation) => (
    automation.parentCommanderId === receipt.commanderId
  ))
  for (const automation of commanderAutomations) {
    if (recordedAutomations.get(automation.id) !== automation.templateId) {
      return ownershipFailure(
        `Commander ${receipt.commanderId} has unrelated automation ${automation.id}`,
      )
    }
  }

  const defaultConversationId = buildDefaultCommanderConversationId(receipt.commanderId)
  const recordedConversationIds = new Set([
    ...receipt.conversationIds,
    ...(marker?.conversationId ? [marker.conversationId] : []),
  ])
  if ([...recordedConversationIds].some((conversationId) => (
    conversationId !== defaultConversationId
  ))) {
    return ownershipFailure(
      `Cleanup receipt contains a non-package conversation for ${receipt.commanderId}`,
    )
  }
  let commanderConversations: Conversation[] = []
  if (options.conversationStore) {
    try {
      commanderConversations = await options.conversationStore.listByCommander(receipt.commanderId)
    } catch (error) {
      return [{
        packageId: receipt.packageId,
        operation: 'verify commander conversation ownership',
        error,
      }]
    }
  } else if (recordedConversationIds.size > 0) {
    return ownershipFailure('Conversation store is unavailable for cleanup ownership verification')
  }
  const unrelatedConversation = commanderConversations.find((conversation) => (
    conversation.id !== defaultConversationId
  ))
  if (unrelatedConversation) {
    return ownershipFailure(
      `Commander ${receipt.commanderId} has unrelated conversation ${unrelatedConversation.id}`,
    )
  }

  const attempt = async (operation: string, cleanup: () => Promise<unknown>): Promise<void> => {
    try {
      await cleanup()
    } catch (error) {
      cleanupFailures.push({ packageId: receipt.packageId, operation, error })
    }
  }
  const commanderBasePath = options.commanderBasePath ?? options.commanderDataDir
  const cleanupLease = preacquiredLease ?? await beginCommanderCleanup(
    receipt.commanderId,
    options.commanderDataDir,
    observedChildMutationVersion,
  )
  if (!cleanupLease) {
    return [{
      packageId: receipt.packageId,
      operation: 'verify commander child mutation generation',
      error: new Error(
        `Commander ${receipt.commanderId} gained child state while cleanup ownership was observed`,
      ),
    }]
  }

  let commanderRemovalVerifiedAbsent = false
  try {
    await cleanupLease.runOwned(async () => {
      if (marker?.state === 'complete') {
        await attempt('transition install-state marker to removing', () => (
          writeInstallStateMarkerRaw({
            ...marker,
            state: 'removing',
            removingAt: options.now().toISOString(),
          }, options)
        ))
      }

      if (cleanupFailures.length === 0) {
        for (const automation of [...commanderAutomations].reverse()) {
          const automationId = automation.id
          if (options.automationScheduler) {
            await attempt(`delete automation ${automationId}`, () => (
              options.automationScheduler!.deleteAutomation(automationId)
            ))
          } else if (options.automationStore) {
            await attempt(`delete automation ${automationId}`, () => (
              options.automationStore!.delete(automationId, { removeFiles: true })
            ))
          }
        }

        if (
          options.conversationStore
          && commanderConversations.some((conversation) => conversation.id === defaultConversationId)
        ) {
          await attempt(`delete conversation ${defaultConversationId}`, () => (
            options.conversationStore!.delete(defaultConversationId)
          ))
        }
      }

      let parentCleanupSafe = cleanupFailures.length === 0
      if (parentCleanupSafe) {
        try {
          const remainingAutomations = options.automationStore
            ? (await options.automationStore.list()).filter((automation) => (
              automation.parentCommanderId === receipt.commanderId
            ))
            : []
          const remainingConversations = options.conversationStore
            ? await options.conversationStore.listByCommander(receipt.commanderId)
            : []
          if (remainingAutomations.length > 0 || remainingConversations.length > 0) {
            parentCleanupSafe = false
            cleanupFailures.push({
              packageId: receipt.packageId,
              operation: 'verify commander has no unrelated child state',
              error: new Error(
                `Commander ${receipt.commanderId} retained child state during package cleanup`,
              ),
            })
          }
        } catch (error) {
          parentCleanupSafe = false
          cleanupFailures.push({
            packageId: receipt.packageId,
            operation: 'verify commander has no remaining child state',
            error,
          })
        }
      }

      if (parentCleanupSafe) {
        let commanderFilesDeleted = false
        try {
          await deletePackageOwnedCommanderFiles(
            receipt.commanderId,
            commanderBasePath,
            options.commanderDataDir,
          )
          commanderFilesDeleted = true
        } catch (error) {
          cleanupFailures.push({
            packageId: receipt.packageId,
            operation: 'delete commander files',
            error,
          })
        }

        if (commanderFilesDeleted) {
          let displayNameDeleted = false
          try {
            await deleteCommanderDisplayName(options.commanderDataDir, receipt.commanderId)
            displayNameDeleted = true
          } catch (error) {
            cleanupFailures.push({
              packageId: receipt.packageId,
              operation: 'delete display-name metadata',
              error,
            })
          }
          if (displayNameDeleted) {
            try {
              const deleted = await withoutCommanderMutationOwnership(
                receipt.commanderId,
                options.commanderDataDir,
                () => options.sessionStore.delete(receipt.commanderId),
              )
              if (!deleted && ownedSession) {
                cleanupFailures.push({
                  packageId: receipt.packageId,
                  operation: 'delete commander session',
                  error: new Error(`Commander session ${receipt.commanderId} disappeared during cleanup`),
                })
              }
            } catch (error) {
              cleanupFailures.push({
                packageId: receipt.packageId,
                operation: 'delete commander session',
                error,
              })
            }
          }
        }
      }

      try {
        const commanderStillExists = (await options.sessionStore.list()).some((session) => (
          session.id === receipt.commanderId
        ))
        commanderRemovalVerifiedAbsent = !commanderStillExists
        if (commanderStillExists && cleanupFailures.length === 0) {
          cleanupFailures.push({
            packageId: receipt.packageId,
            operation: 'verify commander removal after cleanup',
            error: new Error(`Commander session ${receipt.commanderId} still exists after cleanup`),
          })
        }
      } catch (error) {
        cleanupFailures.push({
          packageId: receipt.packageId,
          operation: 'verify commander removal after cleanup',
          error,
        })
      }

      if (cleanupFailures.length > 0 && ownedSession) {
        await attempt('restore incomplete commander cleanup anchor', async () => {
          await options.sessionStore.restoreAfterFailedCleanup(ownedSession)
          commanderRemovalVerifiedAbsent = false
        })
        await attempt('write incomplete commander cleanup marker', () => (
          writeInstallStateMarkerRaw({
            schemaVersion: 1,
            state: 'removing',
            installId: receipt.installId ?? randomUUID(),
            packageId: receipt.packageId,
            packageVersion: receipt.packageVersion,
            commanderId: receipt.commanderId,
            completedAt: receipt.completedAt,
            removingAt: options.now().toISOString(),
            conversationId: recordedConversationIds.has(defaultConversationId)
              ? defaultConversationId
              : null,
            automations: [...recordedAutomations.entries()].map(([id, templateId]) => ({
              id,
              templateId,
            })).sort((left, right) => left.templateId.localeCompare(right.templateId)),
          }, options)
        ))
      }
    })
  } finally {
    if (!preacquiredLease) {
      cleanupLease.complete({
        deleted: commanderRemovalVerifiedAbsent && cleanupFailures.length === 0,
      })
    }
  }

  return cleanupFailures
}

export async function getCommanderPackageInstallState(
  definition: CommanderPackageDefinition,
  options: CommanderPackageInstallStateOptions,
): Promise<CommanderPackageInstallState> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    async (transaction) => withPackageInstallLock(
      definition.id,
      options.commanderDataDir,
      async () => getCommanderPackageInstallStateLocked(definition, {
        ...options,
        packageTransaction: transaction,
      }),
    ),
  )
}

async function getCommanderPackageInstallStateLocked(
  definition: CommanderPackageDefinition,
  options: CommanderPackageInstallStateOptions,
): Promise<CommanderPackageInstallState> {
  const [sessions, displayNames] = await Promise.all([
    options.sessionStore.list(),
    readCommanderDisplayNames(options.commanderDataDir),
  ])
  const candidates = sessions.filter((session) => (
    session.archived !== true && session.templateId === definition.id
  ))
  if (candidates.length !== 1) {
    return { installed: false, commanderId: null, displayName: null }
  }
  const installed = candidates[0]!
  const invariant = await inspectPackageInvariant(definition, installed, options)
  if (!invariant.valid) {
    return { installed: false, commanderId: null, displayName: null }
  }
  return {
    installed: true,
    commanderId: installed.id,
    displayName: displayNames[installed.id]?.trim() || installed.host,
  }
}

async function writeInstalledPackageSnapshot(
  commanderId: string,
  definition: CommanderPackageDefinition,
  commanderBasePath: string,
  lifecycleScope: string,
  now: () => Date,
): Promise<void> {
  await withCommanderMutation(commanderId, lifecycleScope, async () => {
    const { commanderRoot } = resolveCommanderPaths(commanderId, commanderBasePath)
    const packageRoot = path.join(commanderRoot, '.package')
    await mkdir(path.join(packageRoot, 'examples'), { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      schemaVersion: definition.schemaVersion,
      id: definition.id,
      version: definition.version,
      displayName: definition.displayName,
      role: definition.role,
      installedAt: now().toISOString(),
    }, null, 2), 'utf8')
    await writeFile(path.join(packageRoot, 'skills.manifest.json'), JSON.stringify({
      required: definition.skills.filter((skill) => skill.required),
      optional: definition.skills.filter((skill) => !skill.required),
    }, null, 2), 'utf8')
    await writeFile(path.join(packageRoot, 'automations.manifest.json'), JSON.stringify({
      automations: definition.automations,
    }, null, 2), 'utf8')
    await writeFile(path.join(packageRoot, 'onboarding.md'), definition.onboarding, 'utf8')
    await writeFile(path.join(packageRoot, 'memory-seed.md'), definition.memorySeed, 'utf8')
    await Promise.all(definition.examples.map((example) =>
      writeFile(path.join(packageRoot, 'examples', `${example.id}.md`), example.body, 'utf8'),
    ))
  })
}

function buildPackageAutomationInput(
  definition: CommanderPackageDefinition,
  commander: CommanderSession,
  automation: CommanderPackageDefinition['automations'][number],
): CreateAutomationInput {
  return {
    parentCommanderId: commander.id,
    name: automation.id,
    trigger: automation.trigger,
    ...(automation.schedule ? { schedule: automation.schedule } : {}),
    ...(automation.questTrigger ? { questTrigger: automation.questTrigger } : {}),
    instruction: automation.instruction,
    agentType: automation.agentType ?? definition.agentType,
    permissionMode: 'default',
    skills: automation.skills,
    templateId: `${definition.id}:${automation.id}`,
    status: automation.status,
    description: automation.description ?? automation.purpose,
    timezone: automation.timezone,
    machine: automation.machine ?? '',
    workDir: automation.workDir,
    model: automation.model,
    sessionType: automation.sessionType,
    seedMemory: automation.seedMemory,
    sourceConversationId: automation.sourceConversationId,
    maxRuns: automation.maxRuns,
  }
}

async function seedPackageAutomations(
  definition: CommanderPackageDefinition,
  commander: CommanderSession,
  options: CommanderPackageInstallOptions,
  onCreatedAutomation?: (automation: Automation) => void,
): Promise<Automation[]> {
  if (definition.automations.length === 0) {
    return []
  }

  if (!options.automationStore) {
    throw new Error('Automation store is required to install package preset automations')
  }

  await options.automationSchedulerInitialized
  const createdAutomations: Automation[] = []
  for (const automation of definition.automations) {
    const input = buildPackageAutomationInput(definition, commander, automation)
    const created = options.automationScheduler
      ? await options.automationScheduler.createAutomation(input)
      : await options.automationStore!.create(input)
    createdAutomations.push(created)
    onCreatedAutomation?.(created)
  }
  return createdAutomations
}

export async function installCommanderPackage(
  definition: CommanderPackageDefinition,
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageInstallResult> {
  return runInCommanderPackageTransaction(
    options.commanderDataDir,
    options.packageTransaction,
    async (transaction) => withPackageInstallLock(
      definition.id,
      options.commanderDataDir,
      () => installCommanderPackageLocked(definition, {
        ...options,
        packageTransaction: transaction,
      }),
    ),
  )
}

interface CommanderPackageCandidateEvidence {
  commander: CommanderSession
  marker: CommanderPackageInstallStateMarker | null
}

function packageInstallConflict(
  definition: CommanderPackageDefinition,
  message: string,
): CommanderPackageInstallConflictError {
  return new CommanderPackageInstallConflictError(definition.id, message)
}

async function inspectCandidateEvidence(
  definition: CommanderPackageDefinition,
  commander: CommanderSession,
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageCandidateEvidence> {
  const markerResult = await readInstallStateMarker(commander.id, options)
  if (markerResult.exists && !markerResult.marker) {
    throw packageInstallConflict(
      definition,
      `install-state marker for commander ${commander.id} is corrupt`,
    )
  }
  if (
    markerResult.marker
    && (
      markerResult.marker.packageId !== definition.id
      || markerResult.marker.commanderId !== commander.id
    )
  ) {
    throw packageInstallConflict(
      definition,
      `install-state ownership for commander ${commander.id} conflicts with the package session`,
    )
  }
  const expectedConversationId = buildDefaultCommanderConversationId(commander.id)
  if (
    markerResult.marker?.conversationId
    && markerResult.marker.conversationId !== expectedConversationId
  ) {
    throw packageInstallConflict(
      definition,
      `install-state conversation ownership for commander ${commander.id} is invalid`,
    )
  }
  return {
    commander,
    marker: markerResult.marker,
  }
}

async function assertRepairablePackageSnapshotIdentity(
  definition: CommanderPackageDefinition,
  commanderId: string,
  options: Pick<CommanderPackageInstallOptions, 'commanderDataDir' | 'commanderBasePath'>,
): Promise<void> {
  const metadataPath = path.join(packageRootForCommander(commanderId, options), 'package.json')
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
    if (
      isRecord(metadata)
      && typeof metadata.id === 'string'
      && metadata.id.trim().length > 0
      && metadata.id !== definition.id
    ) {
      throw packageInstallConflict(
        definition,
        `package snapshot for commander ${commanderId} belongs to ${metadata.id}`,
      )
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
      || error instanceof SyntaxError
    ) {
      return
    }
    throw error
  }
}

function assertExpectedAutomationOwnership(
  definition: CommanderPackageDefinition,
  commanderId: string,
  allAutomations: readonly Automation[],
): Map<string, Automation> {
  const ownedByTemplateId = new Map<string, Automation>()
  for (const templateId of expectedAutomationTemplateIds(definition)) {
    const matches = allAutomations.filter((automation) => automation.templateId === templateId)
    if (matches.length > 1) {
      throw packageInstallConflict(
        definition,
        `preset automation ${templateId} has duplicate global owners`,
      )
    }
    const match = matches[0]
    if (match && match.parentCommanderId !== commanderId) {
      throw packageInstallConflict(
        definition,
        `preset automation ${templateId} belongs to commander ${match.parentCommanderId ?? 'none'}`,
      )
    }
    if (match) {
      ownedByTemplateId.set(templateId, match)
    }
  }
  return ownedByTemplateId
}

async function deleteRepairCreatedAutomations(
  definition: CommanderPackageDefinition,
  createdAutomations: readonly Automation[],
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageCleanupFailure[]> {
  const failures: CommanderPackageCleanupFailure[] = []
  for (const automation of [...createdAutomations].reverse()) {
    try {
      if (options.automationScheduler) {
        await options.automationScheduler.deleteAutomation(automation.id)
      } else if (options.automationStore) {
        await options.automationStore.delete(automation.id, { removeFiles: true })
      }
    } catch (error) {
      failures.push({
        packageId: definition.id,
        operation: `delete repair-created automation ${automation.id}`,
        error,
      })
    }
  }
  return failures
}

async function finishIncompleteCommanderArtifacts(
  definition: CommanderPackageDefinition,
  commander: CommanderSession,
  options: CommanderPackageInstallOptions,
): Promise<void> {
  const commanderBasePath = options.commanderBasePath ?? options.commanderDataDir
  const displayNames = await readCommanderDisplayNames(options.commanderDataDir)
  const displayName = displayNames[commander.id]?.trim() || definition.displayName

  await scaffoldCommanderWorkflow(
    commander.id,
    { displayName },
    commanderBasePath,
    options.commanderDataDir,
  )
  await mergeIdentityOperatingStyleIntoCommanderWorkflow(commander.id, definition.commanderMd, {
    displayName,
    basePath: commanderBasePath,
    lifecycleScope: options.commanderDataDir,
  })
  if (!displayNames[commander.id]?.trim()) {
    await setCommanderDisplayName(options.commanderDataDir, commander.id, displayName)
  }

  const { commanderRoot, memoryRoot } = resolveCommanderPaths(commander.id, commanderBasePath)
  const profilePath = path.join(memoryRoot, COMMANDER_PROFILE_FILE)
  try {
    await access(profilePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    await writeCommanderUiProfile(commander.id, commanderBasePath, ensureCommanderVisualProfile({
      ...definition.uiProfile,
    }), options.commanderDataDir)
  }

  const repairedDisplayNames = await readCommanderDisplayNames(options.commanderDataDir)
  if (!repairedDisplayNames[commander.id]?.trim()) {
    throw new Error(`Commander package "${definition.id}" repair left display-name metadata missing`)
  }
  await Promise.all([
    access(path.join(commanderRoot, COMMANDER_WORKFLOW_FILE)),
    access(profilePath),
  ])
}

async function repairCommanderPackageInPlaceOwned(
  definition: CommanderPackageDefinition,
  evidence: CommanderPackageCandidateEvidence,
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageInstallResult> {
  const commander = evidence.commander
  const defaultConversationId = buildDefaultCommanderConversationId(commander.id)
  await assertRepairablePackageSnapshotIdentity(definition, commander.id, options)

  if (definition.automations.length > 0 && !options.automationStore) {
    throw new Error('Automation store is required to repair package preset automations')
  }
  const initialAutomations = options.automationStore
    ? await options.automationStore.list()
    : []
  const ownedByTemplateId = assertExpectedAutomationOwnership(
    definition,
    commander.id,
    initialAutomations,
  )

  let conversationId: string | null = null
  if (options.conversationStore) {
    const conversations = await options.conversationStore.listByCommander(commander.id)
    const existingDefault = conversations.find((conversation) => (
      conversation.id === defaultConversationId
    ))
    const conversation = existingDefault ?? await options.conversationStore.ensureDefaultConversation({
      commanderId: commander.id,
      surface: 'ui',
      createdAt: commander.created,
      currentTask: null,
    }) as Conversation
    if (
      conversation.id !== defaultConversationId
      || conversation.commanderId !== commander.id
    ) {
      throw packageInstallConflict(
        definition,
        `default conversation ${defaultConversationId} has conflicting ownership`,
      )
    }
    conversationId = conversation.id
  }

  if (evidence.marker?.state !== 'complete') {
    await finishIncompleteCommanderArtifacts(definition, commander, options)
  }

  const createdAutomations: Automation[] = []
  try {
    await options.automationSchedulerInitialized
    for (const automationDefinition of definition.automations) {
      const templateId = `${definition.id}:${automationDefinition.id}`
      if (ownedByTemplateId.has(templateId)) {
        continue
      }
      const input = buildPackageAutomationInput(definition, commander, automationDefinition)
      const createdAutomation = options.automationScheduler
        ? await options.automationScheduler.createAutomation(input)
        : await options.automationStore!.create(input)
      createdAutomations.push(createdAutomation)
      if (
        createdAutomation.templateId !== templateId
        || createdAutomation.parentCommanderId !== commander.id
      ) {
        throw packageInstallConflict(
          definition,
          `created preset automation ${templateId} has conflicting ownership`,
        )
      }
    }

    const commanderBasePath = options.commanderBasePath ?? options.commanderDataDir
    await writeInstalledPackageSnapshot(
      commander.id,
      definition,
      commanderBasePath,
      options.commanderDataDir,
      options.now,
    )

    const repairedAutomations = options.automationStore
      ? await options.automationStore.list()
      : []
    const repairedByTemplateId = assertExpectedAutomationOwnership(
      definition,
      commander.id,
      repairedAutomations,
    )
    if (repairedByTemplateId.size !== definition.automations.length) {
      throw new Error(`Commander package "${definition.id}" repair left preset automations missing`)
    }

    await writeInstallStateMarker(createCompleteInstallMarker({
      definition,
      commanderId: commander.id,
      installId: evidence.marker?.installId ?? randomUUID(),
      completedAt: evidence.marker?.completedAt ?? options.now().toISOString(),
      conversationId,
      automations: [...repairedByTemplateId.values()],
    }), options)
  } catch (error) {
    const cleanupFailures = await deleteRepairCreatedAutomations(
      definition,
      createdAutomations,
      options,
    )
    if (cleanupFailures.length > 0) {
      throw new CommanderPackageRollbackError(definition.id, error, cleanupFailures)
    }
    throw error
  }

  const displayNames = await readCommanderDisplayNames(options.commanderDataDir)
  return {
    created: false,
    commander,
    displayName: displayNames[commander.id]?.trim() || commander.host,
    cleanupReceipt: null,
  }
}

async function repairCommanderPackageInPlace(
  definition: CommanderPackageDefinition,
  evidence: CommanderPackageCandidateEvidence,
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageInstallResult> {
  return withCommanderMutation(
    evidence.commander.id,
    options.commanderDataDir,
    () => repairCommanderPackageInPlaceOwned(definition, evidence, options),
  )
}

function buildRemovingCleanupReceipt(
  evidence: CommanderPackageCandidateEvidence,
  options: CommanderPackageInstallOptions,
): CommanderPackageCleanupReceipt {
  const marker = evidence.marker
  if (!marker || marker.state !== 'removing' || !options.packageTransaction) {
    throw new Error('Removing package cleanup requires an owned removing marker transaction')
  }
  return {
    packageId: marker.packageId,
    packageVersion: marker.packageVersion,
    installId: marker.installId,
    commanderId: evidence.commander.id,
    completedAt: marker.completedAt,
    conversationIds: marker.conversationId ? [marker.conversationId] : [],
    automations: marker.automations,
    transactionId: options.packageTransaction.id,
  }
}

function hasExpectedInitialAutomationStatuses(
  definition: CommanderPackageDefinition,
  automations: readonly Automation[],
): boolean {
  const expectedStatuses = new Map(definition.automations.map((automation) => [
    `${definition.id}:${automation.id}`,
    automation.status,
  ]))
  return automations.every((automation) => (
    automation.templateId
    && automation.status === expectedStatuses.get(automation.templateId)
  ))
}

async function installCommanderPackageLocked(
  definition: CommanderPackageDefinition,
  options: CommanderPackageInstallOptions,
): Promise<CommanderPackageInstallResult> {
  const sessions = await options.sessionStore.list()
  const candidates = sessions.filter((session) => (
    session.archived !== true && session.templateId === definition.id
  ))
  const candidateEvidence = await Promise.all(candidates.map((candidate) => (
    inspectCandidateEvidence(definition, candidate, options)
  )))
  const completeCandidates = candidateEvidence.filter((candidate) => (
    candidate.marker?.state === 'complete'
  ))
  if (completeCandidates.length > 1) {
    throw packageInstallConflict(definition, 'multiple complete package commanders exist')
  }
  if (completeCandidates.length === 1) {
    const canonical = completeCandidates[0]!
    const extras = candidateEvidence.filter((candidate) => candidate !== canonical)
    if (extras.some((candidate) => candidate.marker?.state !== 'removing')) {
      throw packageInstallConflict(
        definition,
        'a complete package commander exists alongside an ambiguous duplicate',
      )
    }
    for (const extra of extras) {
      const failures = await cleanupCommanderPackageInstallLocked(
        buildRemovingCleanupReceipt(extra, options),
        options,
      )
      if (failures.length > 0) {
        throw new CommanderPackageRollbackError(
          definition.id,
          packageInstallConflict(definition, `removing duplicate ${extra.commander.id} is not safe`),
          failures,
        )
      }
    }
    return repairCommanderPackageInPlace(definition, canonical, options)
  }
  if (candidateEvidence.length > 1) {
    throw packageInstallConflict(definition, 'multiple incomplete package commanders are ambiguous')
  }
  if (candidateEvidence.length === 1) {
    return repairCommanderPackageInPlace(definition, candidateEvidence[0]!, options)
  }

  if (definition.automations.length > 0 && !options.automationStore) {
    throw new Error('Automation store is required to install package preset automations')
  }
  const expectedTemplateIdSet = new Set(expectedAutomationTemplateIds(definition))
  const freshInstallCollisions = options.automationStore
    ? (await options.automationStore.list()).filter((automation) => (
      typeof automation.templateId === 'string'
      && expectedTemplateIdSet.has(automation.templateId)
    ))
    : []
  if (freshInstallCollisions.length > 0) {
    throw packageInstallConflict(
      definition,
      `preset automation ${freshInstallCollisions[0]!.templateId!} exists without a canonical package commander`,
    )
  }
  if (!options.packageTransaction) {
    throw new Error('Commander package install requires an active package transaction')
  }

  const displayNames = await readCommanderDisplayNames(options.commanderDataDir)

  const existingHosts = new Set(sessions.map((session) => session.host))
  const existingDisplayNames = new Set(
    sessions.map((session) => normalizeName(displayNames[session.id]?.trim() || session.host)),
  )
  const host = buildUniqueHost(definition.host, existingHosts)
  const displayName = buildUniqueDisplayName(definition.displayName, existingDisplayNames)
  const runtimeConfig = createDefaultCommanderRuntimeConfig()
  const commanderBasePath = options.commanderBasePath ?? options.commanderDataDir
  const session: CommanderSession = {
    id: randomUUID(),
    host,
    state: 'idle',
    created: options.now().toISOString(),
    agentType: definition.agentType,
    effort: definition.effort,
    heartbeat: createDefaultHeartbeatConfig(),
    maxTurns: runtimeConfig.defaults.maxTurns,
    contextMode: definition.contextMode,
    taskSource: null,
    templateId: definition.id,
  }

  const installId = randomUUID()
  let conversationId: string | null = null
  const seededAutomations: Automation[] = []
  const completedAt = options.now().toISOString()

  const cleanupReceipt = (committedMutationVersion?: number): CommanderPackageCleanupReceipt => ({
    packageId: definition.id,
    packageVersion: definition.version,
    installId,
    commanderId: session.id,
    completedAt,
    conversationIds: conversationId ? [conversationId] : [],
    automations: seededAutomations.flatMap((automation) => (
      automation.templateId
        ? [{ id: automation.id, templateId: automation.templateId }]
        : []
    )),
    transactionId: options.packageTransaction!.id,
    ...(committedMutationVersion === undefined ? {} : { committedMutationVersion }),
  })

  const provisioningLease = await beginCommanderProvisioning(
    session.id,
    options.commanderDataDir,
    async () => Boolean(await options.sessionStore.get(session.id)),
  )
  if (!provisioningLease) {
    throw packageInstallConflict(definition, `commander ${session.id} cannot be provisioned`)
  }

  let deleted = false
  try {
    const created = await provisioningLease.runOwned(async () => {
      const provisioned = await options.sessionStore.create(session)
      await scaffoldCommanderWorkflow(
        provisioned.id,
        { displayName },
        commanderBasePath,
        options.commanderDataDir,
      )
      await mergeIdentityOperatingStyleIntoCommanderWorkflow(provisioned.id, definition.commanderMd, {
        displayName,
        basePath: commanderBasePath,
        lifecycleScope: options.commanderDataDir,
      })
      if (typeof options.conversationStore?.ensureDefaultConversation === 'function') {
        const conversation = await options.conversationStore.ensureDefaultConversation({
          commanderId: provisioned.id,
          surface: 'ui',
          createdAt: provisioned.created,
          currentTask: null,
        }) as Conversation
        conversationId = conversation.id
      }
      await setCommanderDisplayName(options.commanderDataDir, provisioned.id, displayName)
      await writeCommanderUiProfile(provisioned.id, commanderBasePath, ensureCommanderVisualProfile({
        ...definition.uiProfile,
      }), options.commanderDataDir)
      await writeInstalledPackageSnapshot(
        provisioned.id,
        definition,
        commanderBasePath,
        options.commanderDataDir,
        options.now,
      )
      await seedPackageAutomations(definition, provisioned, options, (automation) => {
        seededAutomations.push(automation)
      })
      const invariant = await inspectPackageInvariant(definition, provisioned, options)
      if (!invariant.valid || !invariant.legacy) {
        throw new Error(`Commander package "${definition.id}" did not satisfy its pre-commit invariant`)
      }
      if (!hasExpectedInitialAutomationStatuses(definition, invariant.automations)) {
        throw new Error(`Commander package "${definition.id}" preset automations did not preserve initial status`)
      }
      await writeInstallStateMarker(createCompleteInstallMarker({
        definition,
        commanderId: provisioned.id,
        installId,
        completedAt,
        conversationId,
        automations: invariant.automations,
      }), options)
      return provisioned
    })
    const committedMutationVersion = provisioningLease.complete({ deleted: false })
    return {
      created: true,
      commander: created,
      displayName,
      cleanupReceipt: cleanupReceipt(committedMutationVersion),
    }
  } catch (error) {
    let cleanupFailures: CommanderPackageCleanupFailure[]
    try {
      cleanupFailures = await provisioningLease.runOwned(() => (
        cleanupCommanderPackageInstallLocked(cleanupReceipt(), options, provisioningLease)
      ))
    } catch (cleanupError) {
      cleanupFailures = [{
        packageId: definition.id,
        operation: 'rollback provisioned commander',
        error: cleanupError,
      }]
    }
    deleted = cleanupFailures.length === 0
    provisioningLease.complete({ deleted })
    if (cleanupFailures.length > 0) {
      throw new CommanderPackageRollbackError(definition.id, error, cleanupFailures)
    }
    throw error
  } finally {
    provisioningLease.complete({ deleted })
  }
}
