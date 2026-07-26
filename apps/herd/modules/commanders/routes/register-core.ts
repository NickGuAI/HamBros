import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { GEMINI_IMAGE_GENERATION_PROVIDER_ID } from '../../../server/api-keys/provider-secrets-store.js'
import {
  buildCommanderPortraitPrompt,
  extractCommanderMdExcerpt,
} from '../../../server/image-generation/sumi-portrait-prompt.js'
import { DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE } from '../../claude-adaptive-thinking.js'
import { DEFAULT_CLAUDE_MAX_THINKING_TOKENS } from '../../claude-max-thinking-tokens.js'
import { appendClaudeReasoningPolicy } from '../../agents/adapters/claude/reasoning-policy.js'
import { isProviderLaunchError } from '../../agents/session/machine-launch.js'
import { COMMANDER_STARTUP_USER_EVENT_SUBTYPE } from '../../agents/user-event-subtypes.js'
import { buildCommandRoomLaunchTarget } from '../../command-room/route-metadata.js'
import {
  parseClaudeAdaptiveThinking,
  parseClaudeMaxThinkingTokens,
} from '../../agents/session/input.js'
import {
  mimeTypeForAvatarFile,
  readCommanderUiProfile,
  resolveCommanderAvatarPath,
  sanitizeUiProfile,
  writeCommanderAvatarBytes,
  writeCommanderUiProfile,
  type CommanderUiProfile,
} from '../commander-profile.js'
import { ensureCommanderVisualProfile } from '../commander-visual-profile.js'
import {
  beginCommanderProvisioning,
  captureCommanderChildMutationVersion,
} from '../child-mutation-coordinator.js'
import {
  deleteCommanderStateOwned,
  deleteCommanderStateWithLease,
} from '../commander-deletion.js'
import {
  createDefaultHeartbeatConfig,
  mergeHeartbeatConfig,
  parseHeartbeatPatch,
} from '../heartbeat.js'
import { CommanderManager } from '../manager.js'
import {
  deleteCommanderDisplayName,
  mutateCommanderDisplayName,
} from '../names-lock.js'
import { resolveCommanderNamesPath, resolveCommanderPaths } from '../paths.js'
import {
  parseHost,
  parseMachineId,
  parseMessage,
  parseMessageMode,
  parseOptionalCommanderAgentType,
  parseOptionalCommanderContextMode,
  parseOptionalCommanderCostCapUsd,
  parseOptionalCommanderMaxTurns,
  parseOptionalCurrentTask,
  parseOptionalHeartbeatContextConfig,
  parseSessionId,
  parseTaskSource,
} from '../route-parsers.js'
import {
  DEFAULT_COMMANDER_PORTRAIT_STYLE_ID,
  listCommanderPortraitStyleIds,
  parseCommanderPortraitStyleId,
} from '../portrait-styles.js'
import {
  buildDefaultCommanderConversationId,
  DEFAULT_COMMANDER_CONTEXT_MODE,
  type CommanderContextMode,
  type CommanderSession,
  type CommanderTaskSource,
  type HeartbeatContextConfig,
} from '../store.js'
import {
  COMMANDER_WIZARD_START_MESSAGE,
  buildCommanderWizardSystemPrompt,
} from '../templates/wizard-prompt.js'
import {
  BENCHMARK_COMMANDER_DISPLAY_NAME,
  BENCHMARK_COMMANDER_FAT_PIN_INTERVAL,
  BENCHMARK_COMMANDER_HEARTBEAT_MINUTES,
  BENCHMARK_COMMANDER_MAX_TURNS,
  BENCHMARK_COMMANDER_PERSONA,
  BENCHMARK_COMMANDER_TASK_SOURCE,
  BENCHMARK_COMMANDER_TEMPLATE_ID,
  bootstrapBenchmarkCommanderFiles,
  isBenchmarkCommanderMarker,
  seedBenchmarkCommanderDefaultAutomations,
} from '../templates/benchmark-bootstrap.js'
import {
  mergeIdentityOperatingStyleIntoCommanderWorkflow,
  readCommanderWorkflowMarkdown,
  scaffoldCommanderWorkflow,
  writeCommanderWorkflowMarkdown,
} from '../templates/workflow.js'
import { findCommanderArchetype } from '../templates/archetypes.js'
import {
  STARTUP_PROMPT,
  buildConversationSessionName,
  consumeInternalUserMessage,
  createContextPressureBridge,
  isInputTokenContextPressureEvent,
  isContextPressureSubtypeEvent,
  listSubAgentEntries,
  queueInternalUserMessage,
  resolveCommanderAgentType,
  resolveCommanderTerminalState,
  resolveEffectiveHeartbeat,
  toCommanderSessionResponse,
} from './context.js'
import {
  applyRemoteMemorySnapshot,
  buildCommanderSessionSeedFromResolvedWorkflow,
  exportRemoteMemorySnapshot,
} from '../memory/module.js'
import type { CommanderRoutesContext, CommanderRuntime, StreamEvent } from './types.js'
import { resolveCommanderWorkflow } from '../workflow-resolution.js'
import {
  appendGaiaOpsSkillGuide,
  buildGaiaOpsEnvWithMetadata,
  getLiveConversationSession,
  stopConversationSession,
} from './conversation-runtime.js'
import type { AgentType } from '../../agents/types.js'
import { getProvider, resolveDefaultProviderId } from '../../agents/providers/registry.js'
import {
  findProviderModelOption,
  validateModelForAgentType,
} from '../../agents/providers/validate-model.js'
import { getCachedProviderModelsForValidation } from '../../agents/providers/model-discovery.js'
import {
  getAgentEffortLevels,
  getAgentModelEffortCapability,
  getDefaultAgentEffortForModel,
  parseOptionalAgentEffort,
  type AgentEffortLevel,
} from '../../agents/effort.js'
import { listCommanderPackages, loadCommanderPackage } from '../packages/registry.js'
import { isTranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import {
  getCommanderPackageInstallState,
  installCommanderPackage,
} from '../packages/install.js'
import { enforceCommanderCostCap } from '../cost-control.js'
import type {
  CommanderPackageDefinition,
  CommanderPackageSkill,
  CommanderPackageResponse,
} from '../packages/types.js'
import {
  COMMANDER_TEMPLATE_SCHEMA_VERSION,
  buildImportedCommanderBundleAutomationInput,
  collectCommanderBundleSkills,
  installCommanderBundleSkills,
  parseCommanderBundleAutomations,
  parseCommanderBundleSkillBindings,
  toCommanderBundleAutomation,
  type CommanderBundleAutomation,
  type CommanderTemplateSkillBinding,
} from '../template-bundle.js'

const WIZARD_SESSION_PREFIX = 'commander-wizard-'
const WIZARD_SESSION_NAME_PATTERN = /^commander-wizard-[a-zA-Z0-9_-]+$/
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ARCHIVED_COMMANDER_RUNTIME_ERROR = 'Commander is archived. Restore it first via POST /:id/restore.'
const COMMANDER_MD_IDENTITY_MESSAGE = 'Commander identity lives in COMMANDER.md; edit COMMANDER.md directly.'
const GAIA_HOST = 'gaia'
const GAIA_TEMPLATE_ID = 'gaia-onboarding'

function isProtectedSystemCommander(session: CommanderSession): boolean {
  return session.system === true ||
    session.host === GAIA_HOST ||
    session.templateId === GAIA_TEMPLATE_ID
}

class DuplicateCommanderDisplayNameError extends Error {
  constructor(displayName: string) {
    super(`Commander displayName "${displayName}" already exists`)
    this.name = 'DuplicateCommanderDisplayNameError'
  }
}

function parseIdentityOperatingStyleInput(
  raw: unknown,
): { valid: true; value: string | undefined } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: undefined }
  }
  if (typeof raw !== 'string') {
    return { valid: false }
  }
  const trimmed = raw.trim()
  return { valid: true, value: trimmed.length > 0 ? trimmed : undefined }
}

interface CommanderTemplatePackage {
  schemaVersion: 1 | 2
  exportedAt: string
  sourceCommanderId?: string
  commander: {
    id?: string
    host?: string
    executionMachineId?: string
    displayName: string
    agentType?: AgentType
    model?: string | null
    effort?: AgentEffortLevel
    maxTurns?: number
    contextMode?: CommanderContextMode
    contextConfig?: HeartbeatContextConfig
    cwd?: string
    taskSource?: CommanderTaskSource | null
    profile?: CommanderUiProfile | null
  }
  commanderMd: string | null
  memorySnapshot: {
    memoryMd: string
    syncRevision: number
  }
  skillBindings: Array<{
    skillId: string
    version?: string
  }> | CommanderTemplateSkillBinding[]
  skills?: CommanderPackageSkill[]
  automations?: CommanderBundleAutomation[]
}

function parseConversationId(raw: unknown): string | null {
  return typeof raw === 'string' && CONVERSATION_ID_PATTERN.test(raw.trim())
    ? raw.trim()
    : null
}

type CommanderModelEffortResolution =
  | {
      ok: true
      effort: AgentEffortLevel | undefined
      omitEffort: boolean
    }
  | {
      ok: false
      error: string
    }

function resolveCommanderModelEffort(
  agentType: AgentType,
  model: string | null | undefined,
  rawEffort: unknown,
  effortProvided: boolean,
): CommanderModelEffortResolution {
  const provider = getProvider(agentType)
  const resolvedModels = provider
    ? getCachedProviderModelsForValidation(provider).models
    : []
  const modelOption = findProviderModelOption(resolvedModels, model)
  const capability = getAgentModelEffortCapability(agentType, modelOption)
  const parsedEffort = parseOptionalAgentEffort(agentType, rawEffort)

  if (effortProvided && (parsedEffort === null || rawEffort === null || rawEffort === '')) {
    return {
      ok: false,
      error: `Invalid effort for provider "${agentType}". Expected one of: ${getAgentEffortLevels(agentType).join(', ')}`,
    }
  }
  if (effortProvided && rawEffort != null && !capability.supportsEffort) {
    return {
      ok: false,
      error: `Model "${modelOption?.label ?? model ?? agentType}" does not support effort`,
    }
  }
  if (
    effortProvided
    && parsedEffort
    && !capability.supportedEffortLevels.includes(parsedEffort)
  ) {
    return {
      ok: false,
      error: `Invalid effort for model "${modelOption?.label ?? model ?? agentType}". Expected one of: ${capability.supportedEffortLevels.join(', ')}`,
    }
  }

  const storedEffort = parsedEffort && capability.supportedEffortLevels.includes(parsedEffort)
    ? parsedEffort
    : getDefaultAgentEffortForModel(agentType, modelOption)
  return {
    ok: true,
    effort: capability.supportsEffort ? storedEffort : undefined,
    omitEffort: !capability.supportsEffort,
  }
}

function normalizeUserMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    const normalized = content.trim()
    return normalized.length > 0 ? normalized : null
  }

  if (!Array.isArray(content)) {
    return null
  }

  const textBlocks = content
    .flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return []
      }

      const record = entry as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text.trim()]
        : []
    })
    .filter((entry) => entry.length > 0)

  if (textBlocks.length === 0) {
    return null
  }

  return textBlocks.join('\n\n')
}

function extractRawUserMessage(event: StreamEvent): string | null {
  if (event.type !== 'user') {
    return null
  }

  const message = (event as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) {
    return null
  }

  if ((message as { role?: unknown }).role !== 'user') {
    return null
  }

  return normalizeUserMessageText((message as { content?: unknown }).content)
}

function buildReplicatedHost(
  sourceHost: string,
  existingHosts: ReadonlySet<string>,
): string {
  const base = `${sourceHost}-copy`
  if (!existingHosts.has(base)) {
    return base
  }

  let suffix = 2
  let candidate = `${base}-${suffix}`
  while (existingHosts.has(candidate)) {
    suffix += 1
    candidate = `${base}-${suffix}`
  }

  return candidate
}

function buildUniqueHost(baseHost: string, existingHosts: ReadonlySet<string>): string {
  if (!existingHosts.has(baseHost)) {
    return baseHost
  }

  let suffix = 2
  let candidate = `${baseHost}-copy`
  while (existingHosts.has(candidate)) {
    candidate = `${baseHost}-copy-${suffix}`
    suffix += 1
  }

  return candidate
}

function buildHostFromDisplayName(displayName: string): string {
  const normalized = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `commander-${randomUUID().slice(0, 8)}`
}

function buildUniqueDisplayName(
  displayName: string,
  existingDisplayNames: ReadonlySet<string>,
): string {
  const normalized = normalizeCommanderDisplayName(displayName)
  if (!existingDisplayNames.has(normalized)) {
    return displayName
  }

  let suffix = 2
  let candidate = `${displayName} Copy`
  while (existingDisplayNames.has(normalizeCommanderDisplayName(candidate))) {
    candidate = `${displayName} Copy ${suffix}`
    suffix += 1
  }

  return candidate
}

function normalizeCommanderDisplayName(displayName: string): string {
  return displayName.trim().toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function rejectArchivedCommanderRuntime(
  session: CommanderSession,
  res: import('express').Response,
): boolean {
  if (session.archived !== true) {
    return false
  }

  res.status(409).json({ error: ARCHIVED_COMMANDER_RUNTIME_ERROR })
  return true
}

function parseNonNegativeInteger(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : null
}

function parseOptionalModelSelection(
  raw: unknown,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, value: undefined }
  }
  if (raw === null) {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') {
    return { ok: false }
  }

  const trimmed = raw.trim()
  return {
    ok: true,
    value: trimmed.length > 0 ? trimmed : null,
  }
}

async function readCommanderDisplayNames(dataDir: string): Promise<Record<string, string>> {
  try {
    const namesPath = resolveCommanderNamesPath(dataDir)
    return JSON.parse(await readFile(namesPath, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

async function upsertCommanderDisplayName(
  dataDir: string,
  commanderId: string,
  displayName: string,
): Promise<void> {
  const normalizedDisplayName = normalizeCommanderDisplayName(displayName)
  await mutateCommanderDisplayName(dataDir, commanderId, (names) => {
    const duplicateEntry = Object.entries(names).find(([existingCommanderId, existingDisplayName]) => (
      existingCommanderId !== commanderId
      && normalizeCommanderDisplayName(existingDisplayName) === normalizedDisplayName
    ))
    if (duplicateEntry) {
      throw new DuplicateCommanderDisplayNameError(displayName)
    }
    names[commanderId] = displayName
  })
}

function sanitizeAvatarGenerationError(error: unknown): string {
  const fallback = 'Gemini avatar generation failed'
  if (!(error instanceof Error)) {
    return fallback
  }

  const sanitized = error.message
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[redacted-api-key]')
    .replace(/\s+/g, ' ')
    .trim()

  return sanitized || fallback
}

export function registerCoreRoutes(
  router: import('express').Router,
  context: CommanderRoutesContext,
): void {
  /**
   * Manually fire the heartbeat loop for one conversation. When `conversationId`
   * is omitted from the request body, the most recently active conversation for
   * the commander is targeted.
   */
  const triggerHeartbeatRoute = async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }
    if (rejectArchivedCommanderRuntime(session, res)) {
      return
    }

    if (session.state !== 'running') {
      res.status(409).json({
        error: `Commander "${commanderId}" is not running (state: ${session.state})`,
      })
      return
    }

    const parsedConversationId = req.body?.conversationId === undefined
      ? undefined
      : parseConversationId(req.body?.conversationId)
    if (req.body?.conversationId !== undefined && !parsedConversationId) {
      res.status(400).json({ error: 'conversationId must be a UUID when provided' })
      return
    }
    const requestedConversationId = parsedConversationId ?? undefined

    const conversation = await context.resolveHeartbeatConversation(
      commanderId,
      requestedConversationId,
    )
    if (!conversation) {
      res.status(404).json({
        error: requestedConversationId
          ? `Conversation "${requestedConversationId}" not found for commander "${commanderId}"`
          : `Commander "${commanderId}" has no conversation available for heartbeat`,
      })
      return
    }

    const sessionName = buildConversationSessionName(conversation)
    if (!context.heartbeatManager.isRunning(conversation.id)) {
      const liveSession = context.sessionsInterface?.getSession(sessionName)
      if (liveSession) {
        context.heartbeatManager.start(
          conversation.id,
          commanderId,
          resolveEffectiveHeartbeat(session),
        )
        // fall through to fire manual heartbeat below
      } else {
        res.status(409).json({
          error: `Conversation "${conversation.id}" has no live session to restart heartbeat against`,
        })
        return
      }
    }

    if (context.heartbeatManager.isInFlight(conversation.id)) {
      res.status(409).json({
        error: `Conversation "${conversation.id}" heartbeat is already in flight`,
      })
      return
    }

    const timestamp = context.now().toISOString()
    const triggered = context.heartbeatManager.fireManual(conversation.id, timestamp)
    if (!triggered) {
      res.status(409).json({
        error: `Conversation "${conversation.id}" heartbeat could not be triggered`,
      })
      return
    }

    res.json({
      runId: timestamp,
      timestamp,
      sessionName,
      conversationId: conversation.id,
      triggered: true,
    })
  }

  const resolveWizardApiBaseUrl = (req: import('express').Request): string => {
    const localPort = req.socket.localPort
    if (typeof localPort === 'number' && Number.isFinite(localPort) && localPort > 0) {
      return `http://127.0.0.1:${localPort}`
    }

    const host = req.get('host')?.split(',')[0]?.trim()
    if (host) {
      return `http://${host.replace(/\/+$/, '')}`
    }
    return 'http://127.0.0.1:3000'
  }

  const resolveWizardAuthHeaders = (
    req: import('express').Request,
  ): {
    authorizationHeader?: string
    apiKeyHeaderName?: 'x-herd-api-key' | 'x-api-key'
    apiKeyHeaderValue?: string
  } => {
    const authorizationHeader = parseMessage(req.get('authorization')) ?? undefined
    const herdApiKey = parseMessage(req.get('x-herd-api-key'))
    if (herdApiKey) {
      return {
        authorizationHeader,
        apiKeyHeaderName: 'x-herd-api-key',
        apiKeyHeaderValue: herdApiKey,
      }
    }

    const apiKey = parseMessage(req.get('x-api-key'))
    if (apiKey) {
      return {
        authorizationHeader,
        apiKeyHeaderName: 'x-api-key',
        apiKeyHeaderValue: apiKey,
      }
    }

    return { authorizationHeader }
  }

  const assertUniqueCommanderDisplayName = async (
    displayName: string,
    excludeCommanderId?: string,
  ): Promise<void> => {
    const normalizedDisplayName = normalizeCommanderDisplayName(displayName)
    const sessions = await context.sessionStore.list()
    const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
    const duplicateSession = sessions.find((session) => {
      if (session.id === excludeCommanderId) {
        return false
      }

      const resolvedDisplayName = displayNames[session.id]?.trim() || session.host
      return normalizeCommanderDisplayName(resolvedDisplayName) === normalizedDisplayName
    })

    if (duplicateSession) {
      throw new DuplicateCommanderDisplayNameError(displayName)
    }
  }

  const rollbackProvisionedCommanderOwned = async (commanderId: string) => {
    const [conversations, automations] = await Promise.all([
      context.conversationStore.listByCommander(commanderId),
      context.automationStore.list({ parentCommanderId: commanderId }),
    ])
    return deleteCommanderStateOwned({
      commanderId,
      commanderDataDir: context.commanderDataDir,
      commanderBasePath: context.commanderBasePath,
      sessionStore: context.sessionStore,
      channelBindingStore: context.channelBindingStore,
      questStore: context.questStore,
      heartbeatLog: context.heartbeatLog,
      allowMissingSession: true,
      deleteChildren: async () => {
        for (const { id } of [...automations].reverse()) {
          if (context.automationScheduler) {
            await context.automationScheduler.deleteAutomation(id)
          } else {
            await context.automationStore.delete(id, { removeFiles: true })
          }
        }
        for (const { id } of conversations) {
          await context.conversationStore.delete(id)
        }
      },
    })
  }

  const withProvisionedCommander = async <T>(
    commanderId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const lease = await beginCommanderProvisioning(
      commanderId,
      context.commanderDataDir,
      async () => Boolean(await context.sessionStore.get(commanderId)),
    )
    if (!lease) {
      throw new Error(`Commander "${commanderId}" cannot be provisioned in its current lifecycle state`)
    }

    let deleted = false
    try {
      const result = await lease.runOwned(operation)
      lease.complete({ deleted: false })
      return result
    } catch (error) {
      let rollback: Awaited<ReturnType<typeof rollbackProvisionedCommanderOwned>>
      try {
        rollback = await lease.runOwned(
          () => rollbackProvisionedCommanderOwned(commanderId),
        )
      } catch (rollbackError) {
        rollback = { deleted: false, error: rollbackError }
      }
      deleted = rollback.deleted
      lease.complete({ deleted })
      if (!rollback.deleted) {
        console.warn(
          `[commanders] Failed to fully roll back provisioned commander "${commanderId}":`,
          rollback.error,
        )
      }
      throw error
    } finally {
      lease.complete({ deleted })
    }
  }

  const persistCreatedCommanderOwned = async (
    session: CommanderSession,
    displayName: string,
    options: {
      heartbeat?: CommanderSession['heartbeat']
      uiProfile?: CommanderUiProfile | null
      identityOperatingStyle?: string
      bootstrapBenchmark?: boolean
    } = {},
  ) => {
    const heartbeat = options.heartbeat ?? session.heartbeat
    const created = await context.sessionStore.create({
      ...session,
      heartbeat,
    })
    await context.ensureDefaultConversation(created, {
      surface: 'ui',
      currentTask: null,
    })

    if (options.bootstrapBenchmark) {
      if (!created.cwd || !path.isAbsolute(created.cwd)) {
        throw new Error('Benchmark commander cwd must be an absolute adapter root')
      }
      await bootstrapBenchmarkCommanderFiles(
        created.id,
        created.cwd,
        context.commanderBasePath,
        context.commanderDataDir,
      )
      await seedBenchmarkCommanderDefaultAutomations({
        commanderId: created.id,
        executionMachineId: created.executionMachineId!,
        cwd: created.cwd,
        model: created.model,
        automationStore: context.automationStore,
        automationScheduler: context.automationScheduler,
        automationSchedulerInitialized: context.automationSchedulerInitialized,
      })
    } else {
      await scaffoldCommanderWorkflow(
        created.id,
        {
          cwd: created.cwd,
          displayName,
        },
        context.commanderBasePath,
        context.commanderDataDir,
      )
    }
    if (options.identityOperatingStyle) {
      await mergeIdentityOperatingStyleIntoCommanderWorkflow(
        created.id,
        options.identityOperatingStyle,
        {
          cwd: created.cwd,
          displayName,
          basePath: context.commanderBasePath,
          lifecycleScope: context.commanderDataDir,
        },
      )
    }

    await upsertCommanderDisplayName(context.commanderDataDir, created.id, displayName)
    await writeCommanderUiProfile(
      created.id,
      context.commanderBasePath,
      ensureCommanderVisualProfile(options.uiProfile),
      context.commanderDataDir,
    )

    const stats = await context.getCommanderSessionStats(created.id)
    const base = await toCommanderSessionResponse(created, context.conversationStore, undefined, stats, {
      commanderDataDir: context.commanderDataDir,
      now: context.now,
      sessionsInterface: context.sessionsInterface,
    })
    return await context.attachCommanderPublicUi(created.id, base)
  }

  const parseWizardSessionName = (raw: unknown): string | null => {
    if (typeof raw !== 'string') {
      return null
    }
    const trimmed = raw.trim()
    return WIZARD_SESSION_NAME_PATTERN.test(trimmed) ? trimmed : null
  }

  const buildCommanderPackageResponse = async (
    definition: CommanderPackageDefinition,
  ): Promise<CommanderPackageResponse> => {
    const {
      commanderMd: _commanderMd,
      memorySeed: _memorySeed,
      ...publicDefinition
    } = definition

    return {
      ...publicDefinition,
      installState: await getCommanderPackageInstallState(definition, {
        sessionStore: context.sessionStore,
        conversationStore: context.conversationStore,
        automationStore: context.automationStore,
        commanderDataDir: context.commanderDataDir,
        commanderBasePath: context.commanderBasePath,
      }),
    }
  }

  const buildCommanderApiResponse = async (
    session: CommanderSession,
    displayName: string,
  ): Promise<unknown> => {
    const stats = await context.getCommanderSessionStats(session.id)
    const base = await toCommanderSessionResponse(session, context.conversationStore, undefined, stats, {
      commanderDataDir: context.commanderDataDir,
      now: context.now,
      sessionsInterface: context.sessionsInterface,
    })
    const withUi = await context.attachCommanderPublicUi(session.id, base)
    return displayName !== session.host
      ? { ...withUi, displayName }
      : withUi
  }

  router.get('/', context.requireReadAccess, async (_req, res) => {
    const sessions = await context.sessionStore.list()
    const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
    const response = await Promise.all(
      sessions.map(async (session) => {
        const stats = await context.getCommanderSessionStats(session.id)
        const base = await toCommanderSessionResponse(session, context.conversationStore, undefined, stats, {
          commanderDataDir: context.commanderDataDir,
          now: context.now,
          sessionsInterface: context.sessionsInterface,
        })
        const withUi = await context.attachCommanderPublicUi(session.id, base)
        const displayName = displayNames[session.id]
        return displayName && displayName !== session.host
          ? { ...withUi, displayName }
          : withUi
      }),
    )
    res.json(response)
  })

  router.get('/runtime-config', context.requireReadAccess, async (_req, res) => {
    res.json(context.runtimeConfig)
  })

  router.get('/packages', context.requireReadAccess, async (_req, res) => {
    const definitions = await listCommanderPackages()
    res.json({
      packages: await Promise.all(definitions.map(buildCommanderPackageResponse)),
    })
  })

  router.get('/packages/:packageId', context.requireReadAccess, async (req, res) => {
    const packageId = typeof req.params.packageId === 'string' ? req.params.packageId : null
    if (!packageId) {
      res.status(400).json({ error: 'Invalid commander package id' })
      return
    }
    const definition = await loadCommanderPackage(packageId)
    if (!definition) {
      res.status(404).json({ error: `Commander package "${packageId}" not found` })
      return
    }

    res.json({
      package: await buildCommanderPackageResponse(definition),
    })
  })

  router.post('/packages/:packageId/install', context.requireWriteAccess, async (req, res) => {
    const packageId = typeof req.params.packageId === 'string' ? req.params.packageId : null
    if (!packageId) {
      res.status(400).json({ error: 'Invalid commander package id' })
      return
    }
    const definition = await loadCommanderPackage(packageId)
    if (!definition) {
      res.status(404).json({ error: `Commander package "${packageId}" not found` })
      return
    }

    try {
      const result = await installCommanderPackage(definition, {
        sessionStore: context.sessionStore,
        conversationStore: context.conversationStore,
        automationStore: context.automationStore,
        automationScheduler: context.automationScheduler,
        automationSchedulerInitialized: context.automationSchedulerInitialized,
        commanderDataDir: context.commanderDataDir,
        commanderBasePath: context.commanderBasePath,
        now: context.now,
      })
      const packageResponse = await buildCommanderPackageResponse(definition)
      const commander = await buildCommanderApiResponse(result.commander, result.displayName)
      res.status(result.created ? 201 : 200).json({
        package: packageResponse,
        commander,
        created: result.created,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install commander package',
      })
    }
  })

  // No auth on avatar — <img src> cannot send bearer headers, and the URL
  // is already keyed on a non-guessable UUID.
  router.get('/:id/avatar', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const profile = await readCommanderUiProfile(commanderId, context.commanderBasePath)
    const avatarPath = await resolveCommanderAvatarPath(commanderId, context.commanderBasePath, profile)
    if (!avatarPath) {
      res.status(404).json({ error: 'Avatar not configured' })
      return
    }

    try {
      const buf = await readFile(avatarPath)
      res.setHeader('Content-Type', mimeTypeForAvatarFile(avatarPath))
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.send(buf)
    } catch {
      res.status(404).json({ error: 'Avatar file missing' })
    }
  })

  router.post('/:id/avatar', context.requireWriteAccess, context.avatarUpload.single('avatar'), async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No avatar file uploaded' })
      return
    }

    await writeCommanderAvatarBytes(
      commanderId,
      context.commanderBasePath,
      file.buffer,
      file.mimetype,
      {},
      context.commanderDataDir,
    )

    res.json({ avatarUrl: `/api/commanders/${encodeURIComponent(commanderId)}/avatar` })
  })

  router.post('/:id/avatar/generate', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const portraitStyleId = req.body?.styleId === undefined
      ? DEFAULT_COMMANDER_PORTRAIT_STYLE_ID
      : parseCommanderPortraitStyleId(req.body?.styleId)
    if (!portraitStyleId) {
      res.status(400).json({
        error: `styleId must be one of: ${listCommanderPortraitStyleIds()}`,
      })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const apiKey = await context.providerSecretsStore.getSecret(
      GEMINI_IMAGE_GENERATION_PROVIDER_ID,
    )
    if (!apiKey) {
      res.status(412).json({
        error: 'Configure Gemini API key in Settings → Image Generation',
      })
      return
    }

    const commanderMd = await readCommanderWorkflowMarkdown(
      commanderId,
      context.commanderBasePath,
    )
    if (!commanderMd || commanderMd.trim().length === 0) {
      res.status(412).json({
        error: 'Commander has no COMMANDER.md — initialize first',
      })
      return
    }

    const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
    const displayName = displayNames[commanderId]?.trim() || session.host
    const commanderMdExcerpt = extractCommanderMdExcerpt(commanderMd)
    const prompt = buildCommanderPortraitPrompt({
      displayName,
      commanderMdExcerpt,
      styleId: portraitStyleId,
    })

    let avatarBytes: Buffer
    try {
      avatarBytes = await context.generateGeminiImage({
        apiKey,
        prompt,
        aspectRatio: '1:1',
      })
    } catch (error) {
      res.status(502).json({
        error: sanitizeAvatarGenerationError(error),
      })
      return
    }

    try {
      await writeCommanderAvatarBytes(
        commanderId,
        context.commanderBasePath,
        avatarBytes,
        'image/png',
        { portraitStyleId },
        context.commanderDataDir,
      )
    } catch {
      res.status(500).json({ error: 'Failed to write generated avatar' })
      return
    }

    res.json({ avatarUrl: `/api/commanders/${encodeURIComponent(commanderId)}/avatar` })
  })

  router.patch('/:id/profile', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const parseField = (value: unknown): string | undefined =>
      typeof value === 'string' ? value.trim() || undefined : undefined

    if (req.body?.persona !== undefined || req.body?.identityOperatingStyle !== undefined) {
      res.status(400).json({ error: COMMANDER_MD_IDENTITY_MESSAGE })
      return
    }

    const speakingTone = parseField(req.body?.speakingTone)
    const effortProvided = req.body?.effort !== undefined
    const effortResolution = resolveCommanderModelEffort(
      session.agentType ?? resolveDefaultProviderId(),
      session.model,
      req.body?.effort,
      effortProvided,
    )
    const portraitStyleProvided = req.body?.portraitStyleId !== undefined
    const portraitStyleId = portraitStyleProvided
      ? parseCommanderPortraitStyleId(req.body?.portraitStyleId)
      : undefined

    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }
    if (portraitStyleProvided && !portraitStyleId) {
      res.status(400).json({ error: `portraitStyleId must be one of: ${listCommanderPortraitStyleIds()}` })
      return
    }

    const existing = await readCommanderUiProfile(commanderId, context.commanderBasePath)
    const merged: CommanderUiProfile = ensureCommanderVisualProfile({
      ...(existing ?? {}),
      ...(req.body?.speakingTone !== undefined ? { speakingTone } : {}),
      ...(portraitStyleProvided && portraitStyleId ? { portraitStyleId } : {}),
    })
    await writeCommanderUiProfile(
      commanderId,
      context.commanderBasePath,
      merged,
      context.commanderDataDir,
    )

    if (effortProvided) {
      await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        effort: effortResolution.effort,
      }))
    }

    res.json({ ok: true })
  })

  router.get('/:id', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const runtime = context.runtimes.get(commanderId)
    const commanderMd = await readCommanderWorkflowMarkdown(commanderId, context.commanderBasePath)
    const { commanderRoot, memoryRoot } = resolveCommanderPaths(commanderId, context.commanderBasePath)
    const stats = await context.getCommanderSessionStats(commanderId)
    const base = await toCommanderSessionResponse(session, context.conversationStore, runtime, stats, {
      commanderDataDir: context.commanderDataDir,
      now: context.now,
      sessionsInterface: context.sessionsInterface,
    })
    const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
    res.json({
      ...(await context.attachCommanderPublicUi(commanderId, base)),
      displayName: displayNames[commanderId]?.trim() || session.host,
      subAgents: listSubAgentEntries(runtime),
      commanderMd,
      workflowMd: commanderMd,
      commanderRoot,
      memoryRoot,
      runtimeConfig: context.runtimeConfig,
    })
  })

  router.get('/:id/heartbeat-log', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const entries = (await context.heartbeatLog.read(commanderId, 50))
      .slice()
      .sort((left, right) => right.firedAt.localeCompare(left.firedAt))
    res.json({ entries })
  })

  router.post('/wizard/start', context.requireWriteAccess, async (req, res) => {
    if (!context.sessionsInterface) {
      res.status(503).json({ error: 'sessionsInterface not configured — agents router bridge missing' })
      return
    }

    const parsedAgentType = parseOptionalCommanderAgentType(req.body?.agentType)
    if (parsedAgentType === null) {
      res.status(400).json({ error: 'agentType must be a registered provider id' })
      return
    }

    const selectedAgentType = parsedAgentType ?? resolveDefaultProviderId()
    const effortResolution = resolveCommanderModelEffort(
      selectedAgentType,
      null,
      req.body?.effort,
      req.body?.effort !== undefined,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }
    const sessionName = `${WIZARD_SESSION_PREFIX}${randomUUID().split('-').join('')}`
    const cwd = parseMessage(req.body?.cwd) ?? undefined
    const machineId = req.body?.machineId === undefined || req.body?.machineId === null
      ? undefined
      : parseMachineId(req.body.machineId) ?? undefined
    if (req.body?.machineId !== undefined && req.body?.machineId !== null && !machineId) {
      res.status(400).json({ error: 'machineId must be a valid machine ID when provided' })
      return
    }
    const wizardAuthHeaders = resolveWizardAuthHeaders(req)
    const systemPrompt = buildCommanderWizardSystemPrompt({
      apiBaseUrl: resolveWizardApiBaseUrl(req),
      ...wizardAuthHeaders,
    })

    try {
      await context.sessionsInterface.createCommanderSession({
        name: sessionName,
        systemPrompt,
        agentType: selectedAgentType,
        effort: effortResolution.effort,
        omitEffort: effortResolution.omitEffort,
        cwd,
        machineId,
        maxTurns: context.runtimeConfig.defaults.maxTurns,
      })
      const sent = await context.sessionsInterface.sendToSession(
        sessionName,
        COMMANDER_WIZARD_START_MESSAGE,
        { intent: 'interrupt' },
      )
      if (!sent.ok) {
        context.sessionsInterface.deleteSession(sessionName)
        res.status(503).json({
          error: 'Wizard startup message could not be delivered. Please retry.',
        })
        return
      }

      res.status(201).json({
        sessionName,
        agentType: selectedAgentType,
        created: true,
      })
    } catch (error) {
      context.sessionsInterface.deleteSession(sessionName)
      const status = isProviderLaunchError(error)
        ? error.statusCode
        : 500
      res.status(status).json({
        ...(isProviderLaunchError(error) && error.code
          ? { code: error.code }
          : {}),
        error: error instanceof Error ? error.message : 'Failed to start commander wizard',
      })
    }
  })

  router.post('/', context.requireWriteAccess, async (req, res) => {
    const host = parseHost(req.body?.host)
    if (!host) {
      res.status(400).json({ error: 'Invalid host' })
      return
    }
    const executionMachineId = req.body?.executionMachineId === undefined
      || req.body?.executionMachineId === null
      ? undefined
      : parseMachineId(req.body.executionMachineId)
    if (
      req.body?.executionMachineId !== undefined
      && req.body?.executionMachineId !== null
      && !executionMachineId
    ) {
      res.status(400).json({ error: 'executionMachineId must be a valid machine ID when provided' })
      return
    }

    const isBenchmarkCreate = isBenchmarkCommanderMarker(req.body?.templateId)
      || isBenchmarkCommanderMarker(req.body?.archetypeId)
    const benchmarkArchetype = findCommanderArchetype(BENCHMARK_COMMANDER_TEMPLATE_ID)
    const benchmarkTaskSource = benchmarkArchetype?.suggestedTaskSource
      ? { ...benchmarkArchetype.suggestedTaskSource }
      : { ...BENCHMARK_COMMANDER_TASK_SOURCE }

    const rawTaskSource = req.body?.taskSource ?? (isBenchmarkCreate ? benchmarkTaskSource : undefined)
    const taskSource = rawTaskSource != null
      ? parseTaskSource(rawTaskSource)
      : null
    if (rawTaskSource != null && !taskSource) {
      res.status(400).json({ error: 'Invalid taskSource' })
      return
    }

    const rawContextConfig = req.body?.contextConfig ?? (
      isBenchmarkCreate
        ? (benchmarkArchetype?.defaultContextConfig ?? { fatPinInterval: BENCHMARK_COMMANDER_FAT_PIN_INTERVAL })
        : undefined
    )
    const parsedContextConfig = parseOptionalHeartbeatContextConfig(rawContextConfig)
    if (!parsedContextConfig.valid) {
      res.status(400).json({ error: 'Invalid contextConfig' })
      return
    }

    const parsedMaxTurns = parseOptionalCommanderMaxTurns(
      req.body?.maxTurns ?? (isBenchmarkCreate
        ? (benchmarkArchetype?.defaultMaxTurns ?? BENCHMARK_COMMANDER_MAX_TURNS)
        : undefined),
      { max: context.runtimeConfig.limits.maxTurns },
    )
    if (!parsedMaxTurns.valid) {
      res.status(400).json({
        error: `maxTurns must be an integer between 1 and ${context.runtimeConfig.limits.maxTurns}`,
      })
      return
    }

    const parsedContextMode = parseOptionalCommanderContextMode(
      req.body?.contextMode ?? (isBenchmarkCreate ? benchmarkArchetype?.defaultContextMode : undefined),
    )
    if (!parsedContextMode.valid) {
      res.status(400).json({ error: 'contextMode must be either "thin" or "fat"' })
      return
    }

    const existing = await context.sessionStore.list()
    if (existing.some((session) => session.host === host)) {
      res.status(409).json({ error: `Commander for host "${host}" already exists` })
      return
    }

    const displayName = parseMessage(req.body?.displayName)
      ?? (isBenchmarkCreate
        ? (benchmarkArchetype?.defaultDisplayName ?? BENCHMARK_COMMANDER_DISPLAY_NAME)
        : host)
    try {
      await assertUniqueCommanderDisplayName(displayName)
    } catch (error) {
      if (error instanceof DuplicateCommanderDisplayNameError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }
    const cwd = parseMessage(req.body?.cwd) ?? undefined
    if (isBenchmarkCreate && (!cwd || !path.isAbsolute(cwd))) {
      res.status(400).json({ error: 'Benchmark commander cwd must be an absolute adapter root' })
      return
    }
    const avatarSeed = parseMessage(req.body?.avatarSeed) ?? undefined
    const templateId = req.body?.templateId === null
      ? null
      : (parseMessage(req.body?.templateId) ?? (isBenchmarkCreate ? BENCHMARK_COMMANDER_TEMPLATE_ID : undefined))
    const replicatedFromCommanderId = req.body?.replicatedFromCommanderId === null
      ? null
      : (parseSessionId(req.body?.replicatedFromCommanderId) ?? undefined)
    if (
      req.body?.replicatedFromCommanderId !== undefined
      && req.body?.replicatedFromCommanderId !== null
      && !replicatedFromCommanderId
    ) {
      res.status(400).json({ error: 'replicatedFromCommanderId must be a valid commander id when provided' })
      return
    }
    if (req.body?.persona !== undefined) {
      res.status(400).json({ error: COMMANDER_MD_IDENTITY_MESSAGE })
      return
    }
    const parsedIdentityOperatingStyle = parseIdentityOperatingStyleInput(req.body?.identityOperatingStyle)
    if (!parsedIdentityOperatingStyle.valid) {
      res.status(400).json({ error: 'identityOperatingStyle must be a string when provided' })
      return
    }
    const identityOperatingStyle = parsedIdentityOperatingStyle.value
      ?? (isBenchmarkCreate
        ? (benchmarkArchetype?.defaultIdentityOperatingStyle ?? BENCHMARK_COMMANDER_PERSONA)
        : undefined)
    const defaultHeartbeat = {
      ...createDefaultHeartbeatConfig(),
      ...(isBenchmarkCreate
        ? {
            intervalMs: (benchmarkArchetype?.defaultHeartbeatMinutes ?? BENCHMARK_COMMANDER_HEARTBEAT_MINUTES) * 60_000,
            intervalOverridden: true,
          }
        : {}),
    }
    let heartbeat = defaultHeartbeat

    if (req.body?.heartbeat !== undefined) {
      const parsedHeartbeat = parseHeartbeatPatch(req.body.heartbeat)
      if (!parsedHeartbeat.ok) {
        res.status(400).json({ error: parsedHeartbeat.error })
        return
      }
      heartbeat = mergeHeartbeatConfig(defaultHeartbeat, parsedHeartbeat.value)
    }

    const parsedAgentTypeCreate = parseOptionalCommanderAgentType(
      req.body?.agentType ?? (isBenchmarkCreate ? benchmarkArchetype?.defaultAgentType : undefined),
    )
    if (parsedAgentTypeCreate === null) {
      res.status(400).json({ error: 'agentType must be a registered provider id' })
      return
    }
    const parsedModelCreate = parseOptionalModelSelection(req.body?.model)
    if (!parsedModelCreate.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }
    const selectedAgentType = parsedAgentTypeCreate ?? resolveDefaultProviderId()
    const modelValidation = validateModelForAgentType(selectedAgentType, parsedModelCreate.value ?? null)
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const effortResolution = resolveCommanderModelEffort(
      selectedAgentType,
      parsedModelCreate.value,
      req.body?.effort,
      req.body?.effort !== undefined,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      ...(executionMachineId ? { executionMachineId } : {}),
      avatarSeed,
      state: 'idle',
      created: context.now().toISOString(),
      agentType: selectedAgentType,
      ...(parsedModelCreate.value !== undefined ? { model: parsedModelCreate.value } : {}),
      ...(effortResolution.effort ? { effort: effortResolution.effort } : {}),
      maxTurns: parsedMaxTurns.value ?? context.runtimeConfig.defaults.maxTurns,
      contextMode: parsedContextMode.value ?? DEFAULT_COMMANDER_CONTEXT_MODE,
      contextConfig: parsedContextConfig.value,
      heartbeat,
      taskSource,
      cwd,
      ...(templateId !== undefined ? { templateId } : {}),
      ...(replicatedFromCommanderId !== undefined ? { replicatedFromCommanderId } : {}),
    }

    if (isBenchmarkCreate) {
      if (!context.evalAdapterPreflight) {
        res.status(503).json({ error: 'Eval adapter preflight is not configured' })
        return
      }
      if (!executionMachineId) {
        res.status(400).json({
          error: 'Benchmark commanders require an explicit executionMachineId for adapter preflight',
        })
        return
      }
      const preflight = await context.evalAdapterPreflight.check({
        machineId: executionMachineId,
        adapterRoot: cwd!,
      })
      if (!preflight.ok) {
        res.status(preflight.status).json({ error: preflight.error })
        return
      }
    }

    try {
      const created = await withProvisionedCommander(
        session.id,
        () => persistCreatedCommanderOwned(session, displayName, {
          heartbeat,
          identityOperatingStyle,
          bootstrapBenchmark: isBenchmarkCreate,
        }),
      )
      res.status(201).json(
        displayName !== created.host
          ? { ...created, displayName }
          : created,
      )
    } catch (error) {
      if (error instanceof DuplicateCommanderDisplayNameError) {
        res.status(409).json({ error: error.message })
        return
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create commander session',
      })
    }
  })

  router.get('/:id/export', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
      const displayName = displayNames[commanderId]?.trim() || session.host
      const [commanderMd, memorySnapshot, automations] = await Promise.all([
        readCommanderWorkflowMarkdown(commanderId, context.commanderBasePath),
        exportRemoteMemorySnapshot(commanderId, context.commanderBasePath),
        context.automationStore.list({ parentCommanderId: commanderId }),
      ])
      const profile = await readCommanderUiProfile(commanderId, context.commanderBasePath)
      const bundledSkills = await collectCommanderBundleSkills({
        commanderId,
        commanderBasePath: context.commanderBasePath,
        automations,
      })

      const payload: CommanderTemplatePackage = {
        schemaVersion: COMMANDER_TEMPLATE_SCHEMA_VERSION,
        exportedAt: context.now().toISOString(),
        sourceCommanderId: session.id,
        commander: {
          id: session.id,
          host: session.host,
          ...(session.executionMachineId ? { executionMachineId: session.executionMachineId } : {}),
          displayName,
          ...(session.agentType ? { agentType: session.agentType } : {}),
          ...(session.model !== undefined ? { model: session.model } : {}),
          ...(session.effort ? { effort: session.effort } : {}),
          maxTurns: session.maxTurns,
          contextMode: session.contextMode,
          ...(session.contextConfig ? { contextConfig: { ...session.contextConfig } } : {}),
          ...(session.cwd ? { cwd: session.cwd } : {}),
          taskSource: session.taskSource ? { ...session.taskSource } : null,
          ...(profile ? { profile } : {}),
        },
        commanderMd,
        memorySnapshot,
        skills: bundledSkills.skills,
        automations: automations.map(toCommanderBundleAutomation),
        skillBindings: bundledSkills.skillBindings,
      }

      res.json(payload)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to export commander template',
      })
    }
  })

  router.post('/import', context.requireWriteAccess, async (req, res) => {
    const payload = req.body
    if (!isRecord(payload) || (payload.schemaVersion !== 1 && payload.schemaVersion !== COMMANDER_TEMPLATE_SCHEMA_VERSION)) {
      res.status(400).json({ error: `schemaVersion must be 1 or ${COMMANDER_TEMPLATE_SCHEMA_VERSION}` })
      return
    }
    const isV2Bundle = payload.schemaVersion === COMMANDER_TEMPLATE_SCHEMA_VERSION

    const commander = isRecord(payload.commander) ? payload.commander : null
    if (!commander) {
      res.status(400).json({ error: 'commander template is required' })
      return
    }

    const sourceDisplayName = parseMessage(commander.displayName)
    if (!sourceDisplayName) {
      res.status(400).json({ error: 'commander.displayName is required' })
      return
    }
    const importedExecutionMachineId = commander.executionMachineId === undefined
      || commander.executionMachineId === null
      ? undefined
      : parseMachineId(commander.executionMachineId)
    if (
      commander.executionMachineId !== undefined
      && commander.executionMachineId !== null
      && !importedExecutionMachineId
    ) {
      res.status(400).json({ error: 'commander.executionMachineId must be a valid machine ID when provided' })
      return
    }

    const parsedIdentityOperatingStyle = parseIdentityOperatingStyleInput(commander.identityOperatingStyle)
    if (!parsedIdentityOperatingStyle.valid) {
      res.status(400).json({ error: 'commander.identityOperatingStyle must be a string when provided' })
      return
    }
    const identityOperatingStyle = parsedIdentityOperatingStyle.value

    const parsedAgentType = parseOptionalCommanderAgentType(commander.agentType)
    if (parsedAgentType === null) {
      res.status(400).json({ error: 'agentType must be a registered provider id' })
      return
    }
    const parsedModel = parseOptionalModelSelection(commander.model)
    if (!parsedModel.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }

    const parsedMaxTurns = parseOptionalCommanderMaxTurns(
      commander.maxTurns,
      { max: context.runtimeConfig.limits.maxTurns },
    )
    if (!parsedMaxTurns.valid) {
      res.status(400).json({
        error: `maxTurns must be an integer between 1 and ${context.runtimeConfig.limits.maxTurns}`,
      })
      return
    }

    const parsedContextMode = parseOptionalCommanderContextMode(commander.contextMode)
    if (!parsedContextMode.valid) {
      res.status(400).json({ error: 'contextMode must be either "thin" or "fat"' })
      return
    }

    const parsedContextConfig = parseOptionalHeartbeatContextConfig(commander.contextConfig)
    if (!parsedContextConfig.valid) {
      res.status(400).json({ error: 'Invalid contextConfig' })
      return
    }

    const taskSource = commander.taskSource === null || commander.taskSource === undefined
      ? null
      : parseTaskSource(commander.taskSource)
    if (commander.taskSource !== null && commander.taskSource !== undefined && !taskSource) {
      res.status(400).json({ error: 'Invalid taskSource' })
      return
    }

    const existing = await context.sessionStore.list()
    const displayNames = await readCommanderDisplayNames(context.commanderDataDir)
    const existingDisplayNames = new Set(
      existing.map((session) =>
        normalizeCommanderDisplayName(displayNames[session.id]?.trim() || session.host)),
    )
    const displayName = buildUniqueDisplayName(sourceDisplayName, existingDisplayNames)
    const requestedHost = parseHost(commander.host)
    const baseHost = requestedHost ?? buildHostFromDisplayName(sourceDisplayName)
    const host = buildUniqueHost(baseHost, new Set(existing.map((session) => session.host)))
    const sourceCommanderId = parseMessage(payload.sourceCommanderId)
      ?? parseMessage(commander.id)
      ?? undefined
    const commanderMd = typeof payload.commanderMd === 'string'
      ? payload.commanderMd
      : null
    const memorySnapshotProvided = payload.memorySnapshot !== undefined
    const memorySnapshot = memorySnapshotProvided && isRecord(payload.memorySnapshot)
      ? payload.memorySnapshot
      : null
    if (memorySnapshotProvided && typeof memorySnapshot?.memoryMd !== 'string') {
      res.status(400).json({ error: 'memorySnapshot.memoryMd must be a string when memorySnapshot is present' })
      return
    }
    if (memorySnapshot && parseNonNegativeInteger(memorySnapshot.syncRevision) === null) {
      res.status(400).json({ error: 'memorySnapshot.syncRevision must be a non-negative integer' })
      return
    }
    const memoryMd = memorySnapshot
      ? (memorySnapshot.memoryMd as string)
      : undefined
    const importedAgentType = parsedAgentType ?? resolveDefaultProviderId()
    const importedProfile = sanitizeUiProfile(commander.profile)
    const importedModelValidation = validateModelForAgentType(importedAgentType, parsedModel.value ?? null)
    if (!importedModelValidation.ok) {
      res.status(400).json({ error: importedModelValidation.error, validIds: importedModelValidation.validIds })
      return
    }
    const effortResolution = resolveCommanderModelEffort(
      importedAgentType,
      parsedModel.value,
      commander.effort,
      commander.effort !== undefined,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }
    const parsedSkillBindings = isV2Bundle
      ? parseCommanderBundleSkillBindings(payload.skillBindings)
      : { ok: true as const, value: [] }
    if (!parsedSkillBindings.ok) {
      res.status(400).json({ error: parsedSkillBindings.error })
      return
    }
    const parsedAutomations = isV2Bundle
      ? parseCommanderBundleAutomations(payload.automations)
      : { ok: true as const, value: [] }
    if (!parsedAutomations.ok) {
      res.status(400).json({ error: parsedAutomations.error })
      return
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      ...(importedExecutionMachineId ? { executionMachineId: importedExecutionMachineId } : {}),
      state: 'idle',
      created: context.now().toISOString(),
      agentType: importedAgentType,
      ...(parsedModel.value !== undefined ? { model: parsedModel.value } : {}),
      ...(effortResolution.effort ? { effort: effortResolution.effort } : {}),
      maxTurns: parsedMaxTurns.value ?? context.runtimeConfig.defaults.maxTurns,
      contextMode: parsedContextMode.value ?? DEFAULT_COMMANDER_CONTEXT_MODE,
      contextConfig: parsedContextConfig.value,
      heartbeat: createDefaultHeartbeatConfig(),
      taskSource,
      ...(sourceCommanderId ? { templateId: sourceCommanderId } : {}),
    }

    try {
      const created = await withProvisionedCommander(session.id, async () => {
        const provisioned = await persistCreatedCommanderOwned(session, displayName, {
          uiProfile: importedProfile,
        })
        if (commanderMd !== null) {
          await writeCommanderWorkflowMarkdown(
            session.id,
            commanderMd,
            context.commanderBasePath,
            context.commanderDataDir,
          )
        }
        if (identityOperatingStyle) {
          await mergeIdentityOperatingStyleIntoCommanderWorkflow(
            session.id,
            identityOperatingStyle,
            {
              cwd: session.cwd,
              displayName,
              basePath: context.commanderBasePath,
              lifecycleScope: context.commanderDataDir,
            },
          )
        }

        if (memoryMd !== undefined) {
          const applied = await applyRemoteMemorySnapshot(
            session.id,
            0,
            memoryMd,
            context.commanderBasePath,
            context.commanderDataDir,
          )
          if (applied.status !== 'applied') {
            throw new Error('Memory snapshot could not be applied to imported commander')
          }
        }

        await installCommanderBundleSkills(
          session.id,
          context.commanderBasePath,
          parsedSkillBindings.value,
          context.commanderDataDir,
        )
        if (parsedAutomations.value.length > 0) {
          await context.automationSchedulerInitialized
        }
        for (const automation of parsedAutomations.value) {
          const input = buildImportedCommanderBundleAutomationInput({
            sourceCommanderId,
            commanderId: session.id,
            defaultAgentType: importedAgentType,
            automation,
          })
          if (context.automationScheduler) {
            await context.automationScheduler.createAutomation(input)
          } else {
            await context.automationStore.create(input)
          }
        }
        return provisioned
      })

      res.status(201).json({
        ...created,
        displayName,
        url: buildCommandRoomLaunchTarget({ commanderId: session.id }).path,
      })
    } catch (error) {
      if (error instanceof DuplicateCommanderDisplayNameError) {
        res.status(409).json({ error: error.message })
        return
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to import commander template',
      })
    }
  })

  router.post('/:id/replicate', context.requireWriteAccess, async (req, res) => {
    const sourceCommanderId = parseSessionId(req.params.id)
    if (!sourceCommanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const source = await context.sessionStore.get(sourceCommanderId)
    if (!source) {
      res.status(404).json({ error: `Commander "${sourceCommanderId}" not found` })
      return
    }

    const displayName = parseMessage(req.body?.displayName)
    if (!displayName) {
      res.status(400).json({ error: 'displayName is required' })
      return
    }
    try {
      await assertUniqueCommanderDisplayName(displayName)
    } catch (error) {
      if (error instanceof DuplicateCommanderDisplayNameError) {
        res.status(409).json({ error: error.message })
        return
      }
      throw error
    }

    const existing = await context.sessionStore.list()
    const host = buildReplicatedHost(
      source.host,
      new Set(existing.map((session) => session.host)),
    )
    const replicatedAgentType = source.agentType ?? resolveDefaultProviderId()
    const effortResolution = resolveCommanderModelEffort(
      replicatedAgentType,
      source.model,
      source.effort,
      false,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      ...(source.executionMachineId ? { executionMachineId: source.executionMachineId } : {}),
      avatarSeed: source.avatarSeed,
      state: 'idle',
      created: context.now().toISOString(),
      agentType: replicatedAgentType,
      ...(source.model !== undefined ? { model: source.model } : {}),
      ...(effortResolution.effort ? { effort: effortResolution.effort } : {}),
      cwd: source.cwd,
      maxTurns: source.maxTurns,
      contextMode: source.contextMode,
      contextConfig: source.contextConfig ? { ...source.contextConfig } : undefined,
      heartbeat: { ...source.heartbeat },
      taskSource: source.taskSource ? { ...source.taskSource } : null,
      ...(source.templateId !== undefined ? { templateId: source.templateId } : {}),
      replicatedFromCommanderId: source.id,
    }

    try {
      const sourceProfile = await readCommanderUiProfile(sourceCommanderId, context.commanderBasePath)
      const sourceCommanderMd = await readCommanderWorkflowMarkdown(sourceCommanderId, context.commanderBasePath)
      const created = await withProvisionedCommander(session.id, async () => {
        const provisioned = await persistCreatedCommanderOwned(session, displayName, {
          uiProfile: sourceProfile,
        })
        if (sourceCommanderMd !== null) {
          await writeCommanderWorkflowMarkdown(
            session.id,
            sourceCommanderMd,
            context.commanderBasePath,
            context.commanderDataDir,
          )
        }
        return provisioned
      })
      res.status(201).json(
        displayName !== created.host
          ? { ...created, displayName }
          : created,
      )
    } catch (error) {
      if (error instanceof DuplicateCommanderDisplayNameError) {
        res.status(409).json({ error: error.message })
        return
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to replicate commander session',
      })
    }
  })

  router.patch('/:id', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const displayNameProvided = req.body?.displayName !== undefined
    if (req.body?.persona !== undefined || req.body?.identityOperatingStyle !== undefined) {
      res.status(400).json({ error: COMMANDER_MD_IDENTITY_MESSAGE })
      return
    }
    const agentTypeProvided = req.body?.agentType !== undefined
    const modelProvided = req.body?.model !== undefined
    const effortProvided = req.body?.effort !== undefined
    const cwdProvided = req.body?.cwd !== undefined
    const executionMachineIdProvided = req.body?.executionMachineId !== undefined
    const maxTurnsProvided = req.body?.maxTurns !== undefined
    const contextModeProvided = req.body?.contextMode !== undefined
    const portraitStyleProvided = req.body?.portraitStyleId !== undefined

    if (
      !displayNameProvided
      && !agentTypeProvided
      && !modelProvided
      && !effortProvided
      && !cwdProvided
      && !executionMachineIdProvided
      && !maxTurnsProvided
      && !contextModeProvided
      && !portraitStyleProvided
    ) {
      res.status(400).json({ error: 'At least one editable field must be provided' })
      return
    }

    const displayName = displayNameProvided
      ? parseMessage(req.body?.displayName)
      : undefined
    if (displayNameProvided && !displayName) {
      res.status(400).json({ error: 'displayName must be a non-empty string' })
      return
    }

    const parsedAgentType = parseOptionalCommanderAgentType(req.body?.agentType)
    if (agentTypeProvided && (req.body?.agentType === null || parsedAgentType === null)) {
      res.status(400).json({ error: 'agentType must be a supported provider' })
      return
    }

    const parsedModel = parseOptionalModelSelection(req.body?.model)
    if (modelProvided && !parsedModel.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }
    const parsedModelValue = parsedModel.ok ? parsedModel.value : undefined

    if (maxTurnsProvided && req.body?.maxTurns === null) {
      res.status(400).json({
        error: `maxTurns must be an integer between 1 and ${context.runtimeConfig.limits.maxTurns}`,
      })
      return
    }
    const parsedMaxTurns = parseOptionalCommanderMaxTurns(
      req.body?.maxTurns,
      { max: context.runtimeConfig.limits.maxTurns },
    )
    if (!parsedMaxTurns.valid) {
      res.status(400).json({
        error: `maxTurns must be an integer between 1 and ${context.runtimeConfig.limits.maxTurns}`,
      })
      return
    }

    if (contextModeProvided && req.body?.contextMode === null) {
      res.status(400).json({ error: 'contextMode must be either "thin" or "fat"' })
      return
    }
    const parsedContextMode = parseOptionalCommanderContextMode(req.body?.contextMode)
    if (!parsedContextMode.valid) {
      res.status(400).json({ error: 'contextMode must be either "thin" or "fat"' })
      return
    }
    const portraitStyleId = portraitStyleProvided
      ? parseCommanderPortraitStyleId(req.body?.portraitStyleId)
      : undefined
    if (portraitStyleProvided && !portraitStyleId) {
      res.status(400).json({ error: `portraitStyleId must be one of: ${listCommanderPortraitStyleIds()}` })
      return
    }

    const cwd = !cwdProvided
      ? undefined
      : req.body?.cwd === null
        ? undefined
        : parseMessage(req.body?.cwd) ?? undefined
    if (
      cwdProvided
      && req.body?.cwd !== null
      && typeof req.body?.cwd !== 'string'
    ) {
      res.status(400).json({ error: 'cwd must be a string when provided' })
      return
    }
    const executionMachineId = !executionMachineIdProvided
      || req.body?.executionMachineId === null
      ? undefined
      : parseMachineId(req.body.executionMachineId) ?? undefined
    if (
      executionMachineIdProvided
      && req.body?.executionMachineId !== null
      && !executionMachineId
    ) {
      res.status(400).json({ error: 'executionMachineId must be a valid machine ID or null' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const existingDisplayNames = await readCommanderDisplayNames(context.commanderDataDir)
    const previousDisplayName = existingDisplayNames[commanderId] ?? session.host
    const nextDisplayName = displayName ?? previousDisplayName
    if (displayNameProvided && displayName && displayName !== previousDisplayName) {
      try {
        await assertUniqueCommanderDisplayName(displayName, commanderId)
      } catch (error) {
        if (error instanceof DuplicateCommanderDisplayNameError) {
          res.status(409).json({ error: error.message })
          return
        }
        throw error
      }
    }
    const nextAgentType = parsedAgentType ?? session.agentType ?? resolveDefaultProviderId()
    const nextModel = modelProvided ? parsedModelValue : (session.model ?? null)
    const modelValidation = validateModelForAgentType(nextAgentType, nextModel ?? null)
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const effortResolution = resolveCommanderModelEffort(
      nextAgentType,
      nextModel,
      effortProvided ? req.body?.effort : session.effort,
      effortProvided,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }

    const updated = await context.sessionStore.update(commanderId, (current) => {
      const nextContextMode = parsedContextMode.value ?? current.contextMode
      return {
        ...current,
        ...(agentTypeProvided
          ? (nextAgentType ? { agentType: nextAgentType } : { agentType: undefined })
          : {}),
        ...(modelProvided ? { model: parsedModelValue } : {}),
        ...(agentTypeProvided || modelProvided || effortProvided
          ? { effort: effortResolution.effort }
          : {}),
        ...(cwdProvided ? { cwd } : {}),
        ...(executionMachineIdProvided ? { executionMachineId } : {}),
        ...(maxTurnsProvided && parsedMaxTurns.value !== undefined ? { maxTurns: parsedMaxTurns.value } : {}),
        ...(contextModeProvided && parsedContextMode.value !== undefined ? { contextMode: parsedContextMode.value } : {}),
        ...(contextModeProvided && nextContextMode === 'thin' ? { contextConfig: undefined } : {}),
      }
    })

    if (!updated) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (displayNameProvided && displayName && displayName !== previousDisplayName) {
      try {
        await upsertCommanderDisplayName(context.commanderDataDir, commanderId, displayName)
      } catch (error) {
        await context.sessionStore.update(commanderId, () => session).catch(() => {})
        if (error instanceof DuplicateCommanderDisplayNameError) {
          res.status(409).json({ error: error.message })
          return
        }
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to update commander display name',
        })
        return
      }
    }

    if (portraitStyleProvided && portraitStyleId) {
      const existingProfile = await readCommanderUiProfile(commanderId, context.commanderBasePath)
      await writeCommanderUiProfile(
        commanderId,
        context.commanderBasePath,
        ensureCommanderVisualProfile({
          ...(existingProfile ?? {}),
          portraitStyleId,
        }),
        context.commanderDataDir,
      )
    }

    const activeSession = context.activeCommanderSessions.get(commanderId)
    if (activeSession) {
      const liveSession = context.sessionsInterface?.getSession(activeSession.sessionName)
      if (liveSession) {
        liveSession.maxTurns = updated.maxTurns
      }
    }

    res.json(await buildCommanderApiResponse(updated, nextDisplayName))
  })

  const startCommanderRoute = async (
    req: import('express').Request,
    res: import('express').Response,
  ) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }
    if (rejectArchivedCommanderRuntime(session, res)) {
      return
    }
    if (session.state === 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is already running` })
      return
    }

    const costCap = await enforceCommanderCostCap(context, commanderId)
    if (!costCap.ok) {
      res.status(costCap.status).json(costCap.body)
      return
    }

    const parsedCurrentTask = parseOptionalCurrentTask(req.body?.currentTask, context.now().toISOString())
    if (!parsedCurrentTask.valid) {
      res.status(400).json({ error: 'Invalid currentTask payload' })
      return
    }
    const parsedAgentType = parseOptionalCommanderAgentType(req.body?.agentType)
    if (parsedAgentType === null) {
      res.status(400).json({ error: 'agentType must be a registered provider id' })
      return
    }
    const selectedAgentType = parsedAgentType ?? resolveCommanderAgentType(session)
    const modelValidation = validateModelForAgentType(selectedAgentType, session.model ?? null)
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const effortResolution = resolveCommanderModelEffort(
      selectedAgentType,
      session.model,
      session.effort,
      false,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }
    const previousState = session.state
    const defaultConversation = await context.ensureDefaultConversation(session, { surface: 'ui' })
    const sessionName = buildConversationSessionName(defaultConversation)
    let runtime: CommanderRuntime | null = null
    let startStateUpdated = false

    const rollbackCommanderStart = async (): Promise<void> => {
      context.heartbeatManager.stopForCommander(commanderId)

      if (runtime?.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      if (runtime) {
        runtime.pendingCollect = []
        runtime.unsubscribeEvents?.()
        context.runtimes.delete(commanderId)
      }

      context.activeCommanderSessions.delete(commanderId)
      context.sessionsInterface?.deleteSession(sessionName)

      if (!startStateUpdated) {
        return
      }

      await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        state: previousState,
      }))
      await context.conversationStore.update(defaultConversation.id, (current) => ({
        ...current,
        status: defaultConversation.status,
        currentTask: defaultConversation.currentTask,
        lastHeartbeat: defaultConversation.lastHeartbeat,
        heartbeatTickCount: defaultConversation.heartbeatTickCount,
      }))
    }

    try {
      await context.questStore.resetActiveToPending(commanderId)

      const manager = new CommanderManager(
        commanderId,
        context.commanderBasePath,
        {
          onSubagentLifecycleEvent: (event) => context.onSubagentLifecycleEvent(commanderId, event),
          lifecycleScope: context.commanderDataDir,
        },
      )
      await manager.init()
      const contextPressureBridge = createContextPressureBridge()
      const workflow = await resolveCommanderWorkflow(
        commanderId,
        session.cwd,
        context.commanderBasePath,
      )
      const started = await context.sessionStore.update(commanderId, (current) => ({
        ...current,
        state: 'running',
        agentType: selectedAgentType,
      }))

      if (!started) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }
      startStateUpdated = true

      const activeConversation = await context.conversationStore.update(defaultConversation.id, (current) => ({
        ...current,
        status: 'active',
        currentTask: parsedCurrentTask.value ?? current.currentTask,
        lastHeartbeat: null,
        heartbeatTickCount: 0,
      }))
      const effectiveHeartbeat = resolveEffectiveHeartbeat(started)
      const built = await buildCommanderSessionSeedFromResolvedWorkflow(
        {
          commanderId,
          cwd: started.cwd ?? undefined,
          currentTask: activeConversation?.currentTask ?? defaultConversation.currentTask,
          taskSource: started.taskSource,
          maxTurns: started.maxTurns,
          memoryBasePath: context.commanderBasePath,
        },
        workflow,
      )
      const baseSystemPrompt = selectedAgentType === 'claude'
        ? appendClaudeReasoningPolicy(built.systemPrompt)
        : built.systemPrompt
      const gaiaOpsEnv = await buildGaiaOpsEnvWithMetadata(
        context,
        started,
        activeConversation ?? defaultConversation,
      )
      const systemPrompt = gaiaOpsEnv
        ? appendGaiaOpsSkillGuide(baseSystemPrompt)
        : baseSystemPrompt

      if (!context.sessionsInterface) {
        throw new Error('sessionsInterface not configured — agents router bridge missing')
      }

      context.sessionsInterface.deleteSession(sessionName)
      await context.sessionsInterface.createCommanderSession({
        name: sessionName,
        commanderId,
        conversationId: activeConversation?.id ?? defaultConversation.id,
        systemPrompt,
        agentType: selectedAgentType,
        model: started.model ?? undefined,
        effort: effortResolution.effort,
        omitEffort: effortResolution.omitEffort,
        cwd: started.cwd ?? undefined,
        machineId: started.executionMachineId,
        maxTurns: built.maxTurns,
        ...(gaiaOpsEnv ? {
          env: gaiaOpsEnv.env,
          gaiaOpsApiKeyExpiresAt: gaiaOpsEnv.apiKeyExpiresAt,
        } : {}),
      })

      const initialStreamSession = context.sessionsInterface.getSession(sessionName)
      const initialInputTokens = (
        typeof initialStreamSession?.usage.inputTokens === 'number' &&
        Number.isFinite(initialStreamSession.usage.inputTokens)
      )
        ? initialStreamSession.usage.inputTokens
        : 0

      const explicitStartMessage = parseMessage(req.body?.message)
      const startPrompt = explicitStartMessage ?? STARTUP_PROMPT
      runtime = {
        manager,
        contextPressureBridge,
        lastTaskState: 'Commander started',
        heartbeatCount: 0,
        lastKnownInputTokens: initialInputTokens,
        forceNextFatHeartbeat: false,
        pendingCollect: [],
        pendingInternalUserMessages: new Map(),
        collectTimer: null,
        subAgents: new Map(),
        terminalState: null,
      }

      let contextPressureTriggeredForTurn = false
      const unsubscribeEvents = context.sessionsInterface.subscribeToEvents(sessionName, (event) => {
        const eventType = isTranscriptEnvelope(event) ? event.ev.type : ''
        if (eventType === 'turn.start') {
          contextPressureTriggeredForTurn = false
          if (runtime) {
            runtime.terminalState = null
          }
        }

        const rawUserMessage = extractRawUserMessage(event)
        if (rawUserMessage && runtime) {
          consumeInternalUserMessage(runtime, rawUserMessage)
        }

        const streamSession = context.sessionsInterface?.getSession(sessionName)
        const sessionInputTokens = (
          typeof streamSession?.usage.inputTokens === 'number' &&
          Number.isFinite(streamSession.usage.inputTokens)
        )
          ? streamSession.usage.inputTokens
          : 0

        if (
          runtime &&
          !contextPressureTriggeredForTurn &&
          (
            isContextPressureSubtypeEvent(event) ||
            isInputTokenContextPressureEvent(
              event,
              sessionInputTokens,
              context.contextPressureInputTokenThreshold,
            )
          )
        ) {
          contextPressureTriggeredForTurn = true
          void contextPressureBridge.trigger()
        }

        if (eventType === 'turn.end' && runtime) {
          runtime.terminalState = resolveCommanderTerminalState(event)
          const observedPostCompactionBoundary = (
            runtime.lastKnownInputTokens > 0 &&
            sessionInputTokens > 0 &&
            sessionInputTokens < runtime.lastKnownInputTokens * 0.5
          )

          if (observedPostCompactionBoundary) {
            runtime.forceNextFatHeartbeat = true
          }
          runtime.lastKnownInputTokens = sessionInputTokens
          contextPressureTriggeredForTurn = false
        }
      })

      runtime.unsubscribeEvents = unsubscribeEvents

      context.runtimes.set(commanderId, runtime)
      context.activeCommanderSessions.set(commanderId, {
        sessionName,
        startedAt: context.now().toISOString(),
      })
      context.heartbeatManager.start(
        activeConversation?.id ?? defaultConversation.id,
        commanderId,
        effectiveHeartbeat,
      )
      if (explicitStartMessage == null) {
        queueInternalUserMessage(runtime, startPrompt)
      }
      const startupSent = await context.sessionsInterface.sendToSession(
        sessionName,
        explicitStartMessage == null
          ? { text: startPrompt, userEventSubtype: COMMANDER_STARTUP_USER_EVENT_SUBTYPE }
          : startPrompt,
        { intent: 'interrupt' },
      )
      if (!startupSent.ok) {
        console.warn(
          `[commanders] Startup message failed for "${commanderId}" (${selectedAgentType}); resetting runtime state`,
        )
        await rollbackCommanderStart()

        res.status(503).json({
          error: 'Commander startup message could not be delivered. Please retry start.',
        })
        return
      }

      res.json({
        id: started.id,
        state: started.state,
        started: true,
      })
    } catch (error) {
      try {
        await rollbackCommanderStart()
      } catch (rollbackError) {
        console.error(`[commanders] Failed to roll back start for "${commanderId}":`, rollbackError)
      }
      const status = isProviderLaunchError(error)
        ? error.statusCode
        : 500
      res.status(status).json({
        ...(isProviderLaunchError(error) && error.code
          ? { code: error.code }
          : {}),
        error: error instanceof Error ? error.message : 'Failed to start commander',
      })
    }
  }

  router.post('/:id/start', context.requireWriteAccess, startCommanderRoute)

  router.post('/:id/heartbeat', context.requireWriteAccess, triggerHeartbeatRoute)
  router.post('/:id/heartbeat/trigger', context.requireWriteAccess, triggerHeartbeatRoute)

  router.post('/:id/stop', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    context.heartbeatManager.stopForCommander(commanderId)
    const activeSession = context.activeCommanderSessions.get(commanderId)

    // Sweep every conversation owned by this commander, not just the default
    // single-session path. Per #1216 phase 1 each conversation can have its
    // own per-conversation stream session under
    // `commander-${commanderId}-conversation-${convId}`; stopping only the
    // commander session would leave those orphaned and report `stopped` while live
    // agent runtimes kept consuming budget. See codex-review P1 on PR #1279
    // (comment 3174778566).
    const conversations = await context.conversationStore.listByCommander(commanderId)
    for (const conversation of conversations) {
      if (conversation.status === 'archived') {
        continue
      }
      try {
        await stopConversationSession(context, conversation, 'idle')
      } catch (error) {
        console.warn(
          `[commanders] Failed to stop conversation "${conversation.id}" during commander stop "${commanderId}":`,
          error,
        )
      }
    }

    const runtime = context.runtimes.get(commanderId)
    if (runtime) {
      if (runtime.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      runtime.pendingCollect = []
      const stopState = parseMessage(req.body?.state) ?? 'Commander stop requested'
      runtime.lastTaskState = stopState
      runtime.unsubscribeEvents?.()
      context.runtimes.delete(commanderId)
    }

    context.activeCommanderSessions.delete(commanderId)
    if (activeSession) {
      context.sessionsInterface?.deleteSession(activeSession.sessionName)
    }

    const stopped = await context.sessionStore.update(commanderId, (current) => ({
      ...current,
      state: 'stopped',
    }))

    if (!stopped) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    res.json({
      id: stopped.id,
      state: stopped.state,
      stopped: true,
    })
  })

  router.delete('/wizard/:sessionName', context.requireWriteAccess, (req, res) => {
    const sessionName = parseWizardSessionName(req.params.sessionName)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid wizard session name' })
      return
    }

    context.sessionsInterface?.deleteSession(sessionName)
    res.status(204).send()
  })

  router.post('/:id/archive', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (isProtectedSystemCommander(session)) {
      res.status(403).json({ error: `Commander "${commanderId}" is a system commander and cannot be archived.` })
      return
    }

    if (session.state === 'running') {
      res.status(409).json({
        error: `Commander "${commanderId}" is running. Stop it before archiving.`,
      })
      return
    }

    const conversations = await context.conversationStore.listByCommander(commanderId)
    const activeLiveConversation = conversations.find((conversation) => (
      conversation.status === 'active'
      && Boolean(getLiveConversationSession(context, conversation))
    ))
    if (activeLiveConversation) {
      res.status(409).json({
        error: `Commander "${commanderId}" has an active live conversation "${activeLiveConversation.id}". Stop it before archiving.`,
      })
      return
    }

    const archivedAt = session.archivedAt ?? context.now().toISOString()
    const archived = await context.sessionStore.update(commanderId, (current) => ({
      ...current,
      archived: true,
      archivedAt,
    }))

    if (!archived) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    res.json({
      id: archived.id,
      archived: archived.archived === true,
      archivedAt: archived.archivedAt,
    })
  })

  router.post('/:id/restore', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const restored = await context.sessionStore.update(commanderId, (current) => ({
      ...current,
      archived: false,
      archivedAt: undefined,
    }))

    if (!restored) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    res.json({
      id: restored.id,
      archived: restored.archived === true,
      archivedAt: restored.archivedAt ?? null,
    })
  })

  router.delete('/:id', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (isProtectedSystemCommander(session)) {
      res.status(403).json({ error: `Commander "${commanderId}" is a system commander and cannot be deleted.` })
      return
    }

    if (session.state === 'running') {
      res.status(409).json({
        error: `Commander "${commanderId}" is running. Stop it before deleting.`,
      })
      return
    }

    // Archive the current children normally, then turn a final generation +
    // child-state observation into the exclusive deletion lease. A child or
    // metadata writer racing that observation invalidates it and is swept on
    // the next attempt; a writer queued after lease acquisition is rejected
    // when the parent tombstone commits.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const currentSession = await context.sessionStore.get(commanderId)
      if (!currentSession) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }
      if (isProtectedSystemCommander(currentSession)) {
        res.status(403).json({ error: `Commander "${commanderId}" is a system commander and cannot be deleted.` })
        return
      }
      if (currentSession.state === 'running') {
        res.status(409).json({
          error: `Commander "${commanderId}" is running. Stop it before deleting.`,
        })
        return
      }

      const conversations = await context.conversationStore.listByCommander(commanderId)
      const activeLiveConversation = conversations.find((conversation) => (
        conversation.status === 'active'
        && Boolean(getLiveConversationSession(context, conversation))
      ))
      if (activeLiveConversation) {
        res.status(409).json({
          error: `Commander "${commanderId}" has an active live conversation "${activeLiveConversation.id}". Stop it before deleting.`,
        })
        return
      }

      try {
        for (const conversation of conversations) {
          if (conversation.status !== 'archived') {
            await stopConversationSession(context, conversation, 'archived')
          }
        }
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error
            ? error.message
            : `Failed to archive conversations for commander "${commanderId}"`,
        })
        return
      }

      const observedMutationVersion = captureCommanderChildMutationVersion(
        commanderId,
        context.commanderDataDir,
      )
      const [finalSession, finalConversations, finalAutomations] = await Promise.all([
        context.sessionStore.get(commanderId),
        context.conversationStore.listByCommander(commanderId),
        context.automationStore.list({ parentCommanderId: commanderId }),
      ])
      if (!finalSession) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }
      if (finalSession.state === 'running') {
        res.status(409).json({
          error: `Commander "${commanderId}" is running. Stop it before deleting.`,
        })
        return
      }
      if (finalConversations.some((conversation) => conversation.status !== 'archived')) {
        continue
      }

      context.heartbeatManager.stopForCommander(commanderId)
      const deletion = await deleteCommanderStateWithLease({
        commanderId,
        commanderDataDir: context.commanderDataDir,
        commanderBasePath: context.commanderBasePath,
        observedMutationVersion,
        sessionStore: context.sessionStore,
        questStore: context.questStore,
        heartbeatLog: context.heartbeatLog,
        deleteChildren: async () => {
          for (const automation of [...finalAutomations].reverse()) {
            if (context.automationScheduler) {
              await context.automationScheduler.deleteAutomation(automation.id)
            } else {
              await context.automationStore.delete(automation.id, { removeFiles: true })
            }
          }
        },
      })
      if (!deletion.leaseAcquired) {
        continue
      }
      if (!deletion.deleted) {
        res.status(500).json({
          error: deletion.error instanceof Error
            ? deletion.error.message
            : `Failed to delete commander "${commanderId}"`,
        })
        return
      }

      const runtime = context.runtimes.get(commanderId)
      if (runtime) {
        if (runtime.collectTimer) {
          clearTimeout(runtime.collectTimer)
          runtime.collectTimer = null
        }
        runtime.pendingCollect = []
        runtime.unsubscribeEvents?.()
        context.runtimes.delete(commanderId)
      }
      context.activeCommanderSessions.delete(commanderId)
      res.status(204).send()
      return
    }

    res.status(409).json({
      error: `Commander "${commanderId}" changed repeatedly while deletion was being prepared.`,
    })
  })

  router.patch('/:id/heartbeat', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const parsed = parseHeartbeatPatch(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const updatedCommander = await context.sessionStore.update(commanderId, (current) => ({
      ...current,
      heartbeat: mergeHeartbeatConfig(current.heartbeat, parsed.value),
    }))

    if (!updatedCommander) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const conversations = (await context.conversationStore.listByCommander(commanderId))
      .filter((conversation) => conversation.status !== 'archived')
    const effectiveHeartbeat = resolveEffectiveHeartbeat(updatedCommander)
    for (const conversation of conversations) {
      context.heartbeatManager.start(conversation.id, commanderId, effectiveHeartbeat)
    }

    res.json({
      id: updatedCommander.id,
      heartbeat: { ...updatedCommander.heartbeat },
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        lastHeartbeat: conversation.lastHeartbeat,
      })),
    })
  })

  router.patch('/:id/runtime', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }
    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const parsedMaxTurns = parseOptionalCommanderMaxTurns(
      req.body?.maxTurns,
      { max: context.runtimeConfig.limits.maxTurns },
    )
    if (!parsedMaxTurns.valid) {
      res.status(400).json({
        error: `maxTurns must be an integer between 1 and ${context.runtimeConfig.limits.maxTurns}`,
      })
      return
    }

    const parsedContextMode = parseOptionalCommanderContextMode(req.body?.contextMode)
    if (!parsedContextMode.valid) {
      res.status(400).json({ error: 'contextMode must be either "thin" or "fat"' })
      return
    }

    const parsedContextConfig = parseOptionalHeartbeatContextConfig(req.body?.contextConfig)
    if (!parsedContextConfig.valid) {
      res.status(400).json({ error: 'Invalid contextConfig' })
      return
    }

    const parsedCostCapUsd = parseOptionalCommanderCostCapUsd(req.body?.costCapUsd)
    if (!parsedCostCapUsd.valid) {
      res.status(400).json({ error: 'costCapUsd must be a positive finite number or null' })
      return
    }

    const effortProvided = req.body?.effort !== undefined
    const effortResolution = resolveCommanderModelEffort(
      session.agentType ?? resolveDefaultProviderId(),
      session.model,
      effortProvided ? req.body?.effort : session.effort,
      effortProvided,
    )
    if (!effortResolution.ok) {
      res.status(400).json({ error: effortResolution.error })
      return
    }

    const adaptiveThinkingProvided = req.body?.adaptiveThinking !== undefined
    const parsedAdaptiveThinking = parseClaudeAdaptiveThinking(req.body?.adaptiveThinking)
    if (adaptiveThinkingProvided && parsedAdaptiveThinking === null) {
      res.status(400).json({ error: 'adaptiveThinking must be one of: enabled, disabled' })
      return
    }

    const maxThinkingTokensProvided = req.body?.maxThinkingTokens !== undefined
    const parsedMaxThinkingTokens = parseClaudeMaxThinkingTokens(req.body?.maxThinkingTokens)
    if (maxThinkingTokensProvided && parsedMaxThinkingTokens === null) {
      res.status(400).json({ error: 'maxThinkingTokens must be an integer between 1024 and 256000' })
      return
    }

    if (
      parsedMaxTurns.value === undefined
      && parsedContextMode.value === undefined
      && parsedContextConfig.value === undefined
      && parsedCostCapUsd.value === undefined
      && !effortProvided
      && !adaptiveThinkingProvided
      && !maxThinkingTokensProvided
    ) {
      res.status(400).json({ error: 'At least one runtime field must be provided' })
      return
    }

    const updated = await context.sessionStore.update(commanderId, (current) => {
      const nextContextMode = parsedContextMode.value ?? current.contextMode
      const nextContextConfig = nextContextMode === 'thin'
        ? undefined
        : parsedContextConfig.value !== undefined
          ? parsedContextConfig.value
          : current.contextConfig

      return {
        ...current,
        ...(parsedMaxTurns.value !== undefined ? { maxTurns: parsedMaxTurns.value } : {}),
        ...(parsedCostCapUsd.value !== undefined ? { costCapUsd: parsedCostCapUsd.value } : {}),
        ...(parsedContextMode.value !== undefined ? { contextMode: parsedContextMode.value } : {}),
        ...(effortProvided ? { effort: effortResolution.effort } : {}),
        ...(adaptiveThinkingProvided
          ? { adaptiveThinking: parsedAdaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE }
          : {}),
        ...(maxThinkingTokensProvided
          ? { maxThinkingTokens: parsedMaxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS }
          : {}),
        ...(
          nextContextMode === 'thin' || parsedContextConfig.value !== undefined
            ? { contextConfig: nextContextConfig }
            : {}
        ),
      }
    })

    if (!updated) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const activeSession = context.activeCommanderSessions.get(commanderId)
    if (activeSession) {
      const liveSession = context.sessionsInterface?.getSession(activeSession.sessionName)
      if (liveSession) {
        liveSession.maxTurns = updated.maxTurns
      }
    }

    res.json({
      id: updated.id,
      maxTurns: updated.maxTurns,
      costCapUsd: updated.costCapUsd ?? null,
      contextMode: updated.contextMode,
      contextConfig: updated.contextConfig ?? null,
      effort: updated.effort,
      adaptiveThinking: updated.adaptiveThinking ?? DEFAULT_CLAUDE_ADAPTIVE_THINKING_MODE,
      maxThinkingTokens: updated.maxThinkingTokens ?? DEFAULT_CLAUDE_MAX_THINKING_TOKENS,
    })
  })

  const deliverCommanderMessageRoute = async (
    req: import('express').Request,
    res: import('express').Response,
    modeOverride?: 'collect' | 'followup',
  ) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const message = parseMessage(req.body?.message)
    if (!message) {
      res.status(400).json({ error: 'Message must be a non-empty string' })
      return
    }
    const mode = modeOverride ?? parseMessageMode(req.query.mode)
    if (!mode) {
      res.status(400).json({ error: 'mode must be either "collect" or "followup"' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }
    if (rejectArchivedCommanderRuntime(session, res)) {
      return
    }

    const runtime = context.runtimes.get(commanderId)
    if (!runtime || session.state !== 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is not running` })
      return
    }

    const delivered = await context.dispatchCommanderMessage({
      commanderId,
      message,
      mode,
      session,
      runtime,
    })
    if (!delivered.ok) {
      if (delivered.status === 409) {
        res.status(409).json({ error: `Commander "${commanderId}" is not running` })
        return
      }
      res.status(delivered.status).json({ error: delivered.error })
      return
    }

    res.json({ accepted: true })
  }

  router.post('/:id/run-now', context.requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const message = parseMessage(req.body?.message)
    if (!message) {
      res.status(400).json({ error: 'message must be a non-empty string' })
      return
    }

    const session = await context.sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }
    if (rejectArchivedCommanderRuntime(session, res)) {
      return
    }

    if (session.state === 'running') {
      if (req.body?.agentType !== undefined || req.body?.currentTask !== undefined) {
        res.status(400).json({
          error: 'agentType and currentTask are only supported when run-now starts a stopped commander',
        })
        return
      }
      await deliverCommanderMessageRoute(req, res, 'followup')
      return
    }

    await startCommanderRoute(req, res)
  })

  router.post('/:id/message', context.requireWriteAccess, async (req, res) => {
    await deliverCommanderMessageRoute(req, res)
  })
}
