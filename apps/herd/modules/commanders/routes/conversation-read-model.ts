import { liveSessionToApiPayload } from '../../agents/session/state.js'
import {
  getProvider,
  listProviders,
  resolveDefaultProviderId,
} from '../../agents/providers/registry.js'
import {
  resolveProviderDefaults,
  type ProviderModelDiscoveryMetadata,
  type ProviderModelOption,
} from '../../agents/providers/provider-adapter.js'
import { getCachedProviderModelsForValidation } from '../../agents/providers/model-discovery.js'
import { hasNativeProviderResumeIdentifier } from '../../agents/providers/native-resume.js'
import {
  getAgentEffortLevelsForModel,
  getDefaultAgentEffortForModel,
  parseStoredAgentEffort,
  type AgentEffortLevel,
} from '../../agents/effort.js'
import {
  CLAUDE_ADAPTIVE_THINKING_MODES,
  type ClaudeAdaptiveThinkingMode,
} from '../../claude-adaptive-thinking.js'
import {
  MAX_CLAUDE_MAX_THINKING_TOKENS,
  MIN_CLAUDE_MAX_THINKING_TOKENS,
} from '../../claude-max-thinking-tokens.js'
import type { AgentSession, AgentType, StreamSession } from '../../agents/types.js'
import type { ProviderSessionContext } from '../../agents/providers/provider-session-context.js'
import {
  buildDefaultCommanderConversationId,
  type CommanderSession,
} from '../store.js'
import type { Conversation } from '../conversation-store.js'
import type { CommanderRoutesContext } from './types.js'
import {
  buildConversationCredentialSelectionModes,
  type ConversationCredentialSelectionModes,
} from '../conversation-credential-selection.js'
import {
  buildConversationSessionName,
  getConversationRuntimeSettingsDisabledReason,
  getLiveConversationSession,
  type ConversationMessagesPage,
} from './conversation-runtime.js'
import {
  getConversationRuntimeOverlay,
  type ConversationRuntimeState,
} from './conversation-runtime-state.js'

type ConversationAction =
  | 'send'
  | 'queue'
  | 'media'
  | 'start'
  | 'pause'
  | 'resume'
  | 'archive'
  | 'delete'
  | 'updateProvider'
  | 'updateRuntimeSettings'

type ConversationDisabledReasons = Record<ConversationAction, string | null>
type ConversationAllowedActions = Record<ConversationAction, boolean>
type ConversationTransportType = 'stream' | 'pty' | 'external' | null

interface LiveConversationSessionLike {
  kind?: string
  host?: string
  agentType?: AgentType
  model?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: number
  credentialPoolId?: string
  providerAuthSnapshot?: {
    accountId?: string
    accountEmail?: string
  }
  providerContext?: ProviderSessionContext
}

function findRuntimeModelOption(
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

function hasSerializableStreamShape(
  liveSession: LiveConversationSessionLike,
): liveSession is StreamSession {
  const stream = liveSession as Partial<StreamSession>
  const clients = stream.clients as { size?: unknown } | undefined
  return liveSession.kind === 'stream'
    && Array.isArray(stream.events)
    && typeof clients?.size === 'number'
}

/**
 * Backend-owned conversation read model for Command Room clients.
 *
 * The DTO keeps the persisted conversation fields for compatibility, then adds
 * the projected lifecycle/sendability contract desktop and mobile should
 * consume instead of parsing session names or raw live-session process fields.
 */
export interface ConversationSummaryDTO extends Conversation {
  runtimeState: ConversationRuntimeState
  websocketReady: boolean
  runtimeError: string | null
  isDefaultConversation: boolean
  liveSession: AgentSession | null
  canonicalOrder: number
  displayState: {
    status: Conversation['status']
    runtimeState: ConversationRuntimeState
    websocketReady: boolean
    runtimeError: string | null
    isVisible: boolean
    isDefaultConversation: boolean
    hasLiveSession: boolean
    isSendable: boolean
    isQueueable: boolean
    isMediaSendable: boolean
    label: string
    disabledReasons: ConversationDisabledReasons
  }
  sendTarget: null | {
    kind: 'conversation'
    conversationId: string
    commanderId: string
    sessionName: string
    transportType: ConversationTransportType
    agentType: AgentType | null
    queue: {
      supported: boolean
      reason: string | null
    }
    media: {
      supported: boolean
      reason: string | null
    }
  }
  allowedActions: ConversationAllowedActions
  runtimeSettings: {
    credentialSelectionModes: ConversationCredentialSelectionModes
    current: {
      agentType: AgentType
      model: string | null
      effort: AgentEffortLevel | null
      adaptiveThinking: ClaudeAdaptiveThinkingMode | null
      maxThinkingTokens: number | null
    }
    supported: {
      agentType: true
      model: true
      effort: boolean
      adaptiveThinking: boolean
      maxThinkingTokens: boolean
    }
    options: {
      agentType: AgentType[]
      model: ProviderModelOption[]
      effort: AgentEffortLevel[]
      adaptiveThinking: ClaudeAdaptiveThinkingMode[]
      maxThinkingTokens: { min: number; max: number } | null
    }
    modelDiscovery: ProviderModelDiscoveryMetadata
    supportsCustomModels: boolean
    allowed: boolean
    disabledReason: string | null
  }
  initialMessagePage?: ConversationMessagesPage
}

function resolveTransportType(liveSession: LiveConversationSessionLike | undefined): ConversationTransportType {
  if (!liveSession) {
    return null
  }
  return liveSession.kind === 'stream' || liveSession.kind === 'pty' || liveSession.kind === 'external'
    ? liveSession.kind
    : null
}

function serializeMinimalLiveSession(liveSession: LiveConversationSessionLike): AgentSession {
  const created = (liveSession as { createdAt?: string }).createdAt ?? new Date(0).toISOString()
  const transportType = resolveTransportType(liveSession) ?? 'stream'
  const process = (liveSession as { process?: { pid?: number } }).process
  const isStream = transportType === 'stream'

  return {
    name: (liveSession as { name?: string }).name ?? '',
    created,
    lastActivityAt: (liveSession as { lastEventAt?: string }).lastEventAt ?? created,
    pid: typeof process?.pid === 'number' ? process.pid : 0,
    transportType,
    processAlive: isStream,
    hadResult: Boolean((liveSession as { finalResultEvent?: unknown }).finalResultEvent),
    status: isStream ? 'active' : 'idle',
    ...(liveSession.agentType ? { agentType: liveSession.agentType } : {}),
  }
}

function serializeLiveSession(liveSession: LiveConversationSessionLike | undefined): AgentSession | null {
  if (!liveSession) {
    return null
  }
  if (hasSerializableStreamShape(liveSession)) {
    return liveSessionToApiPayload(liveSession as StreamSession)
  }

  return serializeMinimalLiveSession(liveSession)
}

function buildLabel(conversation: Conversation): string {
  const name = conversation.name?.trim()
  if (name) {
    return name
  }
  const displayName = conversation.channelMeta?.displayName?.trim()
  if (displayName) {
    return displayName
  }
  return `Conversation ${conversation.id.slice(0, 8)}`
}

function providerSupportsMessageImages(liveSession: LiveConversationSessionLike | undefined): boolean {
  if (!liveSession?.agentType) {
    return false
  }
  return getProvider(liveSession.agentType)?.capabilities.supportsMessageImages === true
}

export function buildConversationSummaryDTO(
  context: CommanderRoutesContext,
  conversation: Conversation,
  canonicalOrder = 0,
  commander?: Pick<
    CommanderSession,
    | 'agentType'
    | 'model'
    | 'effort'
    | 'adaptiveThinking'
    | 'maxThinkingTokens'
    | 'providerContext'
    | 'cwd'
    | 'executionMachineId'
  > | null,
): ConversationSummaryDTO {
  const liveSession = getLiveConversationSession(context, conversation) as LiveConversationSessionLike | undefined
  const transportType = resolveTransportType(liveSession)
  const hasLiveSession = Boolean(liveSession)
  const isDefaultConversation = conversation.id === buildDefaultCommanderConversationId(conversation.commanderId)
  const sessionName = buildConversationSessionName(conversation)
  const isArchived = conversation.status === 'archived'
  const displayRuntimeOverlay = getConversationRuntimeOverlay(conversation.id)
  const runtimeState: ConversationRuntimeState = isArchived
    ? 'archived'
    : displayRuntimeOverlay?.state === 'starting'
      ? 'starting'
      : displayRuntimeOverlay?.state === 'failed'
        ? 'failed'
        : conversation.status === 'active' && hasLiveSession
          ? 'active'
          : 'idle'
  const websocketReady = runtimeState === 'active' && hasLiveSession
  const hasActiveStream = websocketReady && transportType === 'stream'
  const canRecoverActiveNoLiveSession = conversation.status === 'active'
    && runtimeState === 'idle'
    && !hasLiveSession
    && !isArchived
  const canAutoStartIdleTextSend = conversation.status === 'idle'
    && runtimeState === 'idle'
    && !hasLiveSession
    && !isArchived
  const canStartOrResume = (
    (conversation.status === 'idle' || canRecoverActiveNoLiveSession)
    && runtimeState !== 'starting'
    && !hasLiveSession
  )
  const commanderAgentType = commander?.agentType ?? resolveDefaultProviderId()
  const effectiveAgentType = liveSession?.agentType
    ?? conversation.agentType
    ?? commanderAgentType
  const availableAgentTypes = listProviders()
    .filter((provider) => provider.capabilities.supportsCommanderConversation)
    .map((provider) => provider.id)
  const credentialSelectionModes = buildConversationCredentialSelectionModes(
    availableAgentTypes,
    liveSession?.host ?? commander?.executionMachineId,
  )
  const credentialSelectionMode = credentialSelectionModes[effectiveAgentType] ?? 'none'
  const runtimeProvider = getProvider(effectiveAgentType)
  const runtimeCredentialPoolId = credentialSelectionMode === 'per-conversation'
    ? liveSession?.credentialPoolId ?? conversation.credentialPoolId
    : undefined
  const runtimeAccountId = credentialSelectionMode === 'per-conversation'
    ? liveSession?.providerAuthSnapshot?.accountId
      ?? liveSession?.providerAuthSnapshot?.accountEmail
    : undefined
  const runtimeModels = runtimeProvider
    ? getCachedProviderModelsForValidation(runtimeProvider, {
        ...(runtimeCredentialPoolId ? { credentialPoolId: runtimeCredentialPoolId } : {}),
        ...(runtimeAccountId ? { accountId: runtimeAccountId } : {}),
      })
    : null
  const runtimeProviderDefaults = runtimeProvider
    ? resolveProviderDefaults(runtimeProvider, runtimeModels?.models)
    : undefined
  const hasStoredConversationModel = conversation.agentType === effectiveAgentType
    && Object.prototype.hasOwnProperty.call(conversation, 'model')
    && conversation.model !== undefined
  const commanderMatchesProvider = commanderAgentType === effectiveAgentType
  const hasNativeResumeIdentifier = Boolean(
    !liveSession
    && runtimeProvider
    && hasNativeProviderResumeIdentifier({
      provider: runtimeProvider,
      agentType: effectiveAgentType,
      providerContext: conversation.providerContext,
      sessionName,
      cwd: commander?.cwd ?? process.env.HOME ?? '/tmp',
    }),
  )
  const effectiveModel = liveSession?.model
    ?? (hasStoredConversationModel
      ? conversation.model ?? runtimeProviderDefaults?.model
      : commanderMatchesProvider
        ? commander?.model ?? (hasNativeResumeIdentifier ? null : runtimeProviderDefaults?.model)
        : hasNativeResumeIdentifier ? null : runtimeProviderDefaults?.model)
    ?? null
  const runtimeModel = findRuntimeModelOption(runtimeModels?.models ?? [], effectiveModel)
  const runtimeModelOptions = runtimeModel || !effectiveModel
    ? runtimeModels?.models ?? []
    : [
        {
          id: effectiveModel,
          label: effectiveModel,
          description: 'Current runtime model; not present in the latest discovered catalog.',
        },
        ...(runtimeModels?.models ?? []),
      ]
  const persistedProviderContext = conversation.providerContext as {
    effort?: unknown
    omitEffort?: boolean
    adaptiveThinking?: unknown
    maxThinkingTokens?: unknown
  } | undefined
  const commanderProviderContext = commanderMatchesProvider
    ? commander?.providerContext as {
        effort?: unknown
        adaptiveThinking?: unknown
        maxThinkingTokens?: unknown
      } | undefined
    : undefined
  const liveProviderContext = liveSession?.providerContext as { omitEffort?: boolean } | undefined
  const omitEffort = liveProviderContext?.omitEffort === true
    || persistedProviderContext?.omitEffort === true
  const supportedEffortOptions = getAgentEffortLevelsForModel(
    effectiveAgentType,
    runtimeModel,
  )
  const supportsEffort = runtimeProvider?.uiCapabilities.supportsEffort === true
    && supportedEffortOptions.length > 0
    && !omitEffort
  const supportsAdaptiveThinking = runtimeProvider?.uiCapabilities.supportsAdaptiveThinking === true
    && runtimeModel?.supportsAdaptiveThinking !== false
  const defaultEffort = getDefaultAgentEffortForModel(
    effectiveAgentType,
    runtimeModel,
    runtimeProviderDefaults?.effort,
  )
  const persistedEffort = conversation.effort
    ?? parseStoredAgentEffort(effectiveAgentType, persistedProviderContext?.effort)
    ?? (commanderMatchesProvider
      ? parseStoredAgentEffort(
          effectiveAgentType,
          commander?.effort ?? commanderProviderContext?.effort,
        )
      : undefined)
  const currentEffort = supportsEffort
    ? liveSession?.effort
      ?? (persistedEffort && supportedEffortOptions.includes(persistedEffort)
        ? persistedEffort
        : defaultEffort)
      ?? null
    : null
  const currentAdaptiveThinking = supportsAdaptiveThinking
    ? liveSession?.adaptiveThinking
      ?? conversation.adaptiveThinking
      ?? (persistedProviderContext?.adaptiveThinking as ClaudeAdaptiveThinkingMode | undefined)
      ?? (commanderMatchesProvider
        ? commander?.adaptiveThinking
          ?? (commanderProviderContext?.adaptiveThinking as ClaudeAdaptiveThinkingMode | undefined)
        : undefined)
      ?? runtimeProviderDefaults?.adaptiveThinking
      ?? null
    : null
  const currentMaxThinkingTokens = liveSession?.maxThinkingTokens
    ?? conversation.maxThinkingTokens
    ?? (typeof persistedProviderContext?.maxThinkingTokens === 'number'
      ? persistedProviderContext.maxThinkingTokens
      : undefined)
    ?? (commanderMatchesProvider
      ? commander?.maxThinkingTokens
        ?? (typeof commanderProviderContext?.maxThinkingTokens === 'number'
          ? commanderProviderContext.maxThinkingTokens
          : undefined)
      : undefined)
    ?? runtimeProviderDefaults?.maxThinkingTokens
    ?? null
  const runtimeSettingsDisabledReason = getConversationRuntimeSettingsDisabledReason(
    context,
    conversation,
    effectiveAgentType,
  )

  const noActiveStreamReason = 'Conversation image transport requires an active stream session'
  const canSendMedia = hasActiveStream && providerSupportsMessageImages(liveSession)
  let sendReason: string | null = null
  if (isArchived) {
    sendReason = 'Conversation is archived'
  } else if (runtimeState === 'starting') {
    sendReason = 'Conversation is starting'
  } else if (runtimeState === 'failed') {
    sendReason = 'Conversation start failed'
  } else if (!hasActiveStream && !canRecoverActiveNoLiveSession && !canAutoStartIdleTextSend) {
    sendReason = conversation.status !== 'active'
      ? 'Conversation must be active before sending'
      : transportType === null
        ? 'Conversation has no live session'
        : 'Conversation live session is not stream-sendable'
  }
  const queueReason = hasActiveStream
    ? null
    : sendReason ?? 'Conversation queue requires an active stream session'
  const mediaReason = canSendMedia
    ? null
    : hasActiveStream
      ? 'Conversation provider does not support image attachments'
      : noActiveStreamReason

  const allowedActions: ConversationAllowedActions = {
    send: hasActiveStream || canRecoverActiveNoLiveSession || canAutoStartIdleTextSend,
    queue: hasActiveStream,
    media: canSendMedia,
    start: canStartOrResume,
    pause: (runtimeState === 'starting' || (conversation.status === 'active' && hasLiveSession)) && !isArchived,
    resume: canStartOrResume,
    archive: true,
    delete: true,
    updateProvider: runtimeSettingsDisabledReason === null,
    updateRuntimeSettings: runtimeSettingsDisabledReason === null,
  }
  const disabledReasons: ConversationDisabledReasons = {
    send: allowedActions.send ? null : sendReason,
    queue: allowedActions.queue ? null : queueReason,
    media: allowedActions.media ? null : mediaReason,
    start: allowedActions.start
      ? null
      : isArchived
        ? 'Archived conversations cannot be started'
        : runtimeState === 'starting'
          ? 'Conversation is already starting'
          : hasLiveSession
            ? 'Conversation already has a live session'
            : 'Conversation is not idle',
    pause: allowedActions.pause
      ? null
      : isArchived
        ? 'Archived conversations cannot be paused'
        : 'Conversation is not active',
    resume: allowedActions.resume
      ? null
      : isArchived
        ? 'Archived conversations cannot be resumed'
        : runtimeState === 'starting'
          ? 'Conversation is already starting'
          : hasLiveSession
            ? 'Conversation already has a live session'
            : 'Conversation is not idle',
    archive: null,
    delete: null,
    updateProvider: runtimeSettingsDisabledReason,
    updateRuntimeSettings: runtimeSettingsDisabledReason,
  }

  const queueSupport = {
    supported: allowedActions.queue,
    reason: disabledReasons.queue,
  }
  const mediaSupport = {
    supported: allowedActions.media,
    reason: disabledReasons.media,
  }

  return {
    ...conversation,
    runtimeState,
    websocketReady,
    runtimeError: displayRuntimeOverlay?.error ?? null,
    isDefaultConversation,
    liveSession: serializeLiveSession(liveSession),
    canonicalOrder,
    displayState: {
      status: conversation.status,
      runtimeState,
      websocketReady,
      runtimeError: displayRuntimeOverlay?.error ?? null,
      isVisible: conversation.status !== 'archived',
      isDefaultConversation,
      hasLiveSession,
      isSendable: allowedActions.send,
      isQueueable: allowedActions.queue,
      isMediaSendable: allowedActions.media,
      label: buildLabel(conversation),
      disabledReasons,
    },
    sendTarget: isArchived
      ? null
      : {
          kind: 'conversation',
          conversationId: conversation.id,
          commanderId: conversation.commanderId,
          sessionName,
          transportType,
          agentType: liveSession?.agentType ?? conversation.agentType ?? null,
          queue: queueSupport,
          media: mediaSupport,
        },
    allowedActions,
    runtimeSettings: {
      credentialSelectionModes,
      current: {
        agentType: effectiveAgentType,
        model: effectiveModel,
        effort: currentEffort,
        adaptiveThinking: currentAdaptiveThinking,
        maxThinkingTokens: currentMaxThinkingTokens,
      },
      supported: {
        agentType: true,
        model: true,
        effort: supportsEffort,
        adaptiveThinking: supportsAdaptiveThinking,
        maxThinkingTokens: runtimeProvider?.uiCapabilities.supportsMaxThinkingTokens === true,
      },
      options: {
        agentType: availableAgentTypes,
        model: runtimeModelOptions.map((model) => ({ ...model })),
        effort: supportsEffort
          ? supportedEffortOptions
          : [],
        adaptiveThinking: supportsAdaptiveThinking
          ? [...CLAUDE_ADAPTIVE_THINKING_MODES]
          : [],
        maxThinkingTokens: runtimeProvider?.uiCapabilities.supportsMaxThinkingTokens
          ? {
              min: MIN_CLAUDE_MAX_THINKING_TOKENS,
              max: MAX_CLAUDE_MAX_THINKING_TOKENS,
            }
          : null,
      },
      modelDiscovery: runtimeModels?.discovery ?? {
        source: 'static-fallback',
        freshness: 'fallback',
        fetchedAt: null,
        expiresAt: null,
        refreshAllowedAt: null,
        error: runtimeProvider ? null : `Unknown provider "${effectiveAgentType}"`,
        credentialPoolId: runtimeCredentialPoolId ?? null,
        accountId: runtimeAccountId ?? null,
      },
      supportsCustomModels: runtimeModels?.supportsCustomModels ?? false,
      allowed: runtimeSettingsDisabledReason === null,
      disabledReason: runtimeSettingsDisabledReason,
    },
  }
}
