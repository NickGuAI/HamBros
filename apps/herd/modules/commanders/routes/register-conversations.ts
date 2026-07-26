import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Request, Response } from 'express'
import { parseMessageImagesForRequest } from '../../agents/message-images.js'
import { sanitizeTranscriptFileKey } from '../../agents/session/persistence.js'
import {
  parseClaudeAdaptiveThinking,
  parseClaudeMaxThinkingTokens,
} from '../../agents/session/input.js'
import { deleteSessionTranscript } from '../../agents/transcript-store.js'
import { getProvider, parseProviderId, resolveDefaultProviderId } from '../../agents/providers/registry.js'
import {
  resolveProviderDefaults,
  type ProviderModelOption,
} from '../../agents/providers/provider-adapter.js'
import { getCachedProviderModelsForValidation } from '../../agents/providers/model-discovery.js'
import {
  getAgentEffortLevels,
  getAgentEffortLevelsForModel,
  getDefaultAgentEffortForModel,
  parseOptionalAgentEffort,
  parseStoredAgentEffort,
} from '../../agents/effort.js'
import {
  asClaudeProviderContext,
  createProviderContextForAgentType,
} from '../../agents/providers/provider-session-context.js'
import { validateModelForAgentType } from '../../agents/providers/validate-model.js'
import {
  applyWorkspaceContextToText,
  hasWorkspaceContextPayload,
  readWorkspaceContextPayload,
} from '../../workspace/context.js'
import { toWorkspaceError } from '../../workspace/resolver.js'
import type { AgentType } from '../../agents/types.js'
import { isProviderLaunchError } from '../../agents/session/machine-launch.js'
import {
  conversationNamesEqual,
  normalizeConversationName,
} from '../conversation-names.js'
import { resolveCommanderPaths } from '../paths.js'
import {
  isObject,
  parseSessionId,
  parseTrimmedString,
} from '../route-parsers.js'
import type { CommanderChannelMeta } from '../store.js'
import type { Conversation } from '../conversation-store.js'
import { enforceCommanderCostCap } from '../cost-control.js'
import { resolveConversationCredentialSelectionMode } from '../conversation-credential-selection.js'
import {
  ConversationProviderSwapConflictError,
  ConversationProviderSwapUnavailableError,
  deliverConversationMessage,
  getConversationMessagesPage,
  getLiveConversationSession,
  startConversationSession,
  stopConversationSession,
  updateConversationRuntimeSettings,
  type ConversationSpawnOptions,
  updateCommanderDerivedState,
  buildConversationSessionName,
} from './conversation-runtime.js'
import {
  buildConversationSummaryDTO,
  type ConversationSummaryDTO,
} from './conversation-read-model.js'
import {
  beginConversationBootstrap,
  completeConversationBootstrap,
  conversationBootstrapCancelRequested,
  failConversationBootstrap,
  getConversationBootstrapCancelStatus,
  getConversationRuntimeOverlay,
  requestConversationBootstrapCancel,
} from './conversation-runtime-state.js'
import type { CommanderRoutesContext } from './types.js'

type ConversationStatusAction = 'pause' | 'resume' | 'archive'

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_CONVERSATION_MESSAGES_LIMIT = 50
const MAX_CONVERSATION_MESSAGES_LIMIT = 100
const CONVERSATION_BOOTSTRAP_FAST_PATH_MS = 25

function findProviderModelOption(
  models: readonly ProviderModelOption[],
  model: string | null | undefined,
): ProviderModelOption | undefined {
  const id = model?.trim()
  if (!id) {
    return models.find((option) => option.default)
  }
  return models.find((option) => (
    option.id === id
    || option.resolvedModel === id
    || option.aliases?.includes(id) === true
  ))
}

export interface CommanderConversationBootstrapProjection {
  commanderId: string
  conversations: ConversationSummaryDTO[]
  activeConversation: ConversationSummaryDTO | null
  selectedConversation: ConversationSummaryDTO | null
  selectedConversationId: string | null
}

function parseConversationId(raw: unknown): string | null {
  return typeof raw === 'string' && CONVERSATION_ID_PATTERN.test(raw.trim())
    ? raw.trim()
    : null
}

function parseConversationMessagesLimit(raw: unknown): number | null {
  if (raw === undefined) {
    return DEFAULT_CONVERSATION_MESSAGES_LIMIT
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null
  }
  return Math.min(parsed, MAX_CONVERSATION_MESSAGES_LIMIT)
}

function parseConversationMessagesBefore(raw: unknown): number | null | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

function parseConversationSurface(raw: unknown): Conversation['surface'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as Conversation['surface']
    : null
}

function parseConversationAgentType(raw: unknown): AgentType | null {
  return parseProviderId(raw)
}

function parseConversationStatus(raw: unknown): Conversation['status'] | null {
  return raw === 'active' || raw === 'idle' || raw === 'archived'
    ? raw
    : null
}

function parseConversationChannelMeta(raw: unknown): CommanderChannelMeta | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const provider = raw.provider
  const chatType = raw.chatType
  const accountId = parseTrimmedString(raw.accountId)
  const peerId = parseTrimmedString(raw.peerId)
  const sessionKey = parseTrimmedString(raw.sessionKey)
  const displayName = parseTrimmedString(raw.displayName)
  if (
    (provider !== 'whatsapp' && provider !== 'telegram' && provider !== 'discord') ||
    (chatType !== 'direct' && chatType !== 'group' && chatType !== 'channel' && chatType !== 'forum-topic') ||
    !accountId ||
    !peerId ||
    !sessionKey ||
    !displayName
  ) {
    return undefined
  }

  const optional = (value: unknown): string | undefined => parseTrimmedString(value) ?? undefined
  return {
    provider,
    chatType,
    accountId,
    peerId,
    sessionKey,
    displayName,
    parentPeerId: optional(raw.parentPeerId),
    groupId: optional(raw.groupId),
    threadId: optional(raw.threadId),
    subject: optional(raw.subject),
    space: optional(raw.space),
  }
}

function parseConversationName(raw: unknown): string | null {
  return normalizeConversationName(raw)
}

function parseConversationModel(
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
  return { ok: true, value: trimmed.length > 0 ? trimmed : null }
}

function parseConversationCredentialPoolId(
  raw: unknown,
): { ok: true; value?: string } | { ok: false } {
  if (raw === undefined) {
    return { ok: true }
  }
  if (typeof raw !== 'string') {
    return { ok: false }
  }
  const value = raw.trim()
  return value.length > 0 && value.length <= 128
    ? { ok: true, value }
    : { ok: false }
}

function requestActorKind(req: import('express').Request): Conversation['createdByKind'] {
  if (req.authMode === 'auth0') {
    return 'human'
  }
  return 'api-key'
}

function requestActorId(req: import('express').Request): string | undefined {
  const metadata = req.user?.metadata
  if (metadata && typeof metadata === 'object') {
    const keyId = (metadata as Record<string, unknown>).keyId
    if (typeof keyId === 'string' && keyId.trim().length > 0) {
      return keyId.trim()
    }
  }

  const id = req.user?.id
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
}

function requestId(req: import('express').Request): string | undefined {
  const value = req.get('x-request-id')
  return value && value.trim().length > 0 ? value.trim() : undefined
}

function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController()
  let responseFinished = false
  const abort = () => {
    if (!responseFinished && !controller.signal.aborted) {
      controller.abort(new Error('HTTP request closed before response finished'))
    }
  }
  res.once('finish', () => {
    responseFinished = true
    req.off('aborted', abort)
    req.off('close', abort)
  })
  req.once('aborted', abort)
  req.once('close', abort)
  return controller.signal
}

async function withLiveSession(
  context: CommanderRoutesContext,
  conversation: Conversation,
  canonicalOrder = 0,
): Promise<ConversationSummaryDTO> {
  const commander = await context.sessionStore.get(conversation.commanderId)
  return buildConversationSummaryDTO(context, conversation, canonicalOrder, commander)
}

async function withInitialMessagePage(
  context: CommanderRoutesContext,
  conversation: Conversation,
  canonicalOrder = 0,
): Promise<ConversationSummaryDTO> {
  return {
    ...await withLiveSession(context, conversation, canonicalOrder),
    initialMessagePage: await getConversationMessagesPage(context, conversation, {
      limit: DEFAULT_CONVERSATION_MESSAGES_LIMIT,
    }),
  }
}

type ConversationBootstrapResult =
  | {
    ok: true
    conversation: Conversation
  }
  | {
    ok: false
    error: string
    status?: number
    code?: string
  }

interface ConversationBootstrapLaunch {
  generation: number
  completion: Promise<ConversationBootstrapResult>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms)
  })
}

async function awaitBootstrapFastPath(
  completion: Promise<ConversationBootstrapResult>,
): Promise<ConversationBootstrapResult | null> {
  return Promise.race([
    completion,
    wait(CONVERSATION_BOOTSTRAP_FAST_PATH_MS),
  ])
}

function fireImmediateResumeHeartbeat(
  context: CommanderRoutesContext,
  conversation: Pick<Conversation, 'id'>,
): void {
  if (!context.heartbeatManager.isRunning(conversation.id)) {
    return
  }
  context.heartbeatManager.fireManual(conversation.id, context.now().toISOString())
}

function launchConversationBootstrap(
  context: CommanderRoutesContext,
  conversation: Conversation,
  operation: 'start' | 'resume',
  spawnOptions?: ConversationSpawnOptions,
): ConversationBootstrapLaunch {
  const overlay = beginConversationBootstrap(
    conversation.id,
    operation,
    context.now().toISOString(),
  )
  const generation = overlay.generation
  const completion = (async (): Promise<ConversationBootstrapResult> => {
    try {
      const started = await startConversationSession(
        context,
        conversation.commanderId,
        {
          ...conversation,
          status: 'idle',
        },
        null,
        spawnOptions,
        undefined,
        false,
        0,
        {
          onConversationActivated: () => {
            if (!conversationBootstrapCancelRequested(conversation.id, generation)) {
              completeConversationBootstrap(conversation.id, generation)
            }
          },
        },
      )
      if (!started.sent) {
        failConversationBootstrap(
          conversation.id,
          generation,
          'Conversation session could not be started',
          context.now().toISOString(),
        )
        return { ok: false, error: 'Conversation session could not be started' }
      }

      if (conversationBootstrapCancelRequested(conversation.id, generation)) {
        const cancelStatus = getConversationBootstrapCancelStatus(conversation.id, generation) ?? 'idle'
        const stopped = await stopConversationSession(context, started.conversation, cancelStatus)
        completeConversationBootstrap(conversation.id, generation)
        return {
          ok: true,
          conversation: stopped ?? started.conversation,
        }
      }

      completeConversationBootstrap(conversation.id, generation)
      if (operation === 'resume') {
        fireImmediateResumeHeartbeat(context, started.conversation)
      }
      const refreshed = await context.conversationStore.get(conversation.id)
      return {
        ok: true,
        conversation: refreshed ?? started.conversation,
      }
    } catch (error) {
      const detail = errorMessage(error)
      try {
        if (getLiveConversationSession(context, conversation)) {
          await stopConversationSession(context, conversation, 'idle')
        } else {
          await context.conversationStore.update(conversation.id, (current) => (
            current.status === 'archived'
              ? current
              : {
                  ...current,
                  status: 'idle',
                }
          ))
          await updateCommanderDerivedState(context, conversation.commanderId)
        }
      } catch (cleanupError) {
        console.warn(
          `[conversations] Failed to clean up bootstrap failure for "${conversation.id}":`,
          cleanupError,
        )
      }
      failConversationBootstrap(
        conversation.id,
        generation,
        detail,
        context.now().toISOString(),
      )
      return {
        ok: false,
        error: detail,
        ...(isProviderLaunchError(error) ? { status: error.statusCode } : {}),
        ...(isProviderLaunchError(error) && error.code ? { code: error.code } : {}),
      }
    }
  })()

  return { generation, completion }
}

function conversationStatusPriority(status: Conversation['status']): number {
  switch (status) {
    case 'active':
      return 0
    case 'idle':
      return 1
    case 'archived':
      return 3
    default:
      return 4
  }
}

function buildConversationCanonicalOrder(conversations: readonly Conversation[]): Map<string, number> {
  const ordered = [...conversations].sort((left, right) => {
    const statusDelta = conversationStatusPriority(left.status) - conversationStatusPriority(right.status)
    if (statusDelta !== 0) {
      return statusDelta
    }

    const lastMessageDelta = Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt)
    if (Number.isFinite(lastMessageDelta) && lastMessageDelta !== 0) {
      return lastMessageDelta
    }

    const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    if (Number.isFinite(createdDelta) && createdDelta !== 0) {
      return createdDelta
    }

    return left.id.localeCompare(right.id)
  })

  return new Map(ordered.map((conversation, index) => [conversation.id, index]))
}

function sendConversationListSerializationFailure(res: Response, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  res.status(500).json({
    error: 'Conversation list serialization failed',
    detail,
  })
}

async function buildCommanderConversationBootstrapProjection(
  context: CommanderRoutesContext,
  commanderId: string,
  selectedConversationId: string | null,
): Promise<CommanderConversationBootstrapProjection> {
  const [conversations, activeChat] = await Promise.all([
    context.conversationStore.listByCommander(commanderId),
    context.conversationStore.getActiveChatForCommander(commanderId),
  ])
  const selectedId = selectedConversationId ?? activeChat?.id ?? null
  const selectedConversation = selectedId
    ? conversations.find((conversation) => conversation.id === selectedId) ?? null
    : null
  if (selectedId && !selectedConversation) {
    throw new Error(`Conversation "${selectedId}" does not belong to commander "${commanderId}"`)
  }

  const canonicalOrder = buildConversationCanonicalOrder(conversations)
  const summaries = await Promise.all(conversations.map((conversation) => (
    conversation.id === selectedId
      ? withInitialMessagePage(context, conversation, canonicalOrder.get(conversation.id) ?? 0)
      : Promise.resolve(withLiveSession(context, conversation, canonicalOrder.get(conversation.id) ?? 0))
  )))
  return {
    commanderId,
    conversations: summaries,
    activeConversation: activeChat
      ? summaries.find((conversation) => conversation.id === activeChat.id) ?? null
      : null,
    selectedConversation: selectedId
      ? summaries.find((conversation) => conversation.id === selectedId) ?? null
      : null,
    selectedConversationId: selectedId,
  }
}

async function archiveConversation(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<Conversation> {
  requestConversationBootstrapCancel(conversation.id, context.now().toISOString(), 'archived')
  const updated = getLiveConversationSession(context, conversation)
    ? await stopConversationSession(context, conversation, 'archived')
    : await (async () => {
        context.heartbeatManager.stop(conversation.id)
        return context.conversationStore.update(conversation.id, (current) => ({
          ...current,
          status: 'archived',
          lastMessageAt: new Date().toISOString(),
        }))
      })()
  await updateCommanderDerivedState(context, conversation.commanderId)
  return updated ?? conversation
}

function listCommanderConversationNames(
  conversations: readonly Conversation[],
  conversationId: string,
): string[] {
  return conversations
    .filter((entry) => entry.id !== conversationId)
    .map((entry) => entry.name)
}

function buildConversationTranscriptPaths(
  context: CommanderRoutesContext,
  conversation: Conversation,
): string[] {
  const sessionsRoot = path.join(
    resolveCommanderPaths(conversation.commanderId, context.commanderDataDir).commanderRoot,
    'sessions',
  )
  const transcriptIds = new Set<string>()
  transcriptIds.add(buildConversationSessionName(conversation))
  const providerContext = conversation.providerContext as {
    providerId?: string
    sessionId?: string
    threadId?: string
  } | undefined
  for (const candidate of [
    providerContext?.threadId,
    providerContext?.sessionId,
  ]) {
    const sanitized = candidate ? sanitizeTranscriptFileKey(candidate) : ''
    if (sanitized) {
      transcriptIds.add(sanitized)
    }
  }

  return [...transcriptIds].map((transcriptId) => path.join(sessionsRoot, `${transcriptId}.jsonl`))
}

async function hardDeleteConversation(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<void> {
  await context.conversationStore.delete(conversation.id)
  await deleteSessionTranscript(buildConversationSessionName(conversation))
  await Promise.all(
    buildConversationTranscriptPaths(context, conversation).map((transcriptPath) =>
      rm(transcriptPath, { force: true }),
    ),
  )
  await updateCommanderDerivedState(context, conversation.commanderId)
}

export function registerConversationRoutes(
  commanderRouter: import('express').Router,
  conversationRouter: import('express').Router,
  context: CommanderRoutesContext,
): void {
  commanderRouter.get('/:id/conversations/bootstrap', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const selectedConversationId = req.query.conversationId === undefined
      ? null
      : parseConversationId(req.query.conversationId)
    if (req.query.conversationId !== undefined && !selectedConversationId) {
      res.status(400).json({ error: 'conversationId must be a conversation id' })
      return
    }

    try {
      res.json(await buildCommanderConversationBootstrapProjection(
        context,
        commanderId,
        selectedConversationId,
      ))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (selectedConversationId && detail.includes(`Conversation "${selectedConversationId}"`)) {
        res.status(404).json({ error: detail })
        return
      }
      sendConversationListSerializationFailure(res, error)
    }
  })

  commanderRouter.get('/:id/conversations/active', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const activeChat = await context.conversationStore.getActiveChatForCommander(commanderId)
    try {
      res.json(activeChat ? await withInitialMessagePage(context, activeChat) : null)
    } catch (error) {
      sendConversationListSerializationFailure(res, error)
    }
  })

  commanderRouter.get('/:id/conversations', context.requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await context.sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const conversations = await context.conversationStore.listByCommander(commanderId)
    const initialMessagesFor = req.query.initialMessagesFor === undefined
      ? null
      : parseConversationId(req.query.initialMessagesFor)
    if (req.query.initialMessagesFor !== undefined && !initialMessagesFor) {
      res.status(400).json({ error: 'initialMessagesFor must be a conversation id' })
      return
    }
    try {
      const canonicalOrder = buildConversationCanonicalOrder(conversations)
      res.json(await Promise.all(conversations.map((conversation) => (
        conversation.id === initialMessagesFor
          ? withInitialMessagePage(context, conversation, canonicalOrder.get(conversation.id) ?? 0)
          : Promise.resolve(withLiveSession(context, conversation, canonicalOrder.get(conversation.id) ?? 0))
      ))))
    } catch (error) {
      sendConversationListSerializationFailure(res, error)
    }
  })

  commanderRouter.post('/:id/conversations', context.requireConversationCreateAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const commander = await context.sessionStore.get(commanderId)
    if (!commander) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const surface = parseConversationSurface(req.body?.surface)
    if (!surface) {
      res.status(400).json({ error: 'surface is required' })
      return
    }

    const requestedId = req.body?.id === undefined ? undefined : parseConversationId(req.body?.id)
    if (req.body?.id !== undefined && !requestedId) {
      res.status(400).json({ error: 'id must be a UUID when provided' })
      return
    }

    if (requestedId) {
      const collision = await context.conversationStore.get(requestedId)
      if (collision) {
        if (collision.commanderId !== commanderId) {
          res.status(409).json({
            error: `Conversation "${requestedId}" already belongs to commander "${collision.commanderId}"`,
          })
          return
        }
        res.status(409).json({ error: `Conversation "${requestedId}" already exists` })
        return
      }
    }

    const channelMeta = req.body?.channelMeta === undefined
      ? undefined
      : parseConversationChannelMeta(req.body?.channelMeta)
    if (req.body?.channelMeta !== undefined && !channelMeta) {
      res.status(400).json({ error: 'channelMeta is invalid' })
      return
    }

    const requestedAgentType = req.body?.agentType === undefined
      ? undefined
      : parseConversationAgentType(req.body?.agentType)
    if (req.body?.agentType !== undefined && !requestedAgentType) {
      res.status(400).json({ error: 'Invalid agentType. Expected a supported provider.' })
      return
    }

    const requestedModel = parseConversationModel(req.body?.model)
    if (!requestedModel.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }
    const requestedCredentialPoolId = parseConversationCredentialPoolId(
      req.body?.credentialPoolId,
    )
    if (!requestedCredentialPoolId.ok) {
      res.status(400).json({
        error: 'credentialPoolId must be a non-empty string of at most 128 characters',
      })
      return
    }
    const selectedAgentType = requestedAgentType ?? commander.agentType ?? resolveDefaultProviderId()
    if (
      requestedCredentialPoolId.value
      && resolveConversationCredentialSelectionMode(
        selectedAgentType,
        commander.executionMachineId,
      ) !== 'per-conversation'
    ) {
      res.status(400).json({
        error: 'credentialPoolId is not supported for local Claude conversations; select the global Claude credential in Settings',
      })
      return
    }
    const selectedProvider = getProvider(selectedAgentType)
    if (!selectedProvider) {
      res.status(400).json({ error: `Unknown provider: ${selectedAgentType}` })
      return
    }
    const modelDiscoveryContext = requestedCredentialPoolId.value
      ? { credentialPoolId: requestedCredentialPoolId.value }
      : {}
    const createModels = getCachedProviderModelsForValidation(
      selectedProvider,
      modelDiscoveryContext,
    )
    const selectedDefaults = resolveProviderDefaults(selectedProvider, createModels.models)
    const commanderAgentType = commander.agentType ?? resolveDefaultProviderId()
    const sameCommanderProvider = commanderAgentType === selectedAgentType
    const inheritedCommanderModel = sameCommanderProvider && commander.model
      ? commander.model
      : undefined
    const selectedModelValue = requestedModel.value === undefined
      ? inheritedCommanderModel ?? selectedDefaults.model
      : requestedModel.value ?? selectedDefaults.model
    const inheritedModelIsAvailable = !inheritedCommanderModel
      || Boolean(findProviderModelOption(createModels.models, inheritedCommanderModel))
      || createModels.supportsCustomModels
    const effectiveSelectedModel = requestedModel.value === undefined && !inheritedModelIsAvailable
      ? selectedDefaults.model
      : selectedModelValue
    const modelValidation = validateModelForAgentType(
      selectedAgentType,
      effectiveSelectedModel,
      modelDiscoveryContext,
    )
    if (!modelValidation.ok) {
      res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
      return
    }
    const selectedModel = findProviderModelOption(
      createModels.models,
      effectiveSelectedModel,
    )
    const selectedEffortLevels = getAgentEffortLevelsForModel(
      selectedAgentType,
      selectedModel,
    )
    const selectedModelSupportsEffort = selectedProvider.uiCapabilities.supportsEffort
      && selectedEffortLevels.length > 0
    const selectedModelSupportsAdaptiveThinking = selectedProvider.uiCapabilities.supportsAdaptiveThinking
      && selectedModel?.supportsAdaptiveThinking !== false

    const parsedEffort = parseOptionalAgentEffort(selectedAgentType, req.body?.effort)
    if (req.body?.effort !== undefined && parsedEffort === null) {
      res.status(400).json({
        error: `Invalid effort for provider "${selectedAgentType}". Expected one of: ${getAgentEffortLevels(selectedAgentType).join(', ')}`,
      })
      return
    }
    if (req.body?.effort !== undefined && !selectedModelSupportsEffort) {
      res.status(400).json({ error: `Model "${selectedModel?.label ?? selectedAgentType}" does not support effort` })
      return
    }
    if (parsedEffort && selectedEffortLevels.length > 0 && !selectedEffortLevels.includes(parsedEffort)) {
      res.status(400).json({
        error: `Invalid effort for model "${selectedModel?.label ?? selectedAgentType}". Expected one of: ${selectedEffortLevels.join(', ')}`,
      })
      return
    }
    const hasEffortField = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'effort')
    const defaultEffort = getDefaultAgentEffortForModel(
      selectedAgentType,
      selectedModel,
      selectedDefaults.effort,
    )
    const commanderProviderContext = sameCommanderProvider
      ? commander.providerContext as { effort?: unknown; adaptiveThinking?: unknown; maxThinkingTokens?: unknown } | undefined
      : undefined
    const commanderEffort = parseStoredAgentEffort(
      selectedAgentType,
      commander.effort ?? commanderProviderContext?.effort,
    )
    const effort = selectedModelSupportsEffort
      ? hasEffortField
        ? parsedEffort ?? defaultEffort
        : commanderEffort && selectedEffortLevels.includes(commanderEffort)
          ? commanderEffort
          : defaultEffort
      : undefined

    const parsedAdaptiveThinking = parseClaudeAdaptiveThinking(req.body?.adaptiveThinking)
    if (req.body?.adaptiveThinking !== undefined && parsedAdaptiveThinking === null) {
      res.status(400).json({ error: 'Invalid adaptiveThinking. Expected one of: enabled, disabled' })
      return
    }
    if (req.body?.adaptiveThinking !== undefined && !selectedModelSupportsAdaptiveThinking) {
      res.status(400).json({ error: `Model "${selectedModel?.label ?? selectedAgentType}" does not support adaptiveThinking` })
      return
    }
    const hasAdaptiveThinkingField = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'adaptiveThinking',
    )
    const commanderAdaptiveThinking = sameCommanderProvider
      ? commander.adaptiveThinking
        ?? (commanderProviderContext?.adaptiveThinking as typeof parsedAdaptiveThinking)
      : undefined
    const adaptiveThinking = selectedModelSupportsAdaptiveThinking
      ? hasAdaptiveThinkingField
        ? parsedAdaptiveThinking ?? selectedDefaults.adaptiveThinking
        : commanderAdaptiveThinking ?? selectedDefaults.adaptiveThinking
      : undefined

    const parsedMaxThinkingTokens = parseClaudeMaxThinkingTokens(req.body?.maxThinkingTokens)
    if (req.body?.maxThinkingTokens !== undefined && parsedMaxThinkingTokens === null) {
      res.status(400).json({ error: 'Invalid maxThinkingTokens. Expected integer 1024..256000' })
      return
    }
    if (req.body?.maxThinkingTokens !== undefined && !selectedProvider?.uiCapabilities.supportsMaxThinkingTokens) {
      res.status(400).json({ error: `Provider "${selectedAgentType}" does not support maxThinkingTokens` })
      return
    }
    const hasMaxThinkingTokensField = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'maxThinkingTokens',
    )
    const commanderMaxThinkingTokens = sameCommanderProvider
      ? commander.maxThinkingTokens
        ?? (typeof commanderProviderContext?.maxThinkingTokens === 'number'
          ? commanderProviderContext.maxThinkingTokens
          : undefined)
      : undefined
    const maxThinkingTokens = selectedProvider.uiCapabilities.supportsMaxThinkingTokens
      ? hasMaxThinkingTokensField
        ? parsedMaxThinkingTokens ?? selectedDefaults.maxThinkingTokens
        : commanderMaxThinkingTokens ?? selectedDefaults.maxThinkingTokens
      : undefined

    const providerContext = createProviderContextForAgentType(selectedAgentType, {
      effort,
      omitEffort: selectedAgentType === 'claude' && !selectedModelSupportsEffort,
      adaptiveThinking,
      maxThinkingTokens,
    })

    const nowIso = context.now().toISOString()
    const created = await context.conversationStore.create({
      ...(requestedId ? { id: requestedId } : {}),
      commanderId: commander.id,
      surface,
      ...(channelMeta ? { channelMeta } : {}),
      agentType: selectedAgentType,
      model: effectiveSelectedModel,
      ...(requestedCredentialPoolId.value
        ? { credentialPoolId: requestedCredentialPoolId.value }
        : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
      ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
      ...(providerContext ? { providerContext } : {}),
      status: 'idle',
      currentTask: null,
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      completedTasks: 0,
      totalCostUsd: 0,
      creationSource: surface === 'cli' ? 'cli' : surface === 'api' ? 'api' : 'ui',
      createdByKind: requestActorKind(req),
      ...(requestActorId(req) ? { createdById: requestActorId(req) } : {}),
      ...(requestId(req) ? { requestId: requestId(req) } : {}),
      createdAt: nowIso,
      lastMessageAt: nowIso,
    })

    res.status(201).json(await withLiveSession(context, created))
  })

  conversationRouter.patch('/:convId', context.requireWorkerDispatchAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const conversation = await context.conversationStore.get(conversationId)
    if (!conversation) {
      res.status(404).json({ error: `Conversation "${conversationId}" not found` })
      return
    }

    const requestBody = isObject(req.body) ? req.body : {}
    const rawRuntimeSettings = requestBody.runtimeSettings
    if (rawRuntimeSettings !== undefined && !isObject(rawRuntimeSettings)) {
      res.status(400).json({ error: 'runtimeSettings must be an object when provided' })
      return
    }
    const runtimeSettingsBody = isObject(rawRuntimeSettings) ? rawRuntimeSettings : {}
    const hasOwn = (record: Record<string, unknown>, key: string) => (
      Object.prototype.hasOwnProperty.call(record, key)
    )
    const readRuntimeField = (key: string): { provided: boolean; value: unknown } => {
      if (hasOwn(runtimeSettingsBody, key)) {
        return { provided: true, value: runtimeSettingsBody[key] }
      }
      if (hasOwn(requestBody, key)) {
        return { provided: true, value: requestBody[key] }
      }
      return { provided: false, value: undefined }
    }

    const agentTypeField = readRuntimeField('agentType')
    const providerField = readRuntimeField('provider')
    if (
      agentTypeField.provided
      && providerField.provided
      && agentTypeField.value !== providerField.value
    ) {
      res.status(400).json({ error: 'runtimeSettings.agentType and runtimeSettings.provider must match' })
      return
    }
    const runtimeAgentTypeField = agentTypeField.provided ? agentTypeField : providerField
    const modelField = readRuntimeField('model')
    const credentialPoolIdField = readRuntimeField('credentialPoolId')
    const effortField = readRuntimeField('effort')
    const adaptiveThinkingField = readRuntimeField('adaptiveThinking')
    const maxThinkingTokensField = readRuntimeField('maxThinkingTokens')
    const hasRuntimeSettingsUpdate = runtimeAgentTypeField.provided
      || modelField.provided
      || credentialPoolIdField.provided
      || effortField.provided
      || adaptiveThinkingField.provided
      || maxThinkingTokensField.provided

    const requestedName = req.body?.name === undefined
      ? undefined
      : parseConversationName(req.body?.name)
    if (req.body?.name !== undefined && !requestedName) {
      res.status(400).json({ error: 'name must be a trimmed string between 1 and 64 characters' })
      return
    }

    const requestedAgentType = !runtimeAgentTypeField.provided
      ? undefined
      : parseConversationAgentType(runtimeAgentTypeField.value)
    if (runtimeAgentTypeField.provided && !requestedAgentType) {
      res.status(400).json({ error: 'Invalid agentType. Expected a supported provider.' })
      return
    }

    const requestedModel = parseConversationModel(modelField.provided ? modelField.value : undefined)
    if (!requestedModel.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }
    const requestedCredentialPoolId = credentialPoolIdField.provided
      ? parseConversationCredentialPoolId(credentialPoolIdField.value)
      : { ok: true as const, value: undefined }
    if (!requestedCredentialPoolId.ok) {
      res.status(400).json({
        error: 'credentialPoolId must be a non-empty string of at most 128 characters',
      })
      return
    }

    const requestedStatus = req.body?.status === undefined
      ? undefined
      : parseConversationStatus(req.body?.status)
    if (req.body?.status !== undefined && requestedStatus !== 'archived') {
      res.status(400).json({ error: 'status only supports "archived" on this route' })
      return
    }

    if (
      requestedName === undefined
      && !hasRuntimeSettingsUpdate
      && requestedStatus === undefined
    ) {
      res.status(400).json({ error: 'At least one of name, runtimeSettings, agentType, model, or status is required' })
      return
    }

    if (requestedName && !conversationNamesEqual(requestedName, conversation.name)) {
      const commanderConversations = await context.conversationStore.listByCommander(conversation.commanderId)
      const collision = listCommanderConversationNames(commanderConversations, conversation.id)
        .some((existingName) => conversationNamesEqual(existingName, requestedName))
      if (collision) {
        res.status(409).json({
          error: `Conversation name "${requestedName}" already exists for commander "${conversation.commanderId}"`,
        })
        return
      }
    }

    const commander = await context.sessionStore.get(conversation.commanderId)
    const currentAgentType = conversation.agentType ?? commander?.agentType ?? resolveDefaultProviderId()
    const nextAgentType = requestedAgentType ?? currentAgentType
    const providerChanged = nextAgentType !== currentAgentType
    const nextProvider = getProvider(nextAgentType)
    if (!nextProvider) {
      res.status(400).json({ error: `Unknown provider: ${nextAgentType}` })
      return
    }
    const liveSession = getLiveConversationSession(context, conversation)
    const credentialSelectionAllowed = resolveConversationCredentialSelectionMode(
      nextAgentType,
      liveSession?.host ?? commander?.executionMachineId,
    ) === 'per-conversation'
    if (credentialPoolIdField.provided && !credentialSelectionAllowed) {
      res.status(400).json({
        error: 'credentialPoolId is not supported for local Claude conversations; select the global Claude credential in Settings',
      })
      return
    }
    const currentCredentialPoolId = credentialSelectionAllowed
      ? liveSession?.agentType === nextAgentType
        ? liveSession.credentialPoolId
        : conversation.agentType === nextAgentType
          ? conversation.credentialPoolId
          : undefined
      : undefined
    const credentialPoolId = requestedCredentialPoolId.value
      ?? (providerChanged
        ? undefined
        : currentCredentialPoolId)
    const credentialPoolChanged = providerChanged
      || credentialPoolId !== currentCredentialPoolId
    const modelAccountId = !credentialPoolChanged && liveSession?.agentType === nextAgentType
      ? liveSession.providerAuthSnapshot?.accountId ?? liveSession.providerAuthSnapshot?.accountEmail
      : undefined
    const resolvedModels = getCachedProviderModelsForValidation(nextProvider, {
      credentialPoolId,
      ...(modelAccountId ? { accountId: modelAccountId } : {}),
    })
    const providerDefaults = resolveProviderDefaults(nextProvider, resolvedModels.models)
    const nextModel = requestedModel.value !== undefined
      ? requestedModel.value
      : providerChanged
        ? null
        : conversation.model ?? null
    const usesTrustedStoredModel = !providerChanged
      && !credentialPoolChanged
      && typeof conversation.model === 'string'
      && nextModel === conversation.model
      && (!modelField.provided || requestedModel.value === conversation.model)
    if ((providerChanged || modelField.provided || credentialPoolChanged) && !usesTrustedStoredModel) {
      const modelValidation = validateModelForAgentType(nextAgentType, nextModel, {
        credentialPoolId,
        ...(modelAccountId ? { accountId: modelAccountId } : {}),
      })
      if (!modelValidation.ok) {
        res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
        return
      }
    }
    const effectiveNextModel = nextModel ?? providerDefaults.model
    const modelOption = findProviderModelOption(resolvedModels.models, effectiveNextModel)
    const supportedEffortLevels = getAgentEffortLevelsForModel(nextAgentType, modelOption)
    const storedModelOmitsEffort = usesTrustedStoredModel
      && asClaudeProviderContext(conversation.providerContext)?.omitEffort === true
    const modelSupportsEffort = nextProvider.uiCapabilities.supportsEffort
      && !storedModelOmitsEffort
      && supportedEffortLevels.length > 0
    const modelSupportsAdaptiveThinking = nextProvider.uiCapabilities.supportsAdaptiveThinking
      && modelOption?.supportsAdaptiveThinking !== false
    const currentModel = liveSession?.model ?? conversation.model ?? providerDefaults.model
    const modelChanged = providerChanged
      || effectiveNextModel !== currentModel
      || credentialPoolChanged

    const parsedEffort = effortField.provided
      ? parseOptionalAgentEffort(nextAgentType, effortField.value)
      : undefined
    if (effortField.provided && parsedEffort === null) {
      res.status(400).json({
        error: `Invalid effort for provider "${nextAgentType}". Expected one of: ${getAgentEffortLevels(nextAgentType).join(', ')}`,
      })
      return
    }
    if (effortField.provided && !modelSupportsEffort) {
      res.status(400).json({
        error: modelOption || storedModelOmitsEffort
          ? `Model "${modelOption?.label ?? effectiveNextModel}" does not support effort`
          : `Provider "${nextAgentType}" does not support effort`,
      })
      return
    }
    if (parsedEffort && !supportedEffortLevels.includes(parsedEffort)) {
      res.status(400).json({
        error: `Invalid effort for model "${modelOption?.label ?? effectiveNextModel ?? nextAgentType}". Expected one of: ${supportedEffortLevels.join(', ')}`,
      })
      return
    }

    const parsedAdaptiveThinking = adaptiveThinkingField.provided
      ? parseClaudeAdaptiveThinking(adaptiveThinkingField.value)
      : undefined
    if (adaptiveThinkingField.provided && parsedAdaptiveThinking === null) {
      res.status(400).json({ error: 'Invalid adaptiveThinking. Expected one of: enabled, disabled' })
      return
    }
    if (adaptiveThinkingField.provided && !modelSupportsAdaptiveThinking) {
      res.status(400).json({
        error: modelOption
          ? `Model "${modelOption.label}" does not support adaptiveThinking`
          : `Provider "${nextAgentType}" does not support adaptiveThinking`,
      })
      return
    }

    const parsedMaxThinkingTokens = maxThinkingTokensField.provided
      ? parseClaudeMaxThinkingTokens(maxThinkingTokensField.value)
      : undefined
    if (maxThinkingTokensField.provided && parsedMaxThinkingTokens === null) {
      res.status(400).json({ error: 'Invalid maxThinkingTokens. Expected integer 1024..256000' })
      return
    }
    if (maxThinkingTokensField.provided && !nextProvider.uiCapabilities.supportsMaxThinkingTokens) {
      res.status(400).json({ error: `Provider "${nextAgentType}" does not support maxThinkingTokens` })
      return
    }

    const storedProviderContext = conversation.providerContext as {
      effort?: unknown
      adaptiveThinking?: unknown
      maxThinkingTokens?: unknown
    } | undefined
    const currentEffort = liveSession?.effort
      ?? conversation.effort
      ?? parseStoredAgentEffort(nextAgentType, storedProviderContext?.effort)
      ?? undefined
    const defaultEffort = getDefaultAgentEffortForModel(
      nextAgentType,
      modelOption,
      providerDefaults.effort,
    )
    const nextEffort = modelSupportsEffort
      ? effortField.provided
        ? parsedEffort ?? defaultEffort
        : providerChanged || modelChanged
          ? defaultEffort
          : currentEffort && supportedEffortLevels.includes(currentEffort)
            ? currentEffort
            : defaultEffort
      : undefined
    const nextAdaptiveThinking = modelSupportsAdaptiveThinking
      ? adaptiveThinkingField.provided
        ? parsedAdaptiveThinking ?? providerDefaults.adaptiveThinking
        : providerChanged || modelChanged
          ? providerDefaults.adaptiveThinking
          : liveSession?.adaptiveThinking
            ?? conversation.adaptiveThinking
            ?? (storedProviderContext?.adaptiveThinking as typeof parsedAdaptiveThinking)
            ?? providerDefaults.adaptiveThinking
      : undefined
    const nextMaxThinkingTokens = nextProvider.uiCapabilities.supportsMaxThinkingTokens
      ? maxThinkingTokensField.provided
        ? parsedMaxThinkingTokens ?? providerDefaults.maxThinkingTokens
        : providerChanged
          ? providerDefaults.maxThinkingTokens
          : liveSession?.maxThinkingTokens
            ?? conversation.maxThinkingTokens
            ?? (typeof storedProviderContext?.maxThinkingTokens === 'number'
              ? storedProviderContext.maxThinkingTokens
              : undefined)
            ?? providerDefaults.maxThinkingTokens
      : undefined

    let updated = conversation
    if (hasRuntimeSettingsUpdate) {
      try {
        updated = await updateConversationRuntimeSettings(context, updated, {
          agentType: nextAgentType,
          ...(modelField.provided || providerChanged ? { model: effectiveNextModel } : {}),
          credentialPoolId,
          effort: nextEffort,
          adaptiveThinking: nextAdaptiveThinking,
          maxThinkingTokens: nextMaxThinkingTokens,
        })
      } catch (error) {
        if (error instanceof ConversationProviderSwapConflictError) {
          res.status(409).json({ error: error.message })
          return
        }
        if (error instanceof ConversationProviderSwapUnavailableError) {
          res.status(503).json({ error: error.message })
          return
        }
        if (isProviderLaunchError(error)) {
          res.status(error.statusCode).json({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
          })
          return
        }
        throw error
      }
    }

    if (requestedStatus === 'archived' && updated.status !== 'archived') {
      updated = await archiveConversation(context, updated)
    }

    if (requestedName && !conversationNamesEqual(requestedName, updated.name)) {
      updated = await context.conversationStore.update(updated.id, (current) => ({
        ...current,
        name: requestedName,
        lastMessageAt: new Date().toISOString(),
      })) ?? updated
    }

    res.json(await withLiveSession(context, updated))
  })

  conversationRouter.get('/:convId', context.requireReadAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const conversation = await context.conversationStore.get(conversationId)
    if (!conversation) {
      res.status(404).json({ error: `Conversation "${conversationId}" not found` })
      return
    }

    res.json(await withLiveSession(context, conversation))
  })

  conversationRouter.get('/:convId/messages', context.requireReadAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const conversation = await context.conversationStore.get(conversationId)
    if (!conversation) {
      res.status(404).json({ error: `Conversation "${conversationId}" not found` })
      return
    }

    const limit = parseConversationMessagesLimit(req.query.limit)
    if (limit === null) {
      res.status(400).json({ error: 'limit must be a positive integer' })
      return
    }

    const before = parseConversationMessagesBefore(req.query.before)
    if (before === null) {
      res.status(400).json({ error: 'before must be a non-negative integer cursor' })
      return
    }

    try {
      res.json(await getConversationMessagesPage(context, conversation, { limit, before }))
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load conversation messages',
      })
    }
  })

  conversationRouter.post('/:convId/start', context.requireWorkerDispatchAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    if (
      Object.prototype.hasOwnProperty.call(body, 'cwd') ||
      Object.prototype.hasOwnProperty.call(body, 'host')
    ) {
      res.status(400).json({
        error: 'cwd and host are configured on the commander; remove from body',
      })
      return
    }

    const requestedAgentType = body.agentType === undefined
      ? undefined
      : parseConversationAgentType(body.agentType)
    if (body.agentType !== undefined && !requestedAgentType) {
      res.status(400).json({ error: 'Invalid agentType. Expected a registered provider id.' })
      return
    }

    const requestedModel = parseConversationModel(body.model)
    if (!requestedModel.ok) {
      res.status(400).json({ error: 'model must be a string or null when provided' })
      return
    }
    const parsedAdaptiveThinking = parseClaudeAdaptiveThinking(body.adaptiveThinking)
    if (body.adaptiveThinking !== undefined && parsedAdaptiveThinking === null) {
      res.status(400).json({ error: 'Invalid adaptiveThinking. Expected one of: enabled, disabled' })
      return
    }

    const parsedMaxThinkingTokens = parseClaudeMaxThinkingTokens(body.maxThinkingTokens)
    if (body.maxThinkingTokens !== undefined && parsedMaxThinkingTokens === null) {
      res.status(400).json({ error: 'Invalid maxThinkingTokens. Expected integer 1024..256000' })
      return
    }
    const maxThinkingTokens = parsedMaxThinkingTokens ?? undefined

    try {
      const conversation = await context.conversationStore.get(conversationId)
      if (!conversation) {
        res.status(404).json({ error: `Conversation "${conversationId}" not found` })
        return
      }
      if (getConversationRuntimeOverlay(conversation.id)?.state === 'starting') {
        res.status(202).json({
          conversation: await withLiveSession(context, conversation),
        })
        return
      }
      const liveSession = getLiveConversationSession(context, conversation)
      const canRecoverActiveNoLiveSession = conversation.status === 'active' && !liveSession
      if (conversation.status !== 'idle' && !canRecoverActiveNoLiveSession) {
        res.status(409).json({ error: `Conversation "${conversationId}" is not idle` })
        return
      }
      if (
        canRecoverActiveNoLiveSession
        && !conversation.agentType
      ) {
        res.status(409).json({
          error: `Conversation "${conversationId}" is active but missing agentType. Run the one-off Herd migration before resuming it.`,
        })
        return
      }
      if (
        canRecoverActiveNoLiveSession
        && requestedAgentType
        && conversation.agentType
        && requestedAgentType !== conversation.agentType
      ) {
        res.status(409).json({
          error: `Conversation "${conversationId}" is active; stop it before changing provider`,
        })
        return
      }
      if (
        canRecoverActiveNoLiveSession
        && requestedModel.value !== undefined
        && conversation.model !== undefined
        && requestedModel.value !== conversation.model
      ) {
        res.status(409).json({
          error: `Conversation "${conversationId}" is active; stop it before changing model`,
        })
        return
      }

      const costCap = await enforceCommanderCostCap(context, conversation.commanderId)
      if (!costCap.ok) {
        res.status(costCap.status).json(costCap.body)
        return
      }

      const commander = await context.sessionStore.get(conversation.commanderId)
      const agentType = requestedAgentType ?? conversation.agentType ?? commander?.agentType ?? resolveDefaultProviderId()
      const provider = getProvider(agentType)
      if (!provider) {
        res.status(400).json({ error: `Unknown provider: ${agentType}` })
        return
      }
      const credentialPoolId = resolveConversationCredentialSelectionMode(
        agentType,
        liveSession?.host ?? commander?.executionMachineId,
      ) === 'per-conversation'
        ? liveSession?.agentType === agentType
          ? liveSession.credentialPoolId
          : conversation.agentType === agentType
            ? conversation.credentialPoolId
            : undefined
        : undefined
      const modelAccountId = liveSession?.agentType === agentType
        ? liveSession.providerAuthSnapshot?.accountId ?? liveSession.providerAuthSnapshot?.accountEmail
        : undefined
      const modelContext = {
        credentialPoolId,
        ...(modelAccountId ? { accountId: modelAccountId } : {}),
      }
      const resolvedModels = getCachedProviderModelsForValidation(provider, modelContext)
      const providerDefaults = resolveProviderDefaults(provider, resolvedModels.models)
      const commanderAgentType = commander?.agentType ?? resolveDefaultProviderId()
      const hasStoredConversationModel = conversation.agentType === agentType
        && Object.prototype.hasOwnProperty.call(conversation, 'model')
        && conversation.model !== undefined
      const selectedModelValue = requestedModel.value !== undefined
        ? requestedModel.value ?? providerDefaults.model
        : hasStoredConversationModel
          ? conversation.model ?? providerDefaults.model
          : commanderAgentType === agentType
            ? commander?.model ?? providerDefaults.model
            : providerDefaults.model
      const usesTrustedStoredModel = hasStoredConversationModel
        && typeof conversation.model === 'string'
        && selectedModelValue === conversation.model
        && (requestedModel.value === undefined || requestedModel.value === conversation.model)
      const modelValidation = usesTrustedStoredModel
        ? { ok: true as const }
        : validateModelForAgentType(agentType, selectedModelValue, modelContext)
      if (!modelValidation.ok) {
        res.status(400).json({ error: modelValidation.error, validIds: modelValidation.validIds })
        return
      }
      const modelOption = findProviderModelOption(resolvedModels.models, selectedModelValue)
      const supportedEffortLevels = getAgentEffortLevelsForModel(agentType, modelOption)
      const storedModelOmitsEffort = usesTrustedStoredModel
        && asClaudeProviderContext(conversation.providerContext)?.omitEffort === true
      const modelSupportsEffort = provider.uiCapabilities.supportsEffort
        && !storedModelOmitsEffort
        && supportedEffortLevels.length > 0
      const modelSupportsAdaptiveThinking = provider.uiCapabilities.supportsAdaptiveThinking
        && modelOption?.supportsAdaptiveThinking !== false
      const hasEffortField = Object.prototype.hasOwnProperty.call(body, 'effort')
      const parsedEffort = parseOptionalAgentEffort(agentType, body.effort)
      if (hasEffortField && parsedEffort === null) {
        res.status(400).json({
          error: `Invalid effort for provider "${agentType}". Expected one of: ${getAgentEffortLevels(agentType).join(', ')}`,
        })
        return
      }
      if (parsedEffort && !modelSupportsEffort) {
        res.status(400).json({
          error: modelOption || storedModelOmitsEffort
            ? `Model "${modelOption?.label ?? selectedModelValue}" does not support effort`
            : `Provider "${agentType}" does not support effort`,
        })
        return
      }
      if (parsedEffort && !supportedEffortLevels.includes(parsedEffort)) {
        res.status(400).json({
          error: `Invalid effort for model "${modelOption?.label ?? selectedModelValue ?? agentType}". Expected one of: ${supportedEffortLevels.join(', ')}`,
        })
        return
      }
      const defaultEffort = getDefaultAgentEffortForModel(
        agentType,
        modelOption,
        providerDefaults.effort,
      )
      const effort = modelSupportsEffort ? parsedEffort ?? defaultEffort : undefined

      const hasAdaptiveThinkingField = Object.prototype.hasOwnProperty.call(body, 'adaptiveThinking')
      if (parsedAdaptiveThinking && !modelSupportsAdaptiveThinking) {
        res.status(400).json({
          error: modelOption
            ? `Model "${modelOption.label}" does not support adaptiveThinking`
            : `Provider "${agentType}" does not support adaptiveThinking`,
        })
        return
      }
      const adaptiveThinking = modelSupportsAdaptiveThinking
        ? parsedAdaptiveThinking ?? providerDefaults.adaptiveThinking
        : undefined

      const hasMaxThinkingTokensField = Object.prototype.hasOwnProperty.call(body, 'maxThinkingTokens')
      if (maxThinkingTokens !== undefined && !provider.uiCapabilities.supportsMaxThinkingTokens) {
        res.status(400).json({ error: `Provider "${agentType}" does not support maxThinkingTokens` })
        return
      }
      const effectiveMaxThinkingTokens = provider.uiCapabilities.supportsMaxThinkingTokens
        ? maxThinkingTokens ?? providerDefaults.maxThinkingTokens
        : undefined

      const spawnOptions: ConversationSpawnOptions = {
        ...(requestedAgentType ? { agentType: requestedAgentType } : {}),
        ...(requestedModel.value !== undefined ? { model: selectedModelValue } : {}),
        ...(hasEffortField ? { effort } : {}),
        ...(hasAdaptiveThinkingField ? { adaptiveThinking } : {}),
        ...(hasMaxThinkingTokensField ? { maxThinkingTokens: effectiveMaxThinkingTokens } : {}),
      }

      const launch = launchConversationBootstrap(
        context,
        conversation,
        canRecoverActiveNoLiveSession ? 'resume' : 'start',
        spawnOptions,
      )
      const fastResult = await awaitBootstrapFastPath(launch.completion)
      if (!fastResult) {
        const latest = await context.conversationStore.get(conversation.id)
        res.status(202).json({
          conversation: await withLiveSession(context, latest ?? conversation),
        })
        return
      }
      if (!fastResult.ok) {
        res.status(fastResult.status ?? 503).json({
          error: fastResult.error,
          ...(fastResult.code ? { code: fastResult.code } : {}),
        })
        return
      }

      res.status(200).json({
        conversation: await withLiveSession(context, fastResult.conversation),
      })
    } catch (error) {
      res.status(isProviderLaunchError(error) ? error.statusCode : 503).json({
        error: errorMessage(error),
        ...(isProviderLaunchError(error) && error.code ? { code: error.code } : {}),
      })
    }
  })

  conversationRouter.post('/:convId/message', context.requireWorkerDispatchAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const parsedImages = parseMessageImagesForRequest(req.body?.images)
    if (!parsedImages.ok) {
      res.status(parsedImages.status).json({ error: parsedImages.error })
      return
    }
    const images = parsedImages.images
    const workspaceContext = readWorkspaceContextPayload(req.body?.workspaceContext)
    const rawClientSendId = typeof req.body?.clientSendId === 'string'
      ? req.body.clientSendId.trim()
      : ''
    const clientSendId = rawClientSendId.length > 0 ? rawClientSendId : undefined
    if (!message && images.length === 0 && !hasWorkspaceContextPayload(workspaceContext)) {
      res.status(400).json({ error: 'message must be a non-empty string or images must be provided' })
      return
    }
    const queue = req.body?.queue === true

    const conversation = await context.conversationStore.get(conversationId)
    if (!conversation) {
      res.status(404).json({ error: `Conversation "${conversationId}" not found` })
      return
    }
    if (conversation.status === 'archived') {
      res.status(409).json({ error: `Conversation "${conversationId}" is archived` })
      return
    }
    const runtimeOverlay = getConversationRuntimeOverlay(conversation.id)
    if (runtimeOverlay?.state === 'starting') {
      res.status(409).json({ error: `Conversation "${conversationId}" is starting` })
      return
    }
    if (runtimeOverlay?.state === 'failed') {
      res.status(409).json({ error: 'Conversation start failed' })
      return
    }
    const shouldAutoStartIdleTextSend = conversation.status === 'idle' && !queue && images.length === 0
    if (conversation.status === 'idle' && queue) {
      res.status(409).json({ error: 'Conversation queue requires an active stream session' })
      return
    }
    if (conversation.status === 'idle' && images.length > 0) {
      res.status(409).json({ error: 'Conversation image transport requires an active stream session' })
      return
    }

    let messageWithContext: string
    try {
      messageWithContext = await applyWorkspaceContextToText({
        text: message,
        resolver: workspaceContext?.targetId ? context.getWorkspaceResolver?.() : undefined,
        context: workspaceContext,
      })
    } catch (error) {
      const workspaceError = toWorkspaceError(error)
      res.status(workspaceError.statusCode).json({ error: workspaceError.message })
      return
    }
    if (!messageWithContext && images.length === 0) {
      res.status(400).json({ error: 'message must be a non-empty string or images must be provided' })
      return
    }

    const dispatchChannelReplies = Boolean(conversation.channelMeta && conversation.lastRoute)
    const delivered = await deliverConversationMessage(
      context,
      conversation,
      { message: messageWithContext, displayMessage: message, images, clientSendId },
      {
        intent: queue ? 'queue' : 'interrupt',
        ...(queue ? { priority: 'normal' as const } : {}),
        ...(dispatchChannelReplies ? { dispatchChannelReplies: true } : {}),
        ...(shouldAutoStartIdleTextSend ? { autoStartIdle: true, autoStartSeedPrompt: false } : {}),
        abortSignal: requestAbortSignal(req, res),
      },
    )
    if (!delivered.ok) {
      res.status(delivered.status).json({
        error: delivered.error,
        ...(delivered.code ? { code: delivered.code } : {}),
        ...(delivered.retryable !== undefined ? { retryable: delivered.retryable } : {}),
      })
      return
    }
    let messagePage: Awaited<ReturnType<typeof getConversationMessagesPage>> | undefined
    try {
      messagePage = await getConversationMessagesPage(context, delivered.conversation)
    } catch (error) {
      console.warn(
        `[conversations] Failed to build post-send message page for "${conversation.id}":`,
        error,
      )
    }
    res.json({
      accepted: true,
      disposition: delivered.disposition,
      createdSession: delivered.createdSession,
      conversation: await withLiveSession(context, delivered.conversation),
      ...(delivered.operationId ? { operationId: delivered.operationId } : {}),
      ...(messagePage ? { messagePage } : {}),
    })
  })

  const handleStatusAction = (action: ConversationStatusAction) =>
    async (req: import('express').Request, res: import('express').Response): Promise<void> => {
      const conversationId = parseConversationId(req.params.convId)
      if (!conversationId) {
        res.status(400).json({ error: 'Invalid conversation id' })
        return
      }

      const conversation = await context.conversationStore.get(conversationId)
      if (!conversation) {
        res.status(404).json({ error: `Conversation "${conversationId}" not found` })
        return
      }

      if (action === 'pause') {
        // Archived conversations are terminal — pause must not silently
        // unarchive them. Return 409 so callers explicitly resume/archive
        // through the right path. See codex-review P2 on PR #1279
        // (comment 3175274914).
        if (conversation.status === 'archived') {
          res.status(409).json({
            error: `Conversation "${conversationId}" is archived`,
          })
          return
        }
        if (
          getConversationRuntimeOverlay(conversation.id)?.state === 'starting'
          && requestConversationBootstrapCancel(conversation.id, context.now().toISOString(), 'idle')
        ) {
          res.status(202).json(await withLiveSession(context, conversation))
          return
        }
        const updated = await stopConversationSession(context, conversation, 'idle')
        res.json(await withLiveSession(context, updated ?? conversation))
        return
      }

      if (action === 'archive') {
        res.json(await withLiveSession(context, await archiveConversation(context, conversation)))
        return
      }

      if (getConversationRuntimeOverlay(conversation.id)?.state === 'starting') {
        res.status(202).json(await withLiveSession(context, conversation))
        return
      }

      const liveSession = getLiveConversationSession(context, conversation)
      if (liveSession) {
        const commander = await context.sessionStore.get(conversation.commanderId)
        if (!commander) {
          res.status(404).json({ error: `Commander "${conversation.commanderId}" not found` })
          return
        }
        const updated = await context.conversationStore.update(conversation.id, (current) => ({
          ...current,
          status: 'active',
          lastMessageAt: new Date().toISOString(),
        }))
        await updateCommanderDerivedState(context, conversation.commanderId)
        if (!context.heartbeatManager.isRunning(conversation.id)) {
          context.heartbeatManager.start(
            conversation.id,
            conversation.commanderId,
            commander.heartbeat,
          )
        }
        fireImmediateResumeHeartbeat(context, conversation)
        res.json(await withLiveSession(context, updated ?? conversation))
        return
      }

      const costCap = await enforceCommanderCostCap(context, conversation.commanderId)
      if (!costCap.ok) {
        res.status(costCap.status).json(costCap.body)
        return
      }

      const launch = launchConversationBootstrap(context, conversation, 'resume')
      const fastResult = await awaitBootstrapFastPath(launch.completion)
      if (!fastResult) {
        const latest = await context.conversationStore.get(conversation.id)
        res.status(202).json(await withLiveSession(context, latest ?? conversation))
        return
      }
      if (!fastResult.ok) {
        res.status(fastResult.status ?? 503).json({
          error: fastResult.error,
          ...(fastResult.code ? { code: fastResult.code } : {}),
        })
        return
      }

      res.json(await withLiveSession(context, fastResult.conversation))
    }

  conversationRouter.post('/:convId/pause', context.requireWorkerDispatchAccess, handleStatusAction('pause'))
  conversationRouter.post('/:convId/resume', context.requireWorkerDispatchAccess, handleStatusAction('resume'))
  conversationRouter.post('/:convId/archive', context.requireWorkerDispatchAccess, handleStatusAction('archive'))

  conversationRouter.delete('/:convId', context.requireWorkerDispatchAccess, async (req, res) => {
    const conversationId = parseConversationId(req.params.convId)
    if (!conversationId) {
      res.status(400).json({ error: 'Invalid conversation id' })
      return
    }

    const conversation = await context.conversationStore.get(conversationId)
    if (!conversation) {
      res.status(404).json({ error: `Conversation "${conversationId}" not found` })
      return
    }

    if (req.query.hard === 'true') {
      requestConversationBootstrapCancel(conversation.id, context.now().toISOString(), 'archived')
      const archived = getLiveConversationSession(context, conversation)
        ? await stopConversationSession(context, conversation, 'archived')
        : conversation
      context.heartbeatManager.stop(conversation.id)
      await hardDeleteConversation(context, archived ?? conversation)
      res.json({
        deleted: true,
        hard: true,
        id: conversation.id,
        commanderId: conversation.commanderId,
      })
      return
    }

    res.json(await withLiveSession(context, await archiveConversation(context, conversation)))
  })
}
