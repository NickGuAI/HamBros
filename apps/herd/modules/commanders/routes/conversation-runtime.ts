import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  buildCommanderSessionSeedFromResolvedWorkflow,
} from '../memory/module.js'
import type { ClaudeAdaptiveThinkingMode } from '../../claude-adaptive-thinking.js'
import type { ClaudeMaxThinkingTokens } from '../../claude-max-thinking-tokens.js'
import type {
  AgentType,
  SessionSendDisposition,
  SessionSendIntent,
  StreamJsonEvent,
  StreamSession,
} from '../../agents/types.js'
import {
  getAgentModelEffortCapability,
  getDefaultAgentEffortForModel,
  parseOptionalAgentEffort,
  parseStoredAgentEffort,
  type AgentEffortLevel,
} from '../../agents/effort.js'
import type { QueuedMessageImage } from '../../agents/message-queue.js'
import { mapStreamEventsToMessages } from '../../agents/messages/history.js'
import { COMMANDER_STARTUP_USER_EVENT_SUBTYPE } from '../../agents/user-event-subtypes.js'
import type { MsgItem } from '../../agents/messages/model.js'
import { mergeCanonicalStreamEvents } from '../../agents/messages/canonical-timeline.js'
import { readTranscriptTailPage } from '../../agents/transcript-store.js'
import { isTranscriptEnvelope } from '../../../src/types/transcript-envelope.js'
import { STARTUP_PROMPT } from './context.js'
import type { CommanderSession } from '../store.js'
import { resolveCommanderWorkflow } from '../workflow-resolution.js'
import type {
  ChannelInboundMessageFate,
  ChannelReplyDelivery,
  ChannelReplyIntent,
  Conversation,
} from '../conversation-store.js'
import type { ChannelReplyForwarder, CommanderRoutesContext } from './types.js'
import { createChannelReplyStreamDispatch } from '../channel-dispatchers.js'
import { sanitizeProviderContextForPersistence } from '../../agents/providers/provider-context-normalization.js'
import {
  asClaudeProviderContext,
  createProviderContextForAgentType,
} from '../../agents/providers/provider-session-context.js'
import { getProvider, resolveDefaultProviderId } from '../../agents/providers/registry.js'
import {
  resolveProviderDefaults,
  type ProviderModelOption,
} from '../../agents/providers/provider-adapter.js'
import { getCachedProviderModelsForValidation } from '../../agents/providers/model-discovery.js'
import { appendClaudeReasoningPolicy } from '../../agents/adapters/claude/reasoning-policy.js'
import { hasNativeProviderResumeIdentifier } from '../../agents/providers/native-resume.js'
import { isResumeNotFoundProviderError } from '../../agents/provider-errors.js'
import {
  appendCommanderCostRecord,
  computeLiveSessionMonthlySpendUsd,
  enforceCommanderCostCap,
} from '../cost-control.js'
import { getConversationRuntimeOverlay } from './conversation-runtime-state.js'
import { CommanderSessionReplacementConflictError } from '../../agents/commander-interface.js'
import { isProviderLaunchError } from '../../agents/session/machine-launch.js'
import { withCommanderRuntimeLaunch } from '../package-lifecycle-state.js'
import { resolveConversationCredentialSelectionMode } from '../conversation-credential-selection.js'

export function buildConversationSessionName(conversation: Conversation): string {
  return `commander-${conversation.commanderId}-conversation-${conversation.id}`
}

export function getLiveConversationSession(
  context: CommanderRoutesContext,
  conversation: Conversation,
) {
  return context.sessionsInterface?.getSession(buildConversationSessionName(conversation))
}

const DEFAULT_CONVERSATION_MESSAGES_LIMIT = 50
const MAX_CONVERSATION_MESSAGES_LIMIT = 100
const DEFAULT_TRANSCRIPT_TAIL_EVENT_LIMIT = 500
const MAX_TRANSCRIPT_TAIL_EVENT_LIMIT = 5_000
const MAX_TRANSCRIPT_TAIL_READ_ATTEMPTS = 5
const CLIENT_SEND_ID_DEDUPE_TAIL_TURNS = 200
const CHANNEL_REPLY_INTENT_HISTORY_LIMIT = 100
const CHANNEL_REPLY_RECONCILIATION_DELAYS_MS = [0, 1000, 5000] as const
const DEFAULT_CHANNEL_REPLY_RECONCILIATION_RETRY_MS = 5000
const CHANNEL_REPLY_UNDELIVERABLE_MESSAGE = 'No automatic channel reply was available to send.'
const CHANNEL_FAILURE_NOTICE_MESSAGE = 'I received your message, but the assistant turn failed before I could produce a reply. An operator can inspect this conversation in Command Room.'
const CHANNEL_INBOUND_FATE_HISTORY_LIMIT = 100
const DEEP_THINKING_RESEARCH_ROLES = ['context-research', 'risk-research'] as const
const DEEP_THINKING_THINKING_ROLES = ['inversion-thinking', 'synthesis-thinking', 'operational-thinking'] as const
const DEFAULT_DEEP_THINKING_WORKER_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_DEEP_THINKING_WORKER_POLL_MS = 1000
const DEFAULT_DEEP_THINKING_OPERATION_SCHEDULE_DELAY_MS = 0
const GAIA_HOST = 'gaia'
const GAIA_TEMPLATE_ID = 'gaia-onboarding'
const GAIA_OPS_API_KEY_SCOPES = [
  'commanders:write',
  'agents:write',
  'org:write',
] as const
const GAIA_OPS_API_KEY_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Worker findings are capped before being injected into follow-up worker and
 * synthesis prompts. The character budget is documented here because token
 * counts are provider-specific; 24k chars is roughly 6k English tokens.
 */
const DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS = 24_000

let deepThinkingDispatchSequence = 0
let deepThinkingWorkerWaitTimeoutMs = DEFAULT_DEEP_THINKING_WORKER_WAIT_TIMEOUT_MS
let deepThinkingWorkerPollMs = DEFAULT_DEEP_THINKING_WORKER_POLL_MS
let deepThinkingOperationScheduleDelayMs = DEFAULT_DEEP_THINKING_OPERATION_SCHEDULE_DELAY_MS
let channelReplyReconciliationRetryMs = DEFAULT_CHANNEL_REPLY_RECONCILIATION_RETRY_MS

interface DeepThinkingOperationRegistration {
  controller: AbortController
  context: CommanderRoutesContext
  conversation: Conversation
  sessionName: string
  operationId: string
  cancellationRecorded: boolean
}

const deepThinkingOperations = new Map<string, DeepThinkingOperationRegistration>()
const inFlightConversationDeliveries = new Map<string, Promise<DeliverConversationMessageResult>>()
const inFlightChannelReplyDeliveryIds = new Set<string>()
const channelReplyReconciliationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let channelReplyClientSendSequence = 0

export function configureDeepThinkingRoutingForTest(options: {
  workerWaitTimeoutMs?: number
  workerPollMs?: number
  operationScheduleDelayMs?: number
}): void {
  deepThinkingWorkerWaitTimeoutMs = options.workerWaitTimeoutMs ?? DEFAULT_DEEP_THINKING_WORKER_WAIT_TIMEOUT_MS
  deepThinkingWorkerPollMs = options.workerPollMs ?? DEFAULT_DEEP_THINKING_WORKER_POLL_MS
  deepThinkingOperationScheduleDelayMs = options.operationScheduleDelayMs ?? DEFAULT_DEEP_THINKING_OPERATION_SCHEDULE_DELAY_MS
}

export function resetDeepThinkingRoutingStateForTest(): void {
  for (const operation of deepThinkingOperations.values()) {
    operation.controller.abort(new Error('deep-thinking routing state reset'))
  }
  deepThinkingOperations.clear()
  deepThinkingDispatchSequence = 0
  configureDeepThinkingRoutingForTest({})
}

export function configureChannelReplyReconciliationForTest(options: {
  retryMs?: number
}): void {
  channelReplyReconciliationRetryMs = options.retryMs ?? DEFAULT_CHANNEL_REPLY_RECONCILIATION_RETRY_MS
}

export function resetChannelReplyReconciliationStateForTest(): void {
  for (const timer of channelReplyReconciliationRetryTimers.values()) {
    clearTimeout(timer)
  }
  channelReplyReconciliationRetryTimers.clear()
  inFlightChannelReplyDeliveryIds.clear()
  configureChannelReplyReconciliationForTest({})
}

export function getInFlightChannelReplyDeliveryIdsForTest(): string[] {
  return Array.from(inFlightChannelReplyDeliveryIds)
}

function stripDeepThinkingTriggers(message: string): string {
  return message
    .normalize('NFKC')
    .replace(/\bthink\s+(?:harder|deeper|deeply|longer|more\s+(?:carefully|thoroughly|rigorously))\b/gi, ' ')
    .replace(/\b(?:deep|deeper|extended|multi[-\s]?round|multiple[-\s]+rounds?)\s+(?:thinking|reasoning|analysis)\b/gi, ' ')
    .replace(/\b(?:reason|analy[sz]e)\s+(?:deeper|deeply|harder|more\s+(?:carefully|thoroughly|rigorously))\b/gi, ' ')
    .replace(/\btake\s+(?:a\s+)?(?:deep|harder|more\s+careful)\s+(?:think|look)\b/gi, ' ')
    .replace(/深入思考|深度思考|多轮思考|认真思考|仔细思考/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasSubstantiveDeepThinkingSubject(message: string): boolean {
  const withoutTrigger = stripDeepThinkingTriggers(message)
  const latinWordCount = withoutTrigger.match(/[a-z0-9][a-z0-9'-]*/gi)?.length ?? 0
  const cjkCount = withoutTrigger.match(/[\u3400-\u9fff]/g)?.length ?? 0
  return latinWordCount >= 4 || cjkCount >= 8 || withoutTrigger.length >= 24
}

function hasExplicitDeepThinkingTrigger(message: string): boolean {
  const normalized = message
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  if (!normalized) {
    return false
  }

  return [
    /\bthink\s+(?:harder|deeper|deeply|longer|more\s+(?:carefully|thoroughly|rigorously))\b/,
    /\b(?:deep|deeper|extended|multi[-\s]?round|multiple[-\s]+rounds?)\s+(?:thinking|reasoning|analysis)\b/,
    /\b(?:reason|analy[sz]e)\s+(?:deeper|deeply|harder|more\s+(?:carefully|thoroughly|rigorously))\b/,
    /\btake\s+(?:a\s+)?(?:deep|harder|more\s+careful)\s+(?:think|look)\b/,
    /深入思考|深度思考|多轮思考|认真思考|仔细思考/,
  ].some((pattern) => pattern.test(normalized))
}

export interface ConversationMessagesPageOptions {
  limit?: number
  before?: number | null
}

export interface ConversationMessagesPage {
  conversationId: string
  sessionName: string
  source: 'canonical' | 'empty'
  limit: number
  before: string | null
  nextBefore: string | null
  hasMore: boolean
  totalMessages: number
  messages: MsgItem[]
}

function normalizeConversationMessagesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_CONVERSATION_MESSAGES_LIMIT
  }
  return Math.max(1, Math.min(MAX_CONVERSATION_MESSAGES_LIMIT, Math.floor(limit)))
}

function normalizeConversationMessagesCursor(before: number | null | undefined): number {
  if (before === null || before === undefined || !Number.isFinite(before)) {
    return 0
  }
  return Math.max(0, Math.floor(before))
}

function sliceMessagesFromNewest(input: {
  messages: MsgItem[]
  limit: number
  skipNewest: number
  hasMoreBeforeWindow: boolean
}): Pick<ConversationMessagesPage, 'before' | 'nextBefore' | 'hasMore' | 'totalMessages' | 'messages'> {
  const endExclusive = Math.max(0, input.messages.length - input.skipNewest)
  const startInclusive = Math.max(0, endExclusive - input.limit)
  const messages = input.messages.slice(startInclusive, endExclusive)
  const hasMore = input.hasMoreBeforeWindow || startInclusive > 0
  const nextBefore = hasMore
    ? String(input.skipNewest + messages.length)
    : null

  return {
    before: input.skipNewest > 0 ? String(input.skipNewest) : null,
    nextBefore,
    hasMore,
    totalMessages: input.hasMoreBeforeWindow
      ? Math.max(input.skipNewest + messages.length, input.messages.length)
      : input.messages.length,
    messages,
  }
}

function channelSourceHash(provider: string, accountId: string, rawSourceId: string): string {
  return createHash('sha256')
    .update([provider, accountId, rawSourceId].join('\0'))
    .digest('hex')
    .slice(0, 16)
}

function parseChannelIdentityFromClientSendId(
  clientSendId: string | undefined,
  conversation: Pick<Conversation, 'channelMeta' | 'lastRoute'>,
): {
  provider: string
  accountId: string
  rawSourceId: string
} | null {
  const normalized = normalizeClientSendId(clientSendId)
  if (!normalized) {
    return null
  }
  const parts = normalized.split(':')
  if (parts.length >= 4 && parts[0] === 'channel') {
    return {
      provider: parts[1] ?? conversation.channelMeta?.provider ?? 'unknown',
      accountId: parts[2] ?? conversation.channelMeta?.accountId ?? conversation.lastRoute?.accountId ?? 'unknown',
      rawSourceId: parts.slice(3).join(':'),
    }
  }
  if (!conversation.channelMeta) {
    return null
  }
  return {
    provider: conversation.channelMeta.provider,
    accountId: conversation.channelMeta.accountId,
    rawSourceId: normalized,
  }
}

function channelInboundFateId(input: {
  provider: string
  accountId: string
  rawSourceId: string
  clientSendId?: string
  fate: ChannelInboundMessageFate['fate']
  at: string
}): string {
  const stableKey = [
    input.provider,
    input.accountId,
    input.rawSourceId,
    input.clientSendId ?? '',
    input.fate === 'duplicate' ? input.at : input.fate,
  ].join('\0')
  return `channel-inbound-fate-${createHash('sha256').update(stableKey).digest('hex').slice(0, 24)}`
}

function pruneChannelInboundFates(fates: ChannelInboundMessageFate[]): ChannelInboundMessageFate[] {
  if (fates.length <= CHANNEL_INBOUND_FATE_HISTORY_LIMIT) {
    return fates
  }
  return fates.slice(-CHANNEL_INBOUND_FATE_HISTORY_LIMIT)
}

export async function recordChannelInboundFate(
  context: CommanderRoutesContext,
  conversationId: string,
  input: {
    fate: ChannelInboundMessageFate['fate']
    provider: string
    accountId: string
    rawSourceId: string
    clientSendId?: string
    error?: string
  },
): Promise<void> {
  const at = context.now().toISOString()
  const provider = input.provider.trim().toLowerCase() as ChannelInboundMessageFate['provider']
  const accountId = input.accountId.trim()
  const rawSourceId = input.rawSourceId.trim()
  if (!provider || !accountId || !rawSourceId) {
    return
  }
  const clientSendId = normalizeClientSendId(input.clientSendId) ?? undefined
  const nextFate: ChannelInboundMessageFate = {
    id: channelInboundFateId({
      provider,
      accountId,
      rawSourceId,
      clientSendId,
      fate: input.fate,
      at,
    }),
    fate: input.fate,
    provider,
    accountId,
    rawSourceId,
    at,
    ...(clientSendId ? { clientSendId } : {}),
    sourceHash: channelSourceHash(provider, accountId, rawSourceId),
    ...(input.error?.trim() ? { error: input.error.trim().slice(0, 500) } : {}),
  }

  await context.conversationStore.update(conversationId, (current) => {
    const fates = current.channelInboundFates ?? []
    const existingIndex = input.fate === 'duplicate'
      ? -1
      : fates.findIndex((candidate) => (
          (clientSendId && candidate.clientSendId === clientSendId) ||
          (
            candidate.provider === provider &&
            candidate.accountId === accountId &&
            candidate.rawSourceId === rawSourceId &&
            candidate.fate !== 'duplicate'
          )
        ))
    const nextFates = existingIndex >= 0
      ? fates.map((candidate, index) => index === existingIndex ? nextFate : candidate)
      : [...fates, nextFate]
    return {
      ...current,
      channelInboundFates: pruneChannelInboundFates(nextFates),
      lastMessageAt: at,
    }
  })
}

async function recordChannelInboundFateForClientSendId(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string | undefined,
  fate: ChannelInboundMessageFate['fate'],
  error?: string,
): Promise<void> {
  const identity = parseChannelIdentityFromClientSendId(clientSendId, conversation)
  if (!identity) {
    return
  }
  await recordChannelInboundFate(context, conversation.id, {
    ...identity,
    clientSendId,
    fate,
    ...(error ? { error } : {}),
  })
}

function attachChannelInboundFates(
  conversation: Conversation,
  messages: MsgItem[],
): MsgItem[] {
  const fates = conversation.channelInboundFates ?? []
  if (fates.length === 0) {
    return messages
  }

  const latestByClientSendId = new Map<string, ChannelInboundMessageFate>()
  const unmatchedFates: ChannelInboundMessageFate[] = []
  for (const fate of fates) {
    if (fate.clientSendId && fate.fate !== 'duplicate') {
      latestByClientSendId.set(fate.clientSendId, fate)
    } else {
      unmatchedFates.push(fate)
    }
  }

  const matchedClientSendIds = new Set<string>()
  const decoratedMessages = messages.map((message) => {
    if (message.kind !== 'user' || !message.clientSendId) {
      return message
    }
    const fate = latestByClientSendId.get(message.clientSendId)
    if (!fate) {
      return message
    }
    matchedClientSendIds.add(message.clientSendId)
    return {
      ...message,
      channelFate: {
        fate: fate.fate,
        at: fate.at,
        ...(fate.sourceHash ? { sourceHash: fate.sourceHash } : {}),
        ...(fate.error ? { error: fate.error } : {}),
      },
    }
  })

  const systemFates = [
    ...unmatchedFates,
    ...fates.filter((fate) =>
      fate.clientSendId &&
      fate.fate !== 'duplicate' &&
      !matchedClientSendIds.has(fate.clientSendId)),
  ].map((fate) => {
    const error = fate.error ? `: ${fate.error}` : ''
    const source = fate.sourceHash ? ` source ${fate.sourceHash}` : ''
    return {
      id: `channel-inbound-fate-${fate.id}`,
      kind: 'system' as const,
      text: `Inbound channel message fate: ${fate.fate}${source}${error}`,
      timestamp: fate.at,
    }
  })

  return [...decoratedMessages, ...systemFates]
}

function appendChannelReplyDeliveryMessage(
  conversation: Conversation,
  messages: MsgItem[],
): MsgItem[] {
  const delivery = conversation.channelReplyDelivery
  if (!delivery || delivery.status !== 'failed') {
    return messages
  }

  const target = delivery.lastRoute.to.trim()
  const targetLabel = target ? ` to ${target}` : ''
  const error = delivery.error?.trim()
  const errorText = error ? `: ${error}` : '.'
  return [
    ...messages,
    {
      id: `channel-reply-delivery-${delivery.id}`,
      kind: 'system',
      text: `External channel reply failed${targetLabel}${errorText} Operator retry required.`,
      timestamp: delivery.failedAt ?? delivery.updatedAt,
    },
  ]
}

async function readTranscriptEventsWindow(
  sessionName: string,
  targetMessages: number,
  liveEvents: readonly StreamJsonEvent[],
): Promise<{ events: StreamJsonEvent[]; messages: MsgItem[]; hasMoreBeforeWindow: boolean }> {
  let maxTurns = Math.max(targetMessages, DEFAULT_CONVERSATION_MESSAGES_LIMIT)
  let maxEvents = Math.max(DEFAULT_TRANSCRIPT_TAIL_EVENT_LIMIT, targetMessages * 25)
  let lastEvents: StreamJsonEvent[] = []
  let lastMessages: MsgItem[] = []
  let lastHasMore = false

  for (let attempt = 0; attempt < MAX_TRANSCRIPT_TAIL_READ_ATTEMPTS; attempt += 1) {
    const page = await readTranscriptTailPage(sessionName, {
      maxTurns,
      maxEvents,
    })
    const events = mergeCanonicalStreamEvents({
      persistedEvents: page.events as readonly StreamJsonEvent[],
      liveEvents,
    })
    const messages = mapStreamEventsToMessages(events)
    lastEvents = events
    lastMessages = messages
    lastHasMore = page.hasMore

    if (messages.length >= targetMessages || !page.hasMore || maxEvents >= MAX_TRANSCRIPT_TAIL_EVENT_LIMIT) {
      break
    }

    maxTurns *= 2
    maxEvents = Math.min(maxEvents * 2, MAX_TRANSCRIPT_TAIL_EVENT_LIMIT)
  }

  return {
    events: lastEvents,
    messages: lastMessages,
    hasMoreBeforeWindow: lastHasMore,
  }
}

export async function getConversationMessagesPage(
  context: CommanderRoutesContext,
  conversation: Conversation,
  options: ConversationMessagesPageOptions = {},
): Promise<ConversationMessagesPage> {
  const sessionName = buildConversationSessionName(conversation)
  const limit = normalizeConversationMessagesLimit(options.limit)
  const skipNewest = normalizeConversationMessagesCursor(options.before)
  const liveEvents = getLiveConversationSession(context, conversation)?.events ?? []
  const targetMessages = skipNewest + limit
  const transcriptWindow = await readTranscriptEventsWindow(sessionName, targetMessages, liveEvents)
  const transcriptMessages = appendChannelReplyDeliveryMessage(
    conversation,
    attachChannelInboundFates(conversation, transcriptWindow.messages),
  )
  const transcriptPage = sliceMessagesFromNewest({
    messages: transcriptMessages,
    limit,
    skipNewest,
    hasMoreBeforeWindow: transcriptWindow.hasMoreBeforeWindow,
  })
  const source: ConversationMessagesPage['source'] = transcriptMessages.length === 0
    ? 'empty'
    : 'canonical'

  return {
    conversationId: conversation.id,
    sessionName,
    source,
    limit,
    ...transcriptPage,
  }
}

export interface ConversationSpawnOptions {
  agentType?: AgentType
  model?: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  credentialPoolId?: string
  clearResumeProviderContext?: boolean
}

interface ConversationStartLifecycleCallbacks {
  onConversationActivated?: (conversation: Conversation) => void
}

interface PreparedConversationSession {
  commander: CommanderSession
  sessionName: string
  createSessionInput: {
    name: string
    commanderId: string
    conversationId: string
    systemPrompt: string
    agentType: AgentType
    model?: string
    effort?: AgentEffortLevel
    omitEffort?: boolean
    adaptiveThinking?: ClaudeAdaptiveThinkingMode
    maxThinkingTokens?: ClaudeMaxThinkingTokens
    cwd?: string
    machineId?: string
    resumeProviderContext?: Conversation['providerContext']
    credentialPoolId?: string
    maxTurns?: number
    env?: NodeJS.ProcessEnv
    gaiaOpsApiKeyExpiresAt?: string
  }
  gaiaOpsEnvRequired: boolean
  credentialRecoveryApplied?: boolean
  resumeNotFoundRecoveryApplied?: boolean
  resumingNativeSession?: boolean
}

function resolveGaiaApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERD_API_BASE_URL?.trim() || env.API_BASE_URL?.trim()
  if (explicit) {
    return explicit.replace(/\/+$/u, '')
  }
  const port = env.PORT?.trim() || '20001'
  return `http://127.0.0.1:${port}`
}

function isGaiaSystemCommander(commander: CommanderSession): boolean {
  return commander.system === true
    && (
      commander.host === GAIA_HOST ||
      commander.templateId === GAIA_TEMPLATE_ID
    )
}

export function appendGaiaOpsSkillGuide(systemPrompt: string): string {
  return [
    systemPrompt,
    '',
    '# Gaia Operations Skills',
    '',
    'You can perform founder-requested operations through Herd APIs using the scoped API key in HERD_API_KEY. Never print, log, or store that key.',
    '',
    '- create-commander: use the existing commander-create-wizard flow when a user asks Gaia to create or configure a commander.',
    '- add-machine: for a new daemon machine, POST to `${API_BASE_URL}/api/agents/machines/enrollment-token` (optional `label`, `cwd`) and return the `enrollment.command` one-liner for the user to run on that box; the token expires in 24 hours. For SSH-transport machines, POST the machine payload to `${API_BASE_URL}/api/agents/machines`.',
    '- re-pair-machine: to rotate or renew daemon credentials for an existing machine, POST to `${API_BASE_URL}/api/agents/machines/:id/daemon/pair` and return the daemon pairing command from the response.',
    '- create-automation: POST to `${API_BASE_URL}/api/automations`; include `sourceConversationId: process.env.HERD_SOURCE_CONVERSATION_ID` when the value is present.',
    '',
    'Use the `x-herd-api-key` header with HERD_API_KEY for these API calls.',
  ].join('\n')
}

export interface GaiaOpsEnvResult {
  env: NodeJS.ProcessEnv
  apiKeyExpiresAt: string
}

export async function buildGaiaOpsEnvWithMetadata(
  context: CommanderRoutesContext,
  commander: CommanderSession,
  conversation: Conversation,
): Promise<GaiaOpsEnvResult | undefined> {
  if (!isGaiaSystemCommander(commander)) {
    return undefined
  }

  const now = context.now()
  const expiresAt = new Date(now.getTime() + GAIA_OPS_API_KEY_TTL_MS)
  if (!context.apiKeyStore?.createKey) {
    return {
      apiKeyExpiresAt: expiresAt.toISOString(),
      env: {
        API_BASE_URL: resolveGaiaApiBaseUrl(),
        HERD_SOURCE_CONVERSATION_ID: conversation.id,
      },
    }
  }

  const created = await context.apiKeyStore.createKey({
    name: `Gaia ops ${conversation.id}`,
    scopes: GAIA_OPS_API_KEY_SCOPES,
    purpose: 'permanent',
    createdBy: `gaia:${commander.id}`,
    now,
    expiresAt,
  })

  return {
    apiKeyExpiresAt: expiresAt.toISOString(),
    env: {
      API_BASE_URL: resolveGaiaApiBaseUrl(),
      HERD_API_KEY: created.key,
      HERD_API_KEY_HEADER: 'x-herd-api-key',
      HERD_SOURCE_CONVERSATION_ID: conversation.id,
    },
  }
}

export async function buildGaiaOpsEnv(
  context: CommanderRoutesContext,
  commander: CommanderSession,
  conversation: Conversation,
): Promise<NodeJS.ProcessEnv | undefined> {
  return (await buildGaiaOpsEnvWithMetadata(context, commander, conversation))?.env
}

function readProviderErrorText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (!isObjectRecord(value)) {
    return undefined
  }
  return readProviderErrorText(value.message)
    ?? readProviderErrorText(value.error)
    ?? readProviderErrorText(value.reason)
    ?? readProviderErrorText(value.detail)
}

function readProviderErrorCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (!isObjectRecord(value)) {
    return undefined
  }
  return readProviderErrorCode(value.code)
    ?? readProviderErrorCode(value.error_code)
    ?? readProviderErrorCode(value.errorCode)
    ?? readProviderErrorCode(value.codexErrorInfo)
    ?? readProviderErrorCode(value.classification)
}

function isResumeNotFoundEvent(event: StreamJsonEvent): boolean {
  if (!isTranscriptEnvelope(event)) {
    return false
  }
  if (event.ev.type === 'provider.error') {
    return event.ev.classification === 'resume_not_found' ||
      event.ev.code === 'resume_not_found' ||
      isResumeNotFoundProviderError(event.ev.message, event.ev.code)
  }
  if (event.ev.type !== 'turn.end' || isSuccessfulTurnEndStatus(event.ev.status)) {
    return false
  }
  const payload = event.ev.error ?? event.ev.result
  return isResumeNotFoundProviderError(
    readProviderErrorText(payload),
    readProviderErrorCode(payload),
  )
}

function isResumeNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return isResumeNotFoundProviderError(error.message)
  }
  return isResumeNotFoundProviderError(readProviderErrorText(error), readProviderErrorCode(error))
}

async function hasRecentResumeNotFoundFailure(
  context: CommanderRoutesContext,
  conversation: Conversation,
  sessionName: string,
  liveEvents: readonly StreamJsonEvent[],
): Promise<boolean> {
  const transcriptWindow = await readTranscriptEventsWindow(sessionName, 1, liveEvents)
  return transcriptWindow.events.slice(-50).some(isResumeNotFoundEvent)
}

async function clearConversationProviderContextForResumeRecovery(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<Conversation> {
  const updated = await context.conversationStore.update(conversation.id, (current) => ({
    ...current,
    providerContext: undefined,
  }))
  return updated ?? {
    ...conversation,
    providerContext: undefined,
  }
}

async function hasConversationTranscriptMessages(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<boolean> {
  const sessionName = buildConversationSessionName(conversation)
  const liveEvents = getLiveConversationSession(context, conversation)?.events ?? []
  const transcriptWindow = await readTranscriptEventsWindow(sessionName, 1, liveEvents)
  return transcriptWindow.messages.length > 0
}

function mayHavePriorConversationHistory(conversation: Conversation): boolean {
  return Boolean(conversation.providerContext)
    || conversation.createdAt !== conversation.lastMessageAt
    || conversation.completedTasks > 0
    || conversation.heartbeatTickCount > 0
}

export class ConversationProviderSwapConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationProviderSwapConflictError'
  }
}

export class ConversationProviderSwapUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationProviderSwapUnavailableError'
  }
}

export interface ConversationRuntimeSettingsValues {
  agentType: AgentType
  model?: string | null
  credentialPoolId?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
}

function liveSessionHasQueuedWork(liveSession: StreamSession): boolean {
  const queueSize = typeof liveSession.messageQueue?.size === 'number'
    ? liveSession.messageQueue.size
    : 0
  return Boolean(
    liveSession.currentQueuedMessage
      || (liveSession.pendingDirectSendMessages?.length ?? 0) > 0
      || queueSize > 0,
  )
}

export function getConversationRuntimeSettingsDisabledReason(
  context: CommanderRoutesContext,
  conversation: Conversation,
  nextAgentType: AgentType = conversation.agentType ?? resolveDefaultProviderId(),
): string | null {
  if (conversation.status === 'archived') {
    return 'Archived conversations cannot change runtime settings'
  }
  if (getConversationRuntimeOverlay(conversation.id)?.state === 'starting') {
    return 'Conversation is starting; runtime settings cannot change until startup finishes'
  }

  const liveSession = getLiveConversationSession(context, conversation)
  if (!liveSession) {
    return null
  }
  if (!liveSession.lastTurnCompleted) {
    return 'Conversation is mid-turn; runtime settings can change after the current turn completes'
  }
  if (liveSessionHasQueuedWork(liveSession)) {
    return 'Conversation has queued work; runtime settings can change after the queue drains'
  }

  const canUpdateCodexInPlace = liveSession.agentType === 'codex'
    && nextAgentType === 'codex'
    && Boolean(context.sessionsInterface?.updateCommanderSessionRuntimeSettings)
  if (!canUpdateCodexInPlace && !context.sessionsInterface?.replaceCommanderSession) {
    return 'Live runtime settings updates are unavailable'
  }
  return null
}

function applyConversationRuntimeSettings(
  current: Conversation,
  settings: ConversationRuntimeSettingsValues,
  credentialSelectionAllowed: boolean,
): Conversation {
  const providerChanged = current.agentType !== settings.agentType
  const credentialPoolId = credentialSelectionAllowed
    ? settings.credentialPoolId
      ?? (providerChanged ? undefined : current.credentialPoolId)
    : undefined
  const credentialPoolChanged = credentialSelectionAllowed
    && credentialPoolId !== current.credentialPoolId
  const baseProviderContext = !credentialPoolChanged
    && current.providerContext?.providerId === settings.agentType
    ? { ...current.providerContext }
    : createProviderContextForAgentType(settings.agentType)
  delete (baseProviderContext as { effort?: unknown }).effort
  delete (baseProviderContext as { omitEffort?: unknown }).omitEffort
  delete (baseProviderContext as { adaptiveThinking?: unknown }).adaptiveThinking
  delete (baseProviderContext as { maxThinkingTokens?: unknown }).maxThinkingTokens
  if (settings.agentType === 'claude' && settings.effort === undefined) {
    ;(baseProviderContext as { omitEffort?: boolean }).omitEffort = true
  }
  const providerContext = sanitizeProviderContextForPersistence(baseProviderContext, {
    effort: settings.effort,
    adaptiveThinking: settings.adaptiveThinking,
    maxThinkingTokens: settings.maxThinkingTokens,
  }) ?? createProviderContextForAgentType(settings.agentType, {
    effort: settings.effort,
    omitEffort: settings.agentType === 'claude' && settings.effort === undefined,
    adaptiveThinking: settings.adaptiveThinking,
    maxThinkingTokens: settings.maxThinkingTokens,
  })

  return {
    ...current,
    agentType: settings.agentType,
    ...(Object.prototype.hasOwnProperty.call(settings, 'model')
      ? { model: settings.model }
      : {}),
    credentialPoolId,
    effort: settings.effort,
    adaptiveThinking: settings.adaptiveThinking,
    maxThinkingTokens: settings.maxThinkingTokens,
    providerContext,
    lastMessageAt: new Date().toISOString(),
  }
}

async function prepareConversationSession(
  context: CommanderRoutesContext,
  commanderId: string,
  conversation: Conversation,
  spawnOptions?: ConversationSpawnOptions,
): Promise<PreparedConversationSession> {
  const commander = await context.sessionStore.get(commanderId)
  if (!commander) {
    throw new Error(`Commander "${commanderId}" not found`)
  }
  if (!context.sessionsInterface) {
    throw new Error('sessionsInterface not configured')
  }

  const commanderAgentType = commander.agentType ?? resolveDefaultProviderId()
  const agentType = spawnOptions?.agentType ?? conversation.agentType ?? commanderAgentType
  const provider = getProvider(agentType)
  const cwd = commander.cwd ?? undefined
  const machineId = commander.executionMachineId
  const sessionName = buildConversationSessionName(conversation)
  const liveSession = context.sessionsInterface.getSession(sessionName)
  const queuedCredentialRecovery = context.sessionsInterface.getCredentialRecoveryRequest?.(sessionName)
  const liveCredentialRecovery = liveSession?.credentialPoolRecovery
  const credentialRecovery = queuedCredentialRecovery?.provider === agentType
    ? queuedCredentialRecovery
    : liveCredentialRecovery?.provider === agentType
      ? liveCredentialRecovery
      : undefined
  const credentialPoolId = spawnOptions?.credentialPoolId
    ?? credentialRecovery?.credentialPoolId
    ?? (
      resolveConversationCredentialSelectionMode(
        agentType,
        liveSession?.host ?? machineId,
      ) === 'per-conversation'
      && conversation.agentType === agentType
        ? conversation.credentialPoolId
        : undefined
    )
  const modelAccountId = liveSession?.agentType === agentType
    ? liveSession.providerAuthSnapshot?.accountId ?? liveSession.providerAuthSnapshot?.accountEmail
    : undefined
  const providerModels = provider
    ? getCachedProviderModelsForValidation(provider, {
        credentialPoolId,
        ...(modelAccountId ? { accountId: modelAccountId } : {}),
      }).models
    : []
  const providerDefaults = provider ? resolveProviderDefaults(provider, providerModels) : undefined
  let clearResumeProviderContext = Boolean(
    spawnOptions?.clearResumeProviderContext
      || credentialRecovery?.clearResumeProviderContext,
  )
  let resumeProviderContext = clearResumeProviderContext
    ? undefined
    : conversation.providerContext
  let hasNativeResumeIdentifier = provider
    ? hasNativeProviderResumeIdentifier({
      provider,
      agentType,
      providerContext: resumeProviderContext,
      sessionName,
      cwd: cwd ?? process.env.HOME ?? '/tmp',
    })
    : false
  const resumeNotFoundRecoveryApplied = Boolean(
    hasNativeResumeIdentifier
      && !clearResumeProviderContext
      && await hasRecentResumeNotFoundFailure(
        context,
        conversation,
        sessionName,
        liveSession?.events ?? [],
      ),
  )
  if (resumeNotFoundRecoveryApplied) {
    clearResumeProviderContext = true
    resumeProviderContext = undefined
    hasNativeResumeIdentifier = false
  }
  const conversationProviderEffort = conversation.agentType === agentType
    ? conversation.effort
      ?? parseStoredAgentEffort(agentType, (resumeProviderContext as { effort?: unknown } | undefined)?.effort)
      ?? undefined
    : undefined
  const conversationClaudeContext = conversation.agentType === agentType
    ? asClaudeProviderContext(resumeProviderContext)
    : null
  const commanderClaudeContext = commander.agentType === agentType
    ? asClaudeProviderContext(commander.providerContext)
    : null
  const hasSpawnModel = spawnOptions
    ? Object.prototype.hasOwnProperty.call(spawnOptions, 'model')
    : false
  const hasSpawnEffort = spawnOptions
    ? Object.prototype.hasOwnProperty.call(spawnOptions, 'effort')
    : false
  const hasSpawnAdaptiveThinking = spawnOptions
    ? Object.prototype.hasOwnProperty.call(spawnOptions, 'adaptiveThinking')
    : false
  const hasSpawnMaxThinkingTokens = spawnOptions
    ? Object.prototype.hasOwnProperty.call(spawnOptions, 'maxThinkingTokens')
    : false
  const hasStoredConversationModel = conversation.agentType === agentType
    && Object.prototype.hasOwnProperty.call(conversation, 'model')
    && conversation.model !== undefined
  const conversationModel = hasStoredConversationModel
    ? (conversation.model ?? providerDefaults?.model ?? undefined)
    : undefined
  const inheritedModel = conversationModel ?? (agentType === commanderAgentType
    ? (commander.model ?? undefined)
    : undefined)
  const model = hasSpawnModel
    ? (spawnOptions?.model ?? undefined)
    : inheritedModel ?? (hasNativeResumeIdentifier ? undefined : providerDefaults?.model) ?? undefined
  const findModelOption = (candidate: string | undefined): ProviderModelOption | undefined => {
    if (!candidate) {
      return providerModels.find((option) => option.default)
    }
    return providerModels.find((option) => (
      option.id === candidate
      || option.resolvedModel === candidate
      || option.aliases?.includes(candidate) === true
    ))
  }
  const modelOption = findModelOption(model ?? providerDefaults?.model ?? undefined)
  const modelEffortCapability = getAgentModelEffortCapability(agentType, modelOption)
  const supportedEffortLevels = modelEffortCapability.supportedEffortLevels
  const modelSupportsEffort = provider?.uiCapabilities.supportsEffort === true
    && modelEffortCapability.supportsEffort
  const defaultEffort = getDefaultAgentEffortForModel(
    agentType,
    modelOption,
    providerDefaults?.effort,
  )
  const inheritedEffort = hasSpawnEffort
    ? spawnOptions?.effort
    : conversationProviderEffort
      ?? parseStoredAgentEffort(agentType, commander.effort)
      ?? commanderClaudeContext?.effort
      ?? defaultEffort
  const normalizedEffort = modelSupportsEffort
    ? inheritedEffort && supportedEffortLevels.includes(inheritedEffort)
      ? inheritedEffort
      : defaultEffort
    : undefined
  const spawnKeepsStoredModel = hasSpawnModel
    && spawnOptions?.model !== null
    && spawnOptions?.model === conversation.model
  const omitEffort = provider?.uiCapabilities.supportsEffort === true && (
    !modelEffortCapability.supportsEffort
    || (hasSpawnEffort && spawnOptions?.effort === undefined)
    || (
      conversationClaudeContext?.omitEffort === true
      && (!hasSpawnModel || spawnKeepsStoredModel)
    )
  )
  const effort = omitEffort ? undefined : normalizedEffort
  const modelSupportsAdaptiveThinking = provider?.uiCapabilities.supportsAdaptiveThinking === true
    && modelOption?.supportsAdaptiveThinking !== false
  const adaptiveThinking = modelSupportsAdaptiveThinking
    ? hasSpawnAdaptiveThinking
      ? spawnOptions?.adaptiveThinking
      : conversationClaudeContext?.adaptiveThinking
        ?? commander.adaptiveThinking
        ?? commanderClaudeContext?.adaptiveThinking
        ?? providerDefaults?.adaptiveThinking
    : undefined
  const maxThinkingTokens = provider?.uiCapabilities.supportsMaxThinkingTokens
    ? hasSpawnMaxThinkingTokens
      ? spawnOptions?.maxThinkingTokens
      : conversationClaudeContext?.maxThinkingTokens
        ?? commander.maxThinkingTokens
        ?? commanderClaudeContext?.maxThinkingTokens
        ?? providerDefaults?.maxThinkingTokens
    : undefined
  const hasPriorTranscriptMessages = hasNativeResumeIdentifier || !mayHavePriorConversationHistory(conversation)
    ? false
    : await hasConversationTranscriptMessages(context, conversation)
  const workflow = await resolveCommanderWorkflow(
    commanderId,
    cwd,
    context.commanderBasePath,
  )
  const built = await buildCommanderSessionSeedFromResolvedWorkflow(
    {
      commanderId,
      cwd,
      currentTask: conversation.currentTask,
      taskSource: commander.taskSource,
      maxTurns: commander.maxTurns,
      memoryBasePath: context.commanderBasePath,
      ...(hasPriorTranscriptMessages
        ? { priorConversation: { conversationId: conversation.id } }
        : {}),
    },
    workflow,
  )
  const baseSystemPrompt = agentType === 'claude'
    ? appendClaudeReasoningPolicy(built.systemPrompt)
    : built.systemPrompt
  const gaiaOpsEnvRequired = isGaiaSystemCommander(commander)
  const systemPrompt = gaiaOpsEnvRequired
    ? appendGaiaOpsSkillGuide(baseSystemPrompt)
    : baseSystemPrompt

  return {
    commander,
    sessionName,
    createSessionInput: {
      name: sessionName,
      commanderId,
      conversationId: conversation.id,
      systemPrompt,
      agentType,
      model,
      effort,
      ...(omitEffort ? { omitEffort: true } : {}),
      adaptiveThinking,
      maxThinkingTokens,
      cwd,
      machineId,
      resumeProviderContext,
      credentialPoolId,
      maxTurns: built.maxTurns,
    },
    gaiaOpsEnvRequired,
    credentialRecoveryApplied: Boolean(credentialRecovery),
    resumeNotFoundRecoveryApplied,
    resumingNativeSession: hasNativeResumeIdentifier,
  }
}

function applyLiveSessionState(
  current: Conversation,
  liveSession: StreamSession | null,
  nextAgentType: AgentType,
  nextStatus: Conversation['status'],
  targetMachineId?: string | null,
): Conversation {
  const persistCredentialPoolId = resolveConversationCredentialSelectionMode(
    nextAgentType,
    liveSession?.host ?? targetMachineId,
  ) === 'per-conversation'
  return {
    ...current,
    agentType: nextAgentType,
    model: liveSession?.model,
    effort: liveSession?.effort,
    adaptiveThinking: liveSession?.adaptiveThinking,
    maxThinkingTokens: liveSession?.maxThinkingTokens,
    providerContext: sanitizeConversationProviderContext(liveSession) ?? current.providerContext,
    credentialPoolId: persistCredentialPoolId
      ? liveSession?.credentialPoolId
        ?? (current.agentType === nextAgentType ? current.credentialPoolId : undefined)
      : undefined,
    status: nextStatus,
    lastHeartbeat: nextStatus === 'active' ? null : current.lastHeartbeat,
    heartbeatTickCount: nextStatus === 'active' ? 0 : current.heartbeatTickCount,
    lastMessageAt: new Date().toISOString(),
  }
}

function sanitizeConversationProviderContext(
  session: StreamSession | null | undefined,
): Conversation['providerContext'] | undefined {
  if (!session) {
    return undefined
  }

  return sanitizeProviderContextForPersistence(session.providerContext, {
    effort: session.effort,
    adaptiveThinking: session.adaptiveThinking,
    maxThinkingTokens: session.maxThinkingTokens,
  }) ?? undefined
}

function withoutRuntimeSettings(
  providerContext: Conversation['providerContext'] | null | undefined,
): Record<string, unknown> | null {
  if (!providerContext) {
    return null
  }
  const {
    effort: _effort,
    omitEffort: _omitEffort,
    adaptiveThinking: _adaptiveThinking,
    maxThinkingTokens: _maxThinkingTokens,
    ...resumeContext
  } = providerContext as unknown as Record<string, unknown>
  return resumeContext
}

function hasFreshGaiaOpsApiKey(liveSession: StreamSession, now: Date): boolean {
  const expiresAt = liveSession.gaiaOpsApiKeyExpiresAt
  if (!expiresAt) {
    return false
  }
  const expiresAtMs = Date.parse(expiresAt)
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime()
}

function isCompatibleLiveConversationSession(
  liveSession: StreamSession | undefined,
  createSessionInput: PreparedConversationSession['createSessionInput'],
  options?: {
    gaiaOpsEnvRequired?: boolean
    now?: Date
  },
): liveSession is StreamSession {
  if (!liveSession) {
    return false
  }
  if (liveSession.credentialPoolRecovery) {
    return false
  }
  if (
    createSessionInput.credentialPoolId
    && liveSession.credentialPoolId !== createSessionInput.credentialPoolId
  ) {
    return false
  }
  if (options?.gaiaOpsEnvRequired && !hasFreshGaiaOpsApiKey(liveSession, options.now ?? new Date())) {
    return false
  }

  const expectedCwd = createSessionInput.cwd ?? process.env.HOME ?? '/tmp'
  const liveProviderContext = sanitizeConversationProviderContext(liveSession)
  const liveRuntimeSettings = liveProviderContext as {
    effort?: AgentEffortLevel
    adaptiveThinking?: ClaudeAdaptiveThinkingMode
    maxThinkingTokens?: ClaudeMaxThinkingTokens
  } | undefined
  const runtimeSettingsMatch = (
    (liveSession.effort ?? liveRuntimeSettings?.effort) === undefined
      || (liveSession.effort ?? liveRuntimeSettings?.effort) === createSessionInput.effort
  ) && (
    (liveSession.adaptiveThinking ?? liveRuntimeSettings?.adaptiveThinking) === undefined
      || (liveSession.adaptiveThinking ?? liveRuntimeSettings?.adaptiveThinking) === createSessionInput.adaptiveThinking
  ) && (
    (liveSession.maxThinkingTokens ?? liveRuntimeSettings?.maxThinkingTokens) === undefined
      || (liveSession.maxThinkingTokens ?? liveRuntimeSettings?.maxThinkingTokens) === createSessionInput.maxThinkingTokens
  )
  return liveSession.agentType === createSessionInput.agentType
    && liveSession.model === createSessionInput.model
    && liveSession.cwd === expectedCwd
    && (
      createSessionInput.machineId === undefined
      || (liveSession.host ?? 'local') === createSessionInput.machineId
    )
    && runtimeSettingsMatch
    && isDeepStrictEqual(
      withoutRuntimeSettings(liveProviderContext),
      withoutRuntimeSettings(createSessionInput.resumeProviderContext),
    )
}

function refreshLiveConversationSessionPrompt(
  liveSession: StreamSession,
  createSessionInput: PreparedConversationSession['createSessionInput'],
): void {
  liveSession.systemPrompt = createSessionInput.systemPrompt
  liveSession.maxTurns = createSessionInput.maxTurns
}

export async function updateCommanderDerivedState(
  context: CommanderRoutesContext,
  commanderId: string,
): Promise<void> {
  const commander = await context.sessionStore.get(commanderId)
  if (!commander) {
    return
  }

  const conversations = await context.conversationStore.listByCommander(commanderId)
  const hasLiveSession = conversations.some((conversation) => {
    if (conversation.status !== 'active') {
      return false
    }
    return Boolean(getLiveConversationSession(context, conversation))
  })

  await context.sessionStore.update(commanderId, (current) => {
    // `stopped` is the explicit operator-set terminal state. Conversation-level
    // mutations (pause/archive/message delivery) must not silently revive a
    // stopped commander to running/idle — only POST /api/commanders/:id/start
    // can transition out of stopped. See codex-review P2 on PR #1279
    // (comment 3174988519).
    if (current.state === 'stopped') {
      return current
    }
    return {
      ...current,
      state: hasLiveSession ? 'running' : 'idle',
    }
  })
}

export async function startConversationSession(
  context: CommanderRoutesContext,
  commanderId: string,
  conversation: Conversation,
  initialMessage?: string | null,
  spawnOptions?: ConversationSpawnOptions,
  sendOptions: { intent: SessionSendIntent; priority?: 'high' | 'normal' | 'low' } = { intent: 'interrupt' },
  dispatchChannelReplies = false,
  channelReplySkipCompletedTurns = 0,
  lifecycleCallbacks?: ConversationStartLifecycleCallbacks,
  resumeRecoveryAttempted = false,
): Promise<{ conversation: Conversation; sent: boolean }> {
  const prepared = await prepareConversationSession(
    context,
    commanderId,
    conversation,
    spawnOptions,
  )
  const sessionsInterface = context.sessionsInterface
  if (!sessionsInterface) {
    throw new Error('sessionsInterface not configured')
  }
  const { sessionName } = prepared
  let createSessionInput = prepared.createSessionInput
  const recoveryAlreadyAttempted = resumeRecoveryAttempted || prepared.resumeNotFoundRecoveryApplied === true
  const conversationForStart = prepared.resumeNotFoundRecoveryApplied
    ? await clearConversationProviderContextForResumeRecovery(context, conversation)
    : conversation
  let reusingLiveSession = false
  let liveSession: StreamSession
  let updated: Conversation | null
  try {
    const launch = await withCommanderRuntimeLaunch(
      commanderId,
      context.commanderDataDir,
      async () => {
        try {
          const existingSession = sessionsInterface.getSession(sessionName)
          reusingLiveSession = isCompatibleLiveConversationSession(existingSession, createSessionInput, {
            gaiaOpsEnvRequired: prepared.gaiaOpsEnvRequired,
            now: context.now(),
          })
          const replacingForCredentialRecovery = Boolean(
            existingSession && !reusingLiveSession && prepared.credentialRecoveryApplied,
          )
          const replacingForGaiaOpsEnvRefresh = Boolean(
            existingSession
            && !reusingLiveSession
            && prepared.gaiaOpsEnvRequired
            && sessionsInterface.replaceCommanderSession,
          )
          if (reusingLiveSession && existingSession) {
            refreshLiveConversationSessionPrompt(existingSession, createSessionInput)
          } else if (!replacingForCredentialRecovery && !replacingForGaiaOpsEnvRefresh) {
            removeChannelReplyForwarder(context, sessionName, conversationForStart)
            sessionsInterface.deleteSession(sessionName)
          }

          if (!reusingLiveSession && prepared.gaiaOpsEnvRequired) {
            const gaiaOpsEnv = await buildGaiaOpsEnvWithMetadata(
              context,
              prepared.commander,
              conversationForStart,
            )
            if (gaiaOpsEnv) {
              createSessionInput = {
                ...createSessionInput,
                env: gaiaOpsEnv.env,
                gaiaOpsApiKeyExpiresAt: gaiaOpsEnv.apiKeyExpiresAt,
              }
            }
          }

          let launchedSession: StreamSession
          if (reusingLiveSession && existingSession) {
            launchedSession = existingSession
          } else if (
            (replacingForCredentialRecovery || replacingForGaiaOpsEnvRefresh)
            && sessionsInterface.replaceCommanderSession
          ) {
            launchedSession = await sessionsInterface.replaceCommanderSession(createSessionInput)
            if (prepared.credentialRecoveryApplied) {
              sessionsInterface.clearCredentialRecoveryRequest?.(sessionName)
            }
          } else {
            launchedSession = await sessionsInterface.createCommanderSession(createSessionInput)
            if (prepared.credentialRecoveryApplied) {
              sessionsInterface.clearCredentialRecoveryRequest?.(sessionName)
            }
          }
          if (!reusingLiveSession && createSessionInput.gaiaOpsApiKeyExpiresAt) {
            launchedSession.gaiaOpsApiKeyExpiresAt = createSessionInput.gaiaOpsApiKeyExpiresAt
          }

          const activated = await context.conversationStore.update(
            conversationForStart.id,
            (current) => ({
              ...applyLiveSessionState(
                current,
                launchedSession,
                createSessionInput.agentType,
                'active',
                createSessionInput.machineId,
              ),
            }),
          )
          return { ok: true as const, liveSession: launchedSession, updated: activated }
        } catch (error) {
          // Provider launch/replace can cross a process boundary before throwing.
          // Advance the generation before surfacing the error so a stale package
          // receipt cannot delete the parent around an uncertain live runtime.
          return { ok: false as const, error }
        }
      },
    )
    if (!launch.ok) {
      throw launch.error
    }
    liveSession = launch.liveSession
    updated = launch.updated
  } catch (error) {
    if (
      !recoveryAlreadyAttempted &&
      createSessionInput.resumeProviderContext &&
      isResumeNotFoundError(error)
    ) {
      sessionsInterface.deleteSession(sessionName)
      const recoveredConversation = await clearConversationProviderContextForResumeRecovery(context, conversationForStart)
      return startConversationSession(
        context,
        commanderId,
        recoveredConversation,
        initialMessage,
        {
          ...spawnOptions,
          clearResumeProviderContext: true,
        },
        sendOptions,
        dispatchChannelReplies,
        channelReplySkipCompletedTurns,
        lifecycleCallbacks,
        true,
      )
    }
    throw error
  }
  lifecycleCallbacks?.onConversationActivated?.(updated ?? conversationForStart)
  await updateCommanderDerivedState(context, commanderId)
  const heartbeatConversation = updated ?? conversationForStart
  context.heartbeatManager.start(
    heartbeatConversation.id,
    commanderId,
    prepared.commander.heartbeat,
  )
  const isBackendStartupPrompt = initialMessage == null
    && !reusingLiveSession
    && !prepared.resumingNativeSession
  if (dispatchChannelReplies) {
    ensureChannelReplyForwarder(context, heartbeatConversation, {
      skipCompletedTurns: isBackendStartupPrompt
        ? channelReplySkipCompletedTurns
        : 0,
    })
  }

  const messageToSend = initialMessage ?? (isBackendStartupPrompt ? STARTUP_PROMPT : null)
  const sent = messageToSend
    ? await sessionsInterface.sendToSession(
      sessionName,
      isBackendStartupPrompt
        ? { text: messageToSend, userEventSubtype: COMMANDER_STARTUP_USER_EVENT_SUBTYPE }
        : messageToSend,
      sendOptions,
    )
    : { ok: true as const, disposition: 'started' as const }
  if (!sent.ok) {
    const failedSession = sessionsInterface.getSession(sessionName) ?? liveSession
    const resumeNotFoundFailure = !recoveryAlreadyAttempted &&
      createSessionInput.resumeProviderContext &&
      (
        failedSession.events.some(isResumeNotFoundEvent) ||
        await hasRecentResumeNotFoundFailure(context, conversationForStart, sessionName, failedSession.events)
      )
    if (resumeNotFoundFailure) {
      context.heartbeatManager.stop(heartbeatConversation.id)
      removeChannelReplyForwarder(context, sessionName, heartbeatConversation)
      sessionsInterface.deleteSession(sessionName)
      await context.conversationStore.update(conversationForStart.id, (current) => ({
        ...current,
        status: 'idle',
      }))
      await updateCommanderDerivedState(context, commanderId)
      const recoveredConversation = await clearConversationProviderContextForResumeRecovery(context, conversationForStart)
      return startConversationSession(
        context,
        commanderId,
        recoveredConversation,
        initialMessage,
        {
          ...spawnOptions,
          clearResumeProviderContext: true,
        },
        sendOptions,
        dispatchChannelReplies,
        channelReplySkipCompletedTurns,
        lifecycleCallbacks,
        true,
      )
    }
    context.heartbeatManager.stop(heartbeatConversation.id)
    removeChannelReplyForwarder(context, sessionName, heartbeatConversation)
    sessionsInterface.deleteSession(sessionName)
    await context.conversationStore.update(conversationForStart.id, (current) => ({
      ...current,
      status: 'idle',
    }))
    await updateCommanderDerivedState(context, commanderId)
    return {
      conversation: updated ?? conversationForStart,
      sent: false,
    }
  }

  return {
    conversation: updated ?? conversationForStart,
    sent: true,
  }
}

export async function updateConversationRuntimeSettings(
  context: CommanderRoutesContext,
  conversation: Conversation,
  settings: ConversationRuntimeSettingsValues,
): Promise<Conversation> {
  const liveSession = getLiveConversationSession(context, conversation)
  const commander = await context.sessionStore?.get(conversation.commanderId)
  const targetMachineId = liveSession?.host ?? commander?.executionMachineId
  const credentialSelectionAllowed = resolveConversationCredentialSelectionMode(
    settings.agentType,
    targetMachineId,
  ) === 'per-conversation'
  const effectiveSettings = !credentialSelectionAllowed
    ? { ...settings, credentialPoolId: undefined }
    : settings.credentialPoolId === undefined
      && conversation.agentType === settings.agentType
      ? { ...settings, credentialPoolId: conversation.credentialPoolId ?? undefined }
      : settings
  const disabledReason = getConversationRuntimeSettingsDisabledReason(
    context,
    conversation,
    effectiveSettings.agentType,
  )
  if (disabledReason) {
    throw new ConversationProviderSwapConflictError(disabledReason)
  }

  if (!liveSession) {
    const updated = await context.conversationStore.update(conversation.id, (current) => ({
      ...applyConversationRuntimeSettings(current, effectiveSettings, credentialSelectionAllowed),
    }))
    return updated ?? conversation
  }

  const sessionsInterface = context.sessionsInterface
  if (
    liveSession.agentType === 'codex'
    && effectiveSettings.agentType === 'codex'
    && effectiveSettings.credentialPoolId === (liveSession.credentialPoolId ?? conversation.credentialPoolId)
    && sessionsInterface?.updateCommanderSessionRuntimeSettings
  ) {
    const updatedSession = sessionsInterface.updateCommanderSessionRuntimeSettings(
      buildConversationSessionName(conversation),
      effectiveSettings,
    )
    if (!updatedSession) {
      throw new ConversationProviderSwapUnavailableError(
        `Conversation "${conversation.id}" has no updateable live session`,
      )
    }
    const updated = await context.conversationStore.update(conversation.id, (current) => (
      applyLiveSessionState(
        applyConversationRuntimeSettings(current, effectiveSettings, credentialSelectionAllowed),
        updatedSession,
        effectiveSettings.agentType,
        'active',
        targetMachineId,
      )
    ))
    return updated ?? conversation
  }
  if (!sessionsInterface?.replaceCommanderSession) {
    throw new ConversationProviderSwapUnavailableError(
      'sessionsInterface does not support live runtime settings updates',
    )
  }
  const prepared = await prepareConversationSession(
    context,
    conversation.commanderId,
    conversation,
    {
      agentType: effectiveSettings.agentType,
      ...(Object.prototype.hasOwnProperty.call(effectiveSettings, 'model')
        ? { model: effectiveSettings.model }
        : {}),
      credentialPoolId: effectiveSettings.credentialPoolId,
      effort: effectiveSettings.effort,
      adaptiveThinking: effectiveSettings.adaptiveThinking,
      maxThinkingTokens: effectiveSettings.maxThinkingTokens,
      clearResumeProviderContext: liveSession.agentType !== effectiveSettings.agentType
        || (
          credentialSelectionAllowed
          && effectiveSettings.credentialPoolId !== (liveSession.credentialPoolId ?? conversation.credentialPoolId)
        ),
    },
  )
  let replacement: StreamSession
  try {
    replacement = await sessionsInterface.replaceCommanderSession({
      ...prepared.createSessionInput,
      requireIdleReplacement: true,
    })
  } catch (error) {
    if (error instanceof CommanderSessionReplacementConflictError) {
      throw new ConversationProviderSwapConflictError(error.message)
    }
    throw error
  }

  const updated = await context.conversationStore.update(conversation.id, (current) => ({
    ...applyLiveSessionState(
      applyConversationRuntimeSettings(current, effectiveSettings, credentialSelectionAllowed),
      replacement,
      effectiveSettings.agentType,
      'active',
      prepared.createSessionInput.machineId,
    ),
  }))
  await updateCommanderDerivedState(context, conversation.commanderId)
  return updated ?? conversation
}

export async function swapConversationProvider(
  context: CommanderRoutesContext,
  conversation: Conversation,
  agentType: AgentType,
  spawnOptions?: Omit<ConversationSpawnOptions, 'agentType'>,
): Promise<Conversation> {
  const providerChanged = conversation.agentType !== agentType
  const provider = getProvider(agentType)
  const defaults = provider ? resolveProviderDefaults(provider) : undefined
  const modelProvided = spawnOptions
    ? Object.prototype.hasOwnProperty.call(spawnOptions, 'model')
    : false
  return updateConversationRuntimeSettings(context, conversation, {
    agentType,
    ...(modelProvided
      ? { model: spawnOptions?.model ?? null }
      : providerChanged
        ? { model: null }
        : {}),
    credentialPoolId: spawnOptions?.credentialPoolId
      ?? (providerChanged ? undefined : conversation.credentialPoolId),
    effort: spawnOptions?.effort
      ?? (providerChanged ? defaults?.effort : conversation.effort),
    adaptiveThinking: spawnOptions?.adaptiveThinking
      ?? (providerChanged ? defaults?.adaptiveThinking : conversation.adaptiveThinking),
    maxThinkingTokens: spawnOptions?.maxThinkingTokens
      ?? (providerChanged ? defaults?.maxThinkingTokens : conversation.maxThinkingTokens),
  })
}

export interface DeliverConversationMessageOptions {
  intent?: SessionSendIntent
  priority?: 'high' | 'normal' | 'low'
  dispatchChannelReplies?: boolean
  /**
   * When `true`, an `idle` conversation is auto-started before delivering the
   * message instead of returning 409. Channel webhook surfaces keep the
   * commander startup seed before queueing inbound text; UI text sends opt out
   * of that seed so the user's submitted message is dispatched once.
   */
  autoStartIdle?: boolean
  autoStartSeedPrompt?: boolean
  /**
   * Spawn options applied when `autoStartIdle` triggers `startConversationSession`.
   * Ignored when the conversation is already active.
   */
  startSpawnOptions?: ConversationSpawnOptions
  abortSignal?: AbortSignal
}

export interface ConversationMessagePayload {
  message: string
  displayMessage?: string
  images?: QueuedMessageImage[]
  clientSendId?: string
}

type DeliverConversationMessageSuccess = {
  ok: true
  createdSession: boolean
  conversation: Conversation
  disposition: SessionSendDisposition | 'duplicate'
  operationId?: string
}

type DeliverConversationMessageFailure = {
  ok: false
  status: number
  error: string
  code?: string
  retryable?: boolean
}

type DeliverConversationMessageResult =
  | DeliverConversationMessageSuccess
  | DeliverConversationMessageFailure

interface DeepThinkingWorkerLaunch {
  stage: 'research' | 'thinking'
  role: typeof DEEP_THINKING_RESEARCH_ROLES[number] | typeof DEEP_THINKING_THINKING_ROLES[number]
  sessionName: string
}

interface DeepThinkingWorkerOutput extends DeepThinkingWorkerLaunch {
  status: 'completed' | 'timeout' | 'unavailable'
  output: string
}

function nextDeepThinkingWorkerName(
  conversation: Conversation,
  role: DeepThinkingWorkerLaunch['role'],
  now: Date,
): string {
  deepThinkingDispatchSequence = (deepThinkingDispatchSequence + 1) % Number.MAX_SAFE_INTEGER
  return [
    'deepthink',
    conversation.id.slice(0, 8),
    now.getTime().toString(36),
    String(deepThinkingDispatchSequence),
    role,
  ].join('-')
}

function buildDeepThinkingWorkerTask(input: {
  stage: DeepThinkingWorkerLaunch['stage']
  role: DeepThinkingWorkerLaunch['role']
  conversation: Conversation
  originalMessage: string
  researchOutputs?: readonly DeepThinkingWorkerOutput[]
}): string {
  const roleInstruction = (() => {
    switch (input.role) {
      case 'context-research':
        return 'Research pass: gather the most relevant facts, source/code context, constraints, prior decisions, and missing information for the request. Return concise findings and cite concrete evidence when available.'
      case 'risk-research':
        return 'Research pass: look for contradictory evidence, fragile assumptions, prior failures, and risks that would make a direct answer shallow or wrong. Return concise findings and caveats.'
      case 'inversion-thinking':
        return 'Thinking pass: reason by inversion. Identify how the answer could fail, what advice should be rejected, and what assumptions need qualification.'
      case 'synthesis-thinking':
        return 'Thinking pass: reason from first principles and synthesize the strongest answer direction from the research outputs.'
      case 'operational-thinking':
        return 'Thinking pass: convert the research into concrete actions, tradeoffs, and decision criteria.'
    }
  })()
  const researchSection = input.researchOutputs && input.researchOutputs.length > 0
    ? [
        '',
        'Research worker outputs to use:',
        formatDeepThinkingWorkerOutputs(input.researchOutputs, DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS),
      ].join('\n')
    : ''

  return [
    'You are a bounded deep-thinking worker launched by Herd for a commander conversation.',
    roleInstruction,
    '',
    `Commander conversation: ${input.conversation.id}`,
    '',
    'Original user request:',
    input.originalMessage,
    researchSection,
    '',
    'Return your findings in a compact form for the main commander conversation to synthesize. Do not continue beyond this single pass.',
  ].join('\n')
}

function buildDeepThinkingSynthesisMessage(input: {
  originalMessage: string
  researchOutputs: readonly DeepThinkingWorkerOutput[]
  thinkingOutputs: readonly DeepThinkingWorkerOutput[]
}): string {
  return [
    'Deep-thinking routing guardrail engaged.',
    'The user explicitly requested substantive deep thinking, so Herd completed bounded research and thinking worker passes before this synthesis turn.',
    '',
    'Original user request:',
    input.originalMessage,
    '',
    'Research worker outputs:',
    formatDeepThinkingWorkerOutputs(input.researchOutputs, DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS),
    '',
    'Thinking worker outputs:',
    formatDeepThinkingWorkerOutputs(input.thinkingOutputs, DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS),
    '',
    'Synthesize the final answer from the worker outputs above. Do not fake iterative rounds with labels unless the substance is grounded in the worker findings.',
  ].join('\n')
}

function truncateDeepThinkingPromptInput(value: string, remainingBudget: number): { text: string; truncated: boolean } {
  if (value.length <= remainingBudget) {
    return { text: value, truncated: false }
  }
  const marker = `\n[truncated: exceeded deep-thinking prompt budget of ${DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS} characters]`
  if (remainingBudget <= marker.length) {
    return { text: marker.slice(0, Math.max(0, remainingBudget)), truncated: true }
  }
  return {
    text: `${value.slice(0, remainingBudget - marker.length)}${marker}`,
    truncated: true,
  }
}

function formatDeepThinkingWorkerOutputs(
  outputs: readonly DeepThinkingWorkerOutput[],
  maxChars = DEEP_THINKING_WORKER_OUTPUT_PROMPT_BUDGET_CHARS,
): string {
  if (outputs.length === 0) {
    return '- none'
  }
  const sections: string[] = []
  let usedChars = 0
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]
    const section = [
      `- ${output.stage}/${output.role} (${output.sessionName}, ${output.status}):`,
      output.output,
    ].join('\n')
    const separatorLength = sections.length > 0 ? 1 : 0
    const remaining = maxChars - usedChars - separatorLength
    if (remaining <= 0) {
      sections.push(`[truncated: omitted ${outputs.length - index} worker output(s) after deep-thinking prompt budget of ${maxChars} characters]`)
      break
    }
    const truncated = truncateDeepThinkingPromptInput(section, remaining)
    sections.push(truncated.text)
    usedChars += separatorLength + truncated.text.length
    if (truncated.truncated) {
      const omitted = outputs.length - index - 1
      if (omitted > 0) {
        sections.push(`[truncated: omitted ${omitted} worker output(s) after deep-thinking prompt budget of ${maxChars} characters]`)
      }
      break
    }
  }
  return sections.join('\n')
}

function extractDeepThinkingFinalText(event: StreamJsonEvent | undefined): string | null {
  if (!event) {
    return null
  }
  if ('ev' in event && event.ev && typeof event.ev === 'object') {
    const result = (event.ev as { result?: unknown; error?: unknown }).result
    if (typeof result === 'string' && result.trim()) {
      return result.trim()
    }
    const error = (event.ev as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) {
      return error.trim()
    }
  }
  const result = (event as { result?: unknown }).result
  if (typeof result === 'string' && result.trim()) {
    return result.trim()
  }
  const text = (event as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

function extractDeepThinkingAssistantText(events: readonly StreamJsonEvent[]): string | null {
  const messages = mapStreamEventsToMessages(events)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== 'agent') {
      continue
    }
    const text = message.text.trim()
    if (text) {
      return text
    }
  }
  return null
}

function extractDeepThinkingWorkerOutput(session: StreamSession): string {
  return (
    extractDeepThinkingFinalText(session.finalResultEvent) ??
    extractDeepThinkingAssistantText(session.events) ??
    'completed without captured text output'
  )
}

class DeepThinkingRoutingAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepThinkingRoutingAbortError'
  }
}

class DeepThinkingRoutingTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepThinkingRoutingTimeoutError'
  }
}

type DeepThinkingRoutingStatus = 'skipped' | 'started' | 'completed' | 'cancelled' | 'timed_out' | 'failed'

function deepThinkingOperationId(conversationId: string): string {
  deepThinkingDispatchSequence = (deepThinkingDispatchSequence + 1) % Number.MAX_SAFE_INTEGER
  return [
    'deepthink-route',
    conversationId.slice(0, 8),
    Date.now().toString(36),
    String(deepThinkingDispatchSequence),
  ].join('-')
}

function throwIfDeepThinkingAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return
  }
  const reason = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'deep-thinking routing was cancelled'
  throw new DeepThinkingRoutingAbortError(reason)
}

function sleepDeepThinkingPoll(ms: number, signal: AbortSignal): Promise<void> {
  throwIfDeepThinkingAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DeepThinkingRoutingAbortError('deep-thinking routing was cancelled'))
    }, { once: true })
  })
}

async function waitForDeepThinkingWorker(
  context: CommanderRoutesContext,
  worker: DeepThinkingWorkerLaunch,
  input: {
    signal: AbortSignal
    sessionName: string
  },
): Promise<DeepThinkingWorkerOutput> {
  const deadline = Date.now() + deepThinkingWorkerWaitTimeoutMs
  while (Date.now() <= deadline) {
    throwIfDeepThinkingAborted(input.signal)
    if (!context.sessionsInterface?.getSession(input.sessionName)) {
      throw new DeepThinkingRoutingAbortError('conversation session stopped')
    }
    const session = context.sessionsInterface?.getSession(worker.sessionName)
    if (!session) {
      return {
        ...worker,
        status: 'unavailable',
        output: 'worker session was not available for output collection',
      }
    }
    if (session.lastTurnCompleted) {
      return {
        ...worker,
        status: 'completed',
        output: extractDeepThinkingWorkerOutput(session),
      }
    }
    await sleepDeepThinkingPoll(deepThinkingWorkerPollMs, input.signal)
  }

  throw new DeepThinkingRoutingTimeoutError('worker did not finish before the bounded deep-thinking wait window')
}

async function launchDeepThinkingWorkers(input: {
  context: CommanderRoutesContext
  conversation: Conversation
  commander: CommanderSession
  liveSession: StreamSession
  originalMessage: string
  stage: DeepThinkingWorkerLaunch['stage']
  roles: readonly DeepThinkingWorkerLaunch['role'][]
  researchOutputs?: readonly DeepThinkingWorkerOutput[]
  signal: AbortSignal
  launchedWorkers: DeepThinkingWorkerLaunch[]
}): Promise<
  | {
    ok: true
    workers: DeepThinkingWorkerLaunch[]
  }
  | {
    ok: false
    status: number
    error: string
  }
> {
  const sessionsInterface = input.context.sessionsInterface
  if (!sessionsInterface) {
    return { ok: false, status: 500, error: 'sessionsInterface not configured' }
  }

  const workers: DeepThinkingWorkerLaunch[] = []
  for (const role of input.roles) {
    throwIfDeepThinkingAborted(input.signal)
    const sessionName = nextDeepThinkingWorkerName(input.conversation, role, input.context.now())
    const result = await sessionsInterface.dispatchWorkerForCommander({
      commanderId: input.conversation.commanderId,
      abortSignal: input.signal,
      trustedSourceDefaults: {
        agentType: input.liveSession.agentType,
        ...(input.liveSession.model !== undefined ? { model: input.liveSession.model } : {}),
        ...(input.liveSession.effort !== undefined ? { effort: input.liveSession.effort } : {}),
        ...(asClaudeProviderContext(input.liveSession.providerContext)?.omitEffort
          ? { omitEffort: true }
          : {}),
        ...(input.liveSession.adaptiveThinking !== undefined
          ? { adaptiveThinking: input.liveSession.adaptiveThinking }
          : {}),
        ...(input.liveSession.maxThinkingTokens !== undefined
          ? { maxThinkingTokens: input.liveSession.maxThinkingTokens }
          : {}),
      },
      rawBody: {
        name: sessionName,
        sessionType: 'worker',
        agentType: input.liveSession.agentType,
        ...(input.liveSession.model !== undefined ? { model: input.liveSession.model } : {}),
        ...(input.commander.cwd !== undefined ? { cwd: input.commander.cwd } : {}),
        ...(input.liveSession.host ?? input.commander.executionMachineId
          ? { host: input.liveSession.host ?? input.commander.executionMachineId }
          : {}),
        ...(input.liveSession.effort !== undefined ? { effort: input.liveSession.effort } : {}),
        ...(input.liveSession.adaptiveThinking !== undefined ? { adaptiveThinking: input.liveSession.adaptiveThinking } : {}),
        ...(input.liveSession.maxThinkingTokens !== undefined ? { maxThinkingTokens: input.liveSession.maxThinkingTokens } : {}),
        task: buildDeepThinkingWorkerTask({
          stage: input.stage,
          role,
          conversation: input.conversation,
          originalMessage: input.originalMessage,
          researchOutputs: input.researchOutputs,
        }),
      },
    })
    if (result.status < 200 || result.status >= 300) {
      const detail = typeof result.body.error === 'string'
        ? result.body.error
        : 'worker dispatch failed'
      return {
        ok: false,
        status: result.status,
        error: `Deep-thinking worker dispatch failed: ${detail}`,
      }
    }
    const returnedSessionName = typeof result.body.sessionName === 'string'
      ? result.body.sessionName
      : sessionName
    const worker = { stage: input.stage, role, sessionName: returnedSessionName }
    workers.push(worker)
    input.launchedWorkers.push(worker)
  }

  return { ok: true, workers }
}

function recordDeepThinkingRoutingDecision(input: {
  context: CommanderRoutesContext
  sessionName: string
  conversation: Conversation
  operationId: string
  status: DeepThinkingRoutingStatus
  message: string
  workerCount?: number
  detail?: string
}): void {
  const event: StreamJsonEvent = {
    type: 'system',
    subtype: 'deep_thinking_routing',
    status: input.status,
    operationId: input.operationId,
    conversationId: input.conversation.id,
    commanderId: input.conversation.commanderId,
    text: input.message,
    ...(input.workerCount !== undefined ? { workerCount: input.workerCount } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    timestamp: input.context.now().toISOString(),
  } as StreamJsonEvent
  input.context.sessionsInterface?.recordSessionEvent?.(input.sessionName, event)
  console.info('[deep-thinking-routing]', {
    status: input.status,
    conversationId: input.conversation.id,
    operationId: input.operationId,
    workerCount: input.workerCount,
    detail: input.detail,
  })
}

function cleanupDeepThinkingWorkers(
  context: CommanderRoutesContext,
  workers: readonly DeepThinkingWorkerLaunch[],
): void {
  const uniqueNames = new Set(workers.map((worker) => worker.sessionName))
  for (const sessionName of uniqueNames) {
    context.sessionsInterface?.deleteSession(sessionName)
  }
}

function assertDeepThinkingWorkersAvailable(outputs: readonly DeepThinkingWorkerOutput[], stage: string): void {
  const unavailable = outputs.find((output) => output.status === 'unavailable')
  if (unavailable) {
    throw new Error(`${stage} worker "${unavailable.sessionName}" was unavailable for output collection`)
  }
}

function scheduleDeepThinkingOperation(run: () => Promise<void>): void {
  const timer = setTimeout(() => {
    void run()
  }, deepThinkingOperationScheduleDelayMs)
  timer.unref?.()
}

function linkDeepThinkingAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) {
    return () => {}
  }
  if (source.aborted) {
    target.abort(source.reason)
    return () => {}
  }
  const abort = () => target.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function registerDeepThinkingOperation(operation: DeepThinkingOperationRegistration): void {
  const conversationId = operation.conversation.id
  const previous = deepThinkingOperations.get(conversationId)
  previous?.controller.abort(new Error('superseded by a newer deep-thinking request'))
  deepThinkingOperations.set(conversationId, operation)
}

function completeDeepThinkingOperation(conversationId: string, controller: AbortController): void {
  if (deepThinkingOperations.get(conversationId)?.controller === controller) {
    deepThinkingOperations.delete(conversationId)
  }
}

function cancelDeepThinkingOperation(conversationId: string, reason: string): void {
  const operation = deepThinkingOperations.get(conversationId)
  if (!operation) {
    return
  }
  if (!operation.cancellationRecorded) {
    recordDeepThinkingRoutingDecision({
      context: operation.context,
      sessionName: operation.sessionName,
      conversation: operation.conversation,
      operationId: operation.operationId,
      status: 'cancelled',
      message: 'Deep-thinking routing cancelled; dispatched workers are being cleaned up.',
      detail: reason,
    })
    operation.cancellationRecorded = true
  }
  operation.controller.abort(new Error(reason))
}

function deepThinkingCancellationAlreadyRecorded(conversationId: string, operationId: string): boolean {
  const operation = deepThinkingOperations.get(conversationId)
  return operation?.operationId === operationId && operation.cancellationRecorded
}

async function runDeepThinkingRoutingOperation(input: {
  context: CommanderRoutesContext
  conversation: Conversation
  commander: CommanderSession
  liveSession: StreamSession
  sessionName: string
  payload: ConversationMessagePayload
  sendOptions: {
    intent: SessionSendIntent
    priority?: 'high' | 'normal' | 'low'
  }
  originalMessage: string
  operationId: string
  signal: AbortSignal
}): Promise<void> {
  const launchedWorkers: DeepThinkingWorkerLaunch[] = []
  try {
    throwIfDeepThinkingAborted(input.signal)
    const launchedResearch = await launchDeepThinkingWorkers({
      context: input.context,
      conversation: input.conversation,
      commander: input.commander,
      liveSession: input.liveSession,
      originalMessage: input.originalMessage,
      stage: 'research',
      roles: DEEP_THINKING_RESEARCH_ROLES,
      signal: input.signal,
      launchedWorkers,
    })
    if (!launchedResearch.ok) {
      cleanupDeepThinkingWorkers(input.context, launchedWorkers)
      recordDeepThinkingRoutingDecision({
        context: input.context,
        sessionName: input.sessionName,
        conversation: input.conversation,
        operationId: input.operationId,
        status: 'failed',
        message: `Deep-thinking routing failed: ${launchedResearch.error}`,
        workerCount: launchedWorkers.length,
        detail: launchedResearch.error,
      })
      return
    }

    const researchOutputs = await Promise.all(
      launchedResearch.workers.map((worker) => waitForDeepThinkingWorker(input.context, worker, {
        signal: input.signal,
        sessionName: input.sessionName,
      })),
    )
    assertDeepThinkingWorkersAvailable(researchOutputs, 'research')

    const launchedThinking = await launchDeepThinkingWorkers({
      context: input.context,
      conversation: input.conversation,
      commander: input.commander,
      liveSession: input.liveSession,
      originalMessage: input.originalMessage,
      stage: 'thinking',
      roles: DEEP_THINKING_THINKING_ROLES,
      researchOutputs,
      signal: input.signal,
      launchedWorkers,
    })
    if (!launchedThinking.ok) {
      cleanupDeepThinkingWorkers(input.context, launchedWorkers)
      recordDeepThinkingRoutingDecision({
        context: input.context,
        sessionName: input.sessionName,
        conversation: input.conversation,
        operationId: input.operationId,
        status: 'failed',
        message: `Deep-thinking routing failed: ${launchedThinking.error}`,
        workerCount: launchedWorkers.length,
        detail: launchedThinking.error,
      })
      return
    }

    const thinkingOutputs = await Promise.all(
      launchedThinking.workers.map((worker) => waitForDeepThinkingWorker(input.context, worker, {
        signal: input.signal,
        sessionName: input.sessionName,
      })),
    )
    assertDeepThinkingWorkersAvailable(thinkingOutputs, 'thinking')

    const sent = await input.context.sessionsInterface?.sendToSession(
      input.sessionName,
      {
        text: buildDeepThinkingSynthesisMessage({
          originalMessage: input.originalMessage,
          researchOutputs,
          thinkingOutputs,
        }),
        ...(input.payload.displayMessage !== undefined ? { displayText: input.payload.displayMessage.trim() } : {}),
        ...(input.payload.clientSendId ? { clientSendId: input.payload.clientSendId } : {}),
        images: input.payload.images && input.payload.images.length > 0 ? [...input.payload.images] : undefined,
      },
      input.sendOptions,
    )
    if (!sent?.ok) {
      cleanupDeepThinkingWorkers(input.context, launchedWorkers)
      recordDeepThinkingRoutingDecision({
        context: input.context,
        sessionName: input.sessionName,
        conversation: input.conversation,
        operationId: input.operationId,
        status: 'failed',
        message: `Deep-thinking routing failed: conversation "${input.conversation.id}" session unavailable`,
        workerCount: launchedWorkers.length,
      })
      return
    }
    recordDeepThinkingRoutingDecision({
      context: input.context,
      sessionName: input.sessionName,
      conversation: input.conversation,
      operationId: input.operationId,
      status: 'completed',
      message: 'Deep-thinking routing completed; synthesis prompt sent to the conversation.',
      workerCount: launchedWorkers.length,
    })
    cleanupDeepThinkingWorkers(input.context, launchedWorkers)
  } catch (error) {
    cleanupDeepThinkingWorkers(input.context, launchedWorkers)
    const aborted = error instanceof DeepThinkingRoutingAbortError
    const timedOut = error instanceof DeepThinkingRoutingTimeoutError
    const detail = error instanceof Error ? error.message : String(error)
    if (!aborted || !deepThinkingCancellationAlreadyRecorded(input.conversation.id, input.operationId)) {
      recordDeepThinkingRoutingDecision({
        context: input.context,
        sessionName: input.sessionName,
        conversation: input.conversation,
        operationId: input.operationId,
        status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        message: aborted
          ? 'Deep-thinking routing cancelled; dispatched workers were cleaned up.'
          : timedOut
            ? 'Deep-thinking routing timed out; dispatched workers were cleaned up.'
            : `Deep-thinking routing failed: ${detail}`,
        workerCount: launchedWorkers.length,
        detail,
      })
    }
  }
}

async function sendConversationPayloadWithDeepThinkingGuard(input: {
  context: CommanderRoutesContext
  conversation: Conversation
  commander: CommanderSession
  liveSession: StreamSession
  sessionName: string
  payload: ConversationMessagePayload
  sendOptions: {
    intent: SessionSendIntent
    priority?: 'high' | 'normal' | 'low'
  }
  abortSignal?: AbortSignal
}): Promise<
  | {
    ok: true
    disposition: SessionSendDisposition
    operationId?: string
  }
  | {
    ok: false
    status: number
    error: string
    code?: string
    retryable?: boolean
  }
> {
  const originalMessage = (input.payload.displayMessage ?? input.payload.message).trim()
  const hasDeepThinkingTrigger = originalMessage.length > 0
    && hasExplicitDeepThinkingTrigger(originalMessage)
  const shouldRouteDeepThinking = hasDeepThinkingTrigger
    && hasSubstantiveDeepThinkingSubject(originalMessage)

  if (hasDeepThinkingTrigger && !shouldRouteDeepThinking) {
    const operationId = deepThinkingOperationId(input.conversation.id)
    recordDeepThinkingRoutingDecision({
      context: input.context,
      sessionName: input.sessionName,
      conversation: input.conversation,
      operationId,
      status: 'skipped',
      message: 'Deep-thinking routing skipped: add a substantive task after the trigger phrase.',
    })
    return {
      ok: false,
      status: 400,
      error: 'Deep-thinking requests need substantive task text after the trigger phrase.',
    }
  }

  if (shouldRouteDeepThinking) {
    const operationId = deepThinkingOperationId(input.conversation.id)
    const controller = new AbortController()
    const unlinkAbortSignal = linkDeepThinkingAbortSignal(input.abortSignal, controller)
    registerDeepThinkingOperation({
      controller,
      context: input.context,
      conversation: input.conversation,
      sessionName: input.sessionName,
      operationId,
      cancellationRecorded: false,
    })
    recordDeepThinkingRoutingDecision({
      context: input.context,
      sessionName: input.sessionName,
      conversation: input.conversation,
      operationId,
      status: 'started',
      message: 'Deep-thinking routing started; worker fan-out is running asynchronously.',
    })
    scheduleDeepThinkingOperation(async () => {
      try {
        await runDeepThinkingRoutingOperation({
          context: input.context,
          conversation: input.conversation,
          commander: input.commander,
          liveSession: input.liveSession,
          sessionName: input.sessionName,
          payload: input.payload,
          sendOptions: input.sendOptions,
          originalMessage,
          operationId,
          signal: controller.signal,
        })
      } finally {
        unlinkAbortSignal()
        completeDeepThinkingOperation(input.conversation.id, controller)
      }
    })
    return { ok: true, disposition: 'started' as const, operationId }
  }

  const sent = await input.context.sessionsInterface?.sendToSession(
    input.sessionName,
    {
      text: input.payload.message,
      ...(input.payload.displayMessage !== undefined ? { displayText: input.payload.displayMessage.trim() } : {}),
      ...(input.payload.clientSendId ? { clientSendId: input.payload.clientSendId } : {}),
      images: input.payload.images && input.payload.images.length > 0 ? [...input.payload.images] : undefined,
    },
    input.sendOptions,
  )
  if (!sent?.ok) {
    const code = sent?.code ?? 'session_unavailable'
    const retryable = sent?.retryable ?? false
    console.warn('[commanders/conversation-send] delivery failed', {
      conversationId: input.conversation.id,
      sessionName: input.sessionName,
      provider: input.liveSession.agentType,
      requestedIntent: input.sendOptions.intent,
      code,
      retryable,
    })
    return {
      ok: false,
      status: retryable ? 503 : 409,
      code,
      error: sent?.error ?? `Conversation "${input.conversation.id}" session unavailable`,
      retryable,
    }
  }

  console.info('[commanders/conversation-send] delivered', {
    conversationId: input.conversation.id,
    sessionName: input.sessionName,
    provider: input.liveSession.agentType,
    requestedIntent: input.sendOptions.intent,
    disposition: sent.disposition,
  })
  return { ok: true, disposition: sent.disposition }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeClientSendId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function eventClientSendId(event: unknown): string | null {
  if (!isObjectRecord(event)) {
    return null
  }

  const directClientSendId = normalizeClientSendId(event.clientSendId)
  if (directClientSendId) {
    return directClientSendId
  }

  const message = event.message
  return isObjectRecord(message) ? normalizeClientSendId(message.clientSendId) : null
}

function liveSessionHasClientSendId(liveSession: StreamSession | undefined, clientSendId: string): boolean {
  if (!liveSession) {
    return false
  }
  if (eventClientSendId(liveSession.currentQueuedMessage) === clientSendId) {
    return true
  }
  if (liveSession.pendingDirectSendMessages.some((message) => eventClientSendId(message) === clientSendId)) {
    return true
  }
  if (liveSession.messageQueue?.list().some((message) => eventClientSendId(message) === clientSendId)) {
    return true
  }
  return liveSession.events.some((event) => eventClientSendId(event) === clientSendId)
}

async function conversationAlreadyHasClientSendId(
  context: CommanderRoutesContext,
  conversation: Conversation,
  liveSession: StreamSession | undefined,
  clientSendId: string | undefined,
): Promise<boolean> {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return false
  }
  if (liveSessionHasClientSendId(liveSession, normalizedClientSendId)) {
    return true
  }

  const sessionName = buildConversationSessionName(conversation)
  const page = await readTranscriptTailPage(sessionName, {
    maxTurns: CLIENT_SEND_ID_DEDUPE_TAIL_TURNS,
    maxEvents: MAX_TRANSCRIPT_TAIL_EVENT_LIMIT,
  })
  return page.events.some((event) => eventClientSendId(event) === normalizedClientSendId)
}

function conversationDeliveryDedupeKey(conversation: Conversation, clientSendId: string | undefined): string | null {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  return normalizedClientSendId ? `${conversation.id}:${normalizedClientSendId}` : null
}

function removeChannelReplyForwarder(
  context: CommanderRoutesContext,
  sessionName: string,
  conversation?: Conversation,
): void {
  const forwarder = context.channelReplyForwarders.get(sessionName)
  if (!forwarder) {
    return
  }
  const streamDispatch = forwarder.streamDispatch
  const streamDispatchPromise = forwarder.streamDispatchPromise
  const activeClientSendId = forwarder.activeClientSendId
  forwarder.activeClientSendId = null
  forwarder.activeTurnId = null
  forwarder.turnEvents = []
  forwarder.streamDispatch = null
  forwarder.streamDispatchPromise = null
  forwarder.unsubscribe()
  context.channelReplyForwarders.delete(sessionName)

  if (conversation && (streamDispatch || streamDispatchPromise || activeClientSendId)) {
    void settleRemovedChannelReplyForwarder(
      context,
      conversation,
      streamDispatch,
      streamDispatchPromise,
      activeClientSendId,
    )
  }
}

interface ChannelReplyForwarderOptions {
  skipCompletedTurns?: number
}

function isSuccessfulTurnEndStatus(status: unknown): boolean {
  if (typeof status !== 'string' || !status.trim()) {
    return true
  }
  const normalized = status.trim().toLowerCase()
  return normalized === 'ok' || normalized === 'completed' || normalized === 'success'
}

function isTopLevelSuccessfulTurnEnd(event: StreamJsonEvent): boolean {
  return isTranscriptEnvelope(event)
    && event.ev.type === 'turn.end'
    && !event.subagentId
    && isSuccessfulTurnEndStatus(event.ev.status)
}

function extractTurnFailureError(event: StreamJsonEvent): string {
  if (!isTranscriptEnvelope(event) || event.ev.type !== 'turn.end') {
    return 'Assistant turn did not complete successfully'
  }
  const error = event.ev.error
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    for (const key of ['message', 'error', 'detail', 'reason', 'code']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    const nested = record.error
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>
      for (const key of ['message', 'error', 'detail', 'reason', 'code']) {
        const value = nestedRecord[key]
        if (typeof value === 'string' && value.trim()) {
          return value.trim()
        }
      }
    }
  }
  const status = typeof event.ev.status === 'string' && event.ev.status.trim()
    ? event.ev.status.trim()
    : 'failed'
  return `Assistant turn ended with status ${status}`
}

function isTopLevelTurnEnd(event: StreamJsonEvent): boolean {
  return isTranscriptEnvelope(event)
    && event.ev.type === 'turn.end'
    && !event.subagentId
}

function isTopLevelTurnStart(event: StreamJsonEvent): boolean {
  return isTranscriptEnvelope(event)
    && event.ev.type === 'turn.start'
    && !event.subagentId
}

function transcriptTurnId(event: StreamJsonEvent): string | null {
  if (!isTranscriptEnvelope(event) || event.subagentId) {
    return null
  }
  const turnId = typeof event.turnId === 'string' ? event.turnId.trim() : ''
  return turnId || null
}

function matchingUserClientSend(
  event: StreamJsonEvent,
  pendingClientSendIds: ReadonlySet<string>,
): { clientSendId: string; turnId: string | null } | null {
  if (
    !isTranscriptEnvelope(event) ||
    event.ev.type !== 'message.start' ||
    event.ev.role !== 'user' ||
    event.subagentId
  ) {
    return null
  }
  const clientSendId = normalizeClientSendId(event.clientSendId)
  const turnId = transcriptTurnId(event)
  return clientSendId && pendingClientSendIds.has(clientSendId)
    ? { clientSendId, turnId }
    : null
}

function isTopLevelAssistantMessageStart(event: StreamJsonEvent): boolean {
  return isTranscriptEnvelope(event)
    && event.ev.type === 'message.start'
    && event.ev.role === 'assistant'
    && !event.subagentId
}

function isSameTranscriptTurn(event: StreamJsonEvent, turnId: string | null): boolean {
  return isTranscriptEnvelope(event)
    && (!turnId || event.turnId === turnId)
    && !event.subagentId
}

function shouldBindActiveTurn(event: StreamJsonEvent): boolean {
  return isTopLevelTurnStart(event) || isTopLevelAssistantMessageStart(event)
}

function extractTopLevelAssistantReplyText(events: readonly StreamJsonEvent[]): string | null {
  let currentParts: string[] = []
  let currentIsAssistant = false
  let lastAssistantText: string | null = null

  for (const event of events) {
    if (!isTranscriptEnvelope(event) || event.subagentId) {
      continue
    }
    if (event.ev.type === 'message.start') {
      currentIsAssistant = event.ev.role === 'assistant'
      currentParts = []
      continue
    }
    if (!currentIsAssistant) {
      continue
    }
    if (event.ev.type === 'message.delta' && (!event.ev.channel || event.ev.channel === 'final')) {
      currentParts.push(event.ev.text)
      continue
    }
    if (event.ev.type === 'message.end') {
      const text = currentParts.join('').trim()
      if (text) {
        lastAssistantText = text
      }
      currentParts = []
      currentIsAssistant = false
    }
  }

  const trailingText = currentIsAssistant ? currentParts.join('').trim() : ''
  return trailingText || lastAssistantText
}

function channelReplyDeliveryId(conversationId: string, now: Date, attemptCount: number): string {
  return [
    'channel-reply',
    conversationId.slice(0, 8),
    now.getTime().toString(36),
    String(attemptCount),
  ].join('-')
}

function channelReplyIntentId(conversationId: string, clientSendId: string): string {
  const digest = createHash('sha256').update(clientSendId).digest('hex').slice(0, 16)
  return [
    'channel-reply-intent',
    conversationId.slice(0, 8),
    digest,
  ].join('-')
}

function pruneChannelReplyIntents(intents: ChannelReplyIntent[]): ChannelReplyIntent[] {
  if (intents.length <= CHANNEL_REPLY_INTENT_HISTORY_LIMIT) {
    return intents
  }

  const pending = intents.filter((intent) => intent.status === 'pending')
  const settled = intents.filter((intent) => intent.status !== 'pending')
  const settledLimit = Math.max(0, CHANNEL_REPLY_INTENT_HISTORY_LIMIT - pending.length)
  return [
    ...(settledLimit > 0 ? settled.slice(-settledLimit) : []),
    ...pending,
  ]
}

function isActivePendingChannelReplyDelivery(
  delivery: ChannelReplyDelivery | undefined,
  intents: ChannelReplyIntent[],
): boolean {
  if (delivery?.status !== 'pending') {
    return false
  }
  if (inFlightChannelReplyDeliveryIds.has(delivery.id)) {
    return true
  }
  return intents.some((intent) => intent.status === 'pending' && intent.deliveryId === delivery.id)
}

async function recordChannelReplyIntentPending(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string | undefined,
): Promise<void> {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return
  }

  const timestamp = context.now().toISOString()
  await context.conversationStore.update(conversation.id, (current) => {
    if (!current.channelMeta || !current.lastRoute) {
      return current
    }

    const intents = current.channelReplyIntents ?? []
    if (intents.some((intent) => intent.clientSendId === normalizedClientSendId)) {
      return current
    }

    const provider = current.channelMeta.provider
    const lastRoute = {
      ...current.lastRoute,
      channel: provider,
    }
    const nextIntent: ChannelReplyIntent = {
      id: channelReplyIntentId(current.id, normalizedClientSendId),
      clientSendId: normalizedClientSendId,
      status: 'pending',
      provider,
      sessionKey: current.channelMeta.sessionKey,
      lastRoute,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    return {
      ...current,
      channelReplyIntents: pruneChannelReplyIntents([
        ...intents,
        nextIntent,
      ]),
    }
  })
}

async function removePendingChannelReplyIntent(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string | undefined,
): Promise<void> {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return
  }

  await context.conversationStore.update(conversation.id, (current) => {
    const intents = current.channelReplyIntents ?? []
    const nextIntents = intents.filter((intent) =>
      intent.clientSendId !== normalizedClientSendId ||
      intent.status !== 'pending' ||
      Boolean(intent.deliveryId))
    if (nextIntents.length === intents.length) {
      return current
    }
    return {
      ...current,
      channelReplyIntents: nextIntents.length > 0 ? nextIntents : undefined,
    }
  })
}

async function recordChannelReplyDeliveryPending(
  context: CommanderRoutesContext,
  conversation: Conversation,
  message: string,
  clientSendId?: string,
): Promise<ChannelReplyDelivery | null> {
  const now = context.now()
  const timestamp = now.toISOString()
  const updated = await context.conversationStore.update(conversation.id, (current) => {
    if (!current.channelMeta || !current.lastRoute) {
      return current
    }

    const previous = current.channelReplyDelivery
    const attemptCount = previous?.message === message
      ? previous.attemptCount + 1
      : 1
    const provider = current.channelMeta.provider
    const lastRoute = {
      ...current.lastRoute,
      channel: provider,
    }

    return {
      ...current,
      channelReplyDelivery: {
        id: channelReplyDeliveryId(current.id, now, attemptCount),
        status: 'pending',
        message,
        ...(clientSendId ? { clientSendId } : {}),
        provider,
        sessionKey: current.channelMeta.sessionKey,
        lastRoute,
        attemptCount,
        attemptedAt: timestamp,
        updatedAt: timestamp,
      },
    }
  })

  return updated?.channelReplyDelivery ?? null
}

async function claimChannelReplyIntentForDelivery(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string,
  message: string,
): Promise<ChannelReplyDelivery | null> {
  const now = context.now()
  const timestamp = now.toISOString()
  let claimedDelivery: ChannelReplyDelivery | null = null

  await context.conversationStore.update(conversation.id, (current) => {
    if (!current.channelMeta || !current.lastRoute) {
      return current
    }

    const intents = current.channelReplyIntents ?? []
    const intent = intents.find((candidate) => candidate.clientSendId === clientSendId)
    if (!intent || intent.status !== 'pending' || intent.deliveryId) {
      return current
    }

    const previous = current.channelReplyDelivery
    if (isActivePendingChannelReplyDelivery(previous, intents)) {
      return current
    }

    const attemptCount = previous?.message === message
      ? previous.attemptCount + 1
      : 1
    const provider = current.channelMeta.provider
    const lastRoute = {
      ...current.lastRoute,
      channel: provider,
    }
    const delivery: ChannelReplyDelivery = {
      id: channelReplyDeliveryId(current.id, now, attemptCount),
      status: 'pending',
      message,
      clientSendId,
      provider,
      sessionKey: current.channelMeta.sessionKey,
      lastRoute,
      attemptCount,
      attemptedAt: timestamp,
      updatedAt: timestamp,
    }
    claimedDelivery = delivery

    return {
      ...current,
      channelReplyDelivery: delivery,
      channelReplyIntents: pruneChannelReplyIntents(intents.map((candidate) =>
        candidate.clientSendId === clientSendId
          ? {
              ...candidate,
              deliveryId: delivery.id,
              message,
              updatedAt: timestamp,
            }
          : candidate,
      )),
    }
  })

  return claimedDelivery
}

async function recordChannelReplyDeliveryFailed(
  context: CommanderRoutesContext,
  input: {
    conversationId: string
    deliveryId: string
    error: string
  },
): Promise<void> {
  const timestamp = context.now().toISOString()
  let matchedDelivery = false
  const updated = await context.conversationStore.update(input.conversationId, (current) => {
    const delivery = current.channelReplyDelivery
    if (!delivery || delivery.id !== input.deliveryId) {
      return current
    }
    matchedDelivery = true
    return {
      ...current,
      channelReplyDelivery: {
        ...delivery,
        status: 'failed',
        error: input.error,
        failedAt: timestamp,
        updatedAt: timestamp,
      },
      channelReplyIntents: current.channelReplyIntents?.map((intent) =>
        intent.deliveryId === input.deliveryId
          ? {
              ...intent,
              status: 'failed',
              error: input.error,
              settledAt: timestamp,
              updatedAt: timestamp,
            }
          : intent,
      ),
      lastMessageAt: timestamp,
    }
  })
  if (updated && matchedDelivery) {
    await recordChannelInboundFateForClientSendId(
      context,
      updated,
      updated.channelReplyDelivery?.clientSendId,
      'turn-failed',
      input.error,
    )
  }
}

export async function recordChannelReplyDeliveryDelivered(
  context: CommanderRoutesContext,
  input: {
    conversationId: string
    deliveryId?: string
    message?: string
    provider?: ChannelReplyDelivery['provider']
    sessionKey?: string
    lastRoute?: ChannelReplyDelivery['lastRoute']
  },
): Promise<void> {
  const timestamp = context.now().toISOString()
  let matchedDelivery = false
  const updated = await context.conversationStore.update(input.conversationId, (current) => {
    const delivery = current.channelReplyDelivery
    if (!delivery) {
      return current
    }
    if (input.deliveryId && delivery.id !== input.deliveryId) {
      return current
    }
    if (!input.deliveryId && input.message && delivery.message !== input.message) {
      return current
    }
    matchedDelivery = true
    return {
      ...current,
      channelReplyDelivery: {
        ...delivery,
        status: 'delivered',
        message: input.message ?? delivery.message,
        provider: input.provider ?? delivery.provider,
        sessionKey: input.sessionKey ?? delivery.sessionKey,
        lastRoute: input.lastRoute ? { ...input.lastRoute } : delivery.lastRoute,
        deliveredAt: timestamp,
        updatedAt: timestamp,
      },
      channelReplyIntents: current.channelReplyIntents?.map((intent) =>
        intent.deliveryId === delivery.id
          ? {
              ...intent,
              status: 'delivered',
              settledAt: timestamp,
              updatedAt: timestamp,
            }
          : intent,
      ),
      lastMessageAt: timestamp,
    }
  })
  if (updated && matchedDelivery) {
    await recordChannelInboundFateForClientSendId(
      context,
      updated,
      updated.channelReplyDelivery?.clientSendId,
      'replied',
    )
  }
}

async function recordChannelReplyIntentFailed(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string,
  error: string,
): Promise<void> {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return
  }

  const now = context.now()
  const timestamp = now.toISOString()
  const updated = await context.conversationStore.update(conversation.id, (current) => {
    if (!current.channelMeta || !current.lastRoute) {
      return current
    }

    const intents = current.channelReplyIntents ?? []
    const intent = intents.find((candidate) =>
      candidate.clientSendId === normalizedClientSendId && candidate.status === 'pending')
    if (!intent) {
      return current
    }

    const existingDelivery = intent.deliveryId && current.channelReplyDelivery?.id === intent.deliveryId
      ? current.channelReplyDelivery
      : null
    const provider = current.channelMeta.provider
    const lastRoute = {
      ...current.lastRoute,
      channel: provider,
    }
    const message = existingDelivery?.message
      ?? intent.message
      ?? CHANNEL_REPLY_UNDELIVERABLE_MESSAGE
    const previous = current.channelReplyDelivery
    const attemptCount = existingDelivery?.attemptCount
      ?? (previous?.message === message ? previous.attemptCount + 1 : 1)
    const delivery: ChannelReplyDelivery = {
      id: existingDelivery?.id ?? channelReplyDeliveryId(current.id, now, attemptCount),
      status: 'failed',
      message,
      clientSendId: normalizedClientSendId,
      provider,
      sessionKey: current.channelMeta.sessionKey,
      lastRoute,
      attemptCount,
      attemptedAt: existingDelivery?.attemptedAt ?? timestamp,
      failedAt: timestamp,
      updatedAt: timestamp,
      error,
    }

    return {
      ...current,
      channelReplyDelivery: delivery,
      channelReplyIntents: pruneChannelReplyIntents(intents.map((candidate) =>
        candidate.clientSendId === normalizedClientSendId
          ? {
              ...candidate,
              status: 'failed',
              deliveryId: delivery.id,
              message,
              error,
              settledAt: timestamp,
              updatedAt: timestamp,
            }
          : candidate,
      )),
      lastMessageAt: timestamp,
    }
  })
  await recordChannelInboundFateForClientSendId(
    context,
    updated ?? conversation,
    normalizedClientSendId,
    'turn-failed',
    error,
  )
}

async function dispatchAutomaticChannelReply(
  context: CommanderRoutesContext,
  conversation: Conversation,
  message: string,
  clientSendId?: string,
): Promise<void> {
  let delivery: ChannelReplyDelivery | null = null
  const recordFailure = async (error: string): Promise<void> => {
    if (!delivery) {
      return
    }
    try {
      await recordChannelReplyDeliveryFailed(context, {
        conversationId: conversation.id,
        deliveryId: delivery.id,
        error,
      })
    } catch (persistError) {
      console.warn(
        `[channels] Failed to persist assistant reply failure for conversation "${conversation.id}":`,
        persistError,
      )
    }
  }
  try {
    const normalizedClientSendId = normalizeClientSendId(clientSendId)
    delivery = normalizedClientSendId
      ? await claimChannelReplyIntentForDelivery(context, conversation, normalizedClientSendId, message)
      : await recordChannelReplyDeliveryPending(context, conversation, message)
    if (!delivery) {
      if (normalizedClientSendId) {
        scheduleAutomaticChannelReplyReconciliationRetry(context, conversation)
      }
      return
    }
    inFlightChannelReplyDeliveryIds.add(delivery.id)
    const result = await context.dispatchCommanderChannelReply({
      commanderId: conversation.commanderId,
      conversationId: conversation.id,
      message,
    })
    if (!result.ok) {
      await recordFailure(result.error)
      console.warn(
        `[channels] Failed to dispatch assistant reply for conversation "${conversation.id}": ${result.error}`,
      )
      return
    }
    if (delivery) {
      await recordChannelReplyDeliveryDelivered(context, {
        conversationId: result.conversationId,
        deliveryId: delivery.id,
        provider: result.provider,
        sessionKey: result.sessionKey,
        lastRoute: result.lastRoute,
      })
    }
  } catch (error) {
    await recordFailure(error instanceof Error ? error.message : String(error))
    console.warn(
      `[channels] Failed to dispatch assistant reply for conversation "${conversation.id}":`,
      error,
    )
  } finally {
    if (delivery) {
      inFlightChannelReplyDeliveryIds.delete(delivery.id)
    }
  }
}

async function beginAutomaticChannelReplyStream(
  context: CommanderRoutesContext,
  conversation: Conversation,
  message: string,
  clientSendId: string,
): Promise<ChannelReplyForwarder['streamDispatch']> {
  const controller = await createChannelReplyStreamDispatch({
    conversation,
    message,
    surfaceBindingStore: context.surfaceBindingStore,
    logger: console,
  })
  if (!controller) {
    return null
  }

  const delivery = await claimChannelReplyIntentForDelivery(context, conversation, clientSendId, message)
  if (!delivery) {
    scheduleAutomaticChannelReplyReconciliationRetry(context, conversation)
    return null
  }

  inFlightChannelReplyDeliveryIds.add(delivery.id)
  return {
    delivery,
    controller,
  }
}

async function updateAutomaticChannelReplyStream(
  context: CommanderRoutesContext,
  conversation: Conversation,
  forwarder: ChannelReplyForwarder,
  message: string,
  clientSendId: string,
): Promise<void> {
  try {
    if (!forwarder.streamDispatch && !forwarder.streamDispatchPromise) {
      forwarder.streamDispatchPromise = beginAutomaticChannelReplyStream(
        context,
        conversation,
        message,
        clientSendId,
      ).then((streamDispatch) => {
        forwarder.streamDispatch = streamDispatch
        forwarder.streamDispatchPromise = null
        return streamDispatch
      }, (error) => {
        forwarder.streamDispatchPromise = null
        throw error
      })
    }
    const streamDispatch = forwarder.streamDispatch ?? await forwarder.streamDispatchPromise
    await streamDispatch?.controller.update(message)
  } catch (error) {
    const streamDispatch = forwarder.streamDispatch
    forwarder.streamDispatch = null
    forwarder.streamDispatchPromise = null
    if (streamDispatch) {
      try {
        await recordChannelReplyDeliveryFailed(context, {
          conversationId: conversation.id,
          deliveryId: streamDispatch.delivery.id,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inFlightChannelReplyDeliveryIds.delete(streamDispatch.delivery.id)
      }
    }
    console.warn(
      `[channels] Failed to stream assistant reply for conversation "${conversation.id}":`,
      error,
    )
  }
}

async function finalizeAutomaticChannelReplyStream(
  context: CommanderRoutesContext,
  conversation: Conversation,
  streamDispatch: NonNullable<ChannelReplyForwarder['streamDispatch']>,
  message: string,
): Promise<void> {
  try {
    const result = await streamDispatch.controller.finalize(message)
    await recordChannelReplyDeliveryDelivered(context, {
      conversationId: conversation.id,
      deliveryId: streamDispatch.delivery.id,
      message,
      provider: result.binding.provider,
      sessionKey: conversation.channelMeta?.sessionKey ?? streamDispatch.delivery.sessionKey,
      lastRoute: {
        ...(conversation.lastRoute ?? streamDispatch.delivery.lastRoute),
        channel: result.binding.provider,
      },
    })
  } catch (error) {
    await recordChannelReplyDeliveryFailed(context, {
      conversationId: conversation.id,
      deliveryId: streamDispatch.delivery.id,
      error: error instanceof Error ? error.message : String(error),
    })
    console.warn(
      `[channels] Failed to finalize streamed assistant reply for conversation "${conversation.id}":`,
      error,
    )
  } finally {
    inFlightChannelReplyDeliveryIds.delete(streamDispatch.delivery.id)
  }
}

async function failAutomaticChannelReplyStream(
  context: CommanderRoutesContext,
  conversation: Conversation,
  streamDispatch: NonNullable<ChannelReplyForwarder['streamDispatch']> | null,
  error: string,
): Promise<boolean> {
  if (!streamDispatch) {
    return false
  }
  let replacedDraft = false
  try {
    try {
      replacedDraft = await streamDispatch.controller.fail(CHANNEL_FAILURE_NOTICE_MESSAGE)
    } catch (editError) {
      console.warn(
        `[channels] Failed to replace streamed assistant draft for conversation "${conversation.id}" after ${error}:`,
        editError,
      )
    }
    await recordChannelReplyDeliveryFailed(context, {
      conversationId: conversation.id,
      deliveryId: streamDispatch.delivery.id,
      error,
    })
  } finally {
    inFlightChannelReplyDeliveryIds.delete(streamDispatch.delivery.id)
  }
  return replacedDraft
}

async function failAutomaticChannelReplyTurn(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string,
  streamDispatch: ChannelReplyForwarder['streamDispatch'],
  streamDispatchPromise: ChannelReplyForwarder['streamDispatchPromise'],
  error: string,
): Promise<void> {
  const resolvedStreamDispatch = streamDispatch ?? await streamDispatchPromise?.catch(() => null) ?? null
  const failureNoticeReplacedDraft = await failAutomaticChannelReplyStream(
    context,
    conversation,
    resolvedStreamDispatch,
    error,
  )
  await recordChannelReplyIntentFailed(
    context,
    conversation,
    clientSendId,
    error,
  )
  if (!failureNoticeReplacedDraft) {
    await dispatchChannelFailureNotice(context, conversation, error)
  }
}

async function settleRemovedChannelReplyForwarder(
  context: CommanderRoutesContext,
  conversation: Conversation,
  streamDispatch: ChannelReplyForwarder['streamDispatch'],
  streamDispatchPromise: ChannelReplyForwarder['streamDispatchPromise'],
  clientSendId: string | null,
): Promise<void> {
  const error = 'Channel reply delivery was interrupted before terminal settlement; operator retry required.'
  const resolvedStreamDispatch = streamDispatch ?? await streamDispatchPromise?.catch((settleError) => {
    console.warn(
      `[channels] Failed to settle removed channel reply stream for conversation "${conversation.id}":`,
      settleError,
    )
    return null
  }) ?? null
  await failAutomaticChannelReplyStream(context, conversation, resolvedStreamDispatch, error)
  if (clientSendId) {
    await recordChannelReplyIntentFailed(context, conversation, clientSendId, error)
  }
}

async function dispatchChannelFailureNotice(
  context: CommanderRoutesContext,
  conversation: Conversation,
  error: string,
): Promise<void> {
  try {
    const result = await context.dispatchCommanderChannelReply({
      commanderId: conversation.commanderId,
      conversationId: conversation.id,
      message: CHANNEL_FAILURE_NOTICE_MESSAGE,
    })
    if (!result?.ok) {
      const noticeError = result?.error ?? 'unknown dispatch failure'
      console.warn(
        `[channels] Failed to send channel turn-failure notice for conversation "${conversation.id}" after ${error}: ${noticeError}`,
      )
    }
  } catch (noticeError) {
    console.warn(
      `[channels] Failed to send channel turn-failure notice for conversation "${conversation.id}":`,
      noticeError,
    )
  }
}

type ReconciledChannelReplyTurn =
  | { status: 'completed'; message: string }
  | { status: 'failed'; error: string }

function findChannelReplyTurnForClientSendId(
  events: readonly StreamJsonEvent[],
  clientSendId: string,
): ReconciledChannelReplyTurn | null {
  const pendingClientSendIds = new Set([clientSendId])
  let activeTurnId: string | null = null
  let turnEvents: StreamJsonEvent[] = []
  let armed = false

  for (const event of events) {
    const eventTurnId = transcriptTurnId(event)
    const matchedClientSend = matchingUserClientSend(event, pendingClientSendIds)
    if (matchedClientSend) {
      armed = true
      activeTurnId = matchedClientSend.turnId
      turnEvents = [event]
      continue
    }

    if (!armed) {
      continue
    }

    if (!activeTurnId && eventTurnId && shouldBindActiveTurn(event)) {
      activeTurnId = eventTurnId
    }

    if (!isSameTranscriptTurn(event, activeTurnId)) {
      continue
    }

    if (isTopLevelAssistantMessageStart(event)) {
      turnEvents = [event]
    } else {
      turnEvents.push(event)
    }

    if (!isTopLevelTurnEnd(event)) {
      continue
    }

    if (!isTopLevelSuccessfulTurnEnd(event)) {
      return { status: 'failed', error: extractTurnFailureError(event) }
    }

    const replyText = extractTopLevelAssistantReplyText(turnEvents)
    if (!replyText) {
      return { status: 'failed', error: 'Assistant turn completed without final assistant text' }
    }

    return { status: 'completed', message: replyText }
  }

  return null
}

async function readChannelReplyReconciliationEvents(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<StreamJsonEvent[]> {
  const sessionName = buildConversationSessionName(conversation)
  const liveEvents = getLiveConversationSession(context, conversation)?.events ?? []
  const page = await readTranscriptTailPage(sessionName, {
    maxTurns: CLIENT_SEND_ID_DEDUPE_TAIL_TURNS,
    maxEvents: MAX_TRANSCRIPT_TAIL_EVENT_LIMIT,
  })
  return mergeCanonicalStreamEvents({
    persistedEvents: page.events as readonly StreamJsonEvent[],
    liveEvents,
  })
}

function conversationStoreHasGet(
  store: CommanderRoutesContext['conversationStore'],
): store is CommanderRoutesContext['conversationStore'] & { get: CommanderRoutesContext['conversationStore']['get'] } {
  return typeof (store as { get?: unknown }).get === 'function'
}

async function refreshConversationForReconciliation(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<Conversation> {
  if (!conversationStoreHasGet(context.conversationStore)) {
    return conversation
  }
  return await context.conversationStore.get(conversation.id) ?? conversation
}

async function hasPendingChannelReplyIntents(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<boolean> {
  const current = await refreshConversationForReconciliation(context, conversation)
  return Boolean(current.channelReplyIntents?.some((intent) => intent.status === 'pending'))
}

export async function reconcileAutomaticChannelReplies(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<void> {
  const current = await refreshConversationForReconciliation(context, conversation)
  const pendingIntents = (current.channelReplyIntents ?? [])
    .filter((intent) => intent.status === 'pending')
  if (pendingIntents.length === 0) {
    return
  }

  for (const intent of pendingIntents.filter((candidate) => Boolean(candidate.deliveryId))) {
    const delivery = current.channelReplyDelivery?.id === intent.deliveryId
      ? current.channelReplyDelivery
      : null
    if (delivery?.status === 'pending' && inFlightChannelReplyDeliveryIds.has(delivery.id)) {
      continue
    }
    if (!delivery || delivery.status === 'pending') {
      await recordChannelReplyIntentFailed(
        context,
        current,
        intent.clientSendId,
        delivery
          ? 'Channel reply delivery was interrupted before terminal settlement; operator retry required.'
          : 'Channel reply delivery record is missing; operator retry required.',
      )
    }
  }

  const unclaimedIntents = pendingIntents.filter((intent) => !intent.deliveryId)
  if (unclaimedIntents.length === 0) {
    return
  }

  const events = await readChannelReplyReconciliationEvents(context, current)
  for (const intent of unclaimedIntents) {
    const turn = findChannelReplyTurnForClientSendId(events, intent.clientSendId)
    if (!turn) {
      continue
    }
    if (turn.status === 'failed') {
      console.error(
        `[channels] Completed channel assistant turn for conversation "${current.id}" had no deliverable reply for clientSendId "${intent.clientSendId}": ${turn.error}`,
      )
      await recordChannelReplyIntentFailed(context, current, intent.clientSendId, turn.error)
      await dispatchChannelFailureNotice(context, current, turn.error)
      continue
    }
    await dispatchAutomaticChannelReply(context, current, turn.message, intent.clientSendId)
  }
}

async function runAutomaticChannelReplyReconciliation(
  context: CommanderRoutesContext,
  conversation: Conversation,
): Promise<void> {
  await reconcileAutomaticChannelReplies(context, conversation)
  if (await hasPendingChannelReplyIntents(context, conversation)) {
    scheduleAutomaticChannelReplyReconciliationRetry(context, conversation)
  }
}

function scheduleAutomaticChannelReplyReconciliationRetry(
  context: CommanderRoutesContext,
  conversation: Conversation,
): void {
  if (channelReplyReconciliationRetryTimers.has(conversation.id)) {
    return
  }
  const timer = setTimeout(() => {
    channelReplyReconciliationRetryTimers.delete(conversation.id)
    void runAutomaticChannelReplyReconciliation(context, conversation)
      .catch((error) => {
        console.warn(
          `[channels] Failed to reconcile assistant replies for conversation "${conversation.id}":`,
          error,
        )
      })
  }, channelReplyReconciliationRetryMs)
  channelReplyReconciliationRetryTimers.set(conversation.id, timer)
  timer.unref?.()
}

function scheduleAutomaticChannelReplyReconciliation(
  context: CommanderRoutesContext,
  conversation: Conversation,
): void {
  for (const delayMs of CHANNEL_REPLY_RECONCILIATION_DELAYS_MS) {
    const timer = setTimeout(() => {
      void runAutomaticChannelReplyReconciliation(context, conversation)
        .catch((error) => {
          console.warn(
            `[channels] Failed to reconcile assistant replies for conversation "${conversation.id}":`,
            error,
          )
        })
    }, delayMs)
    timer.unref?.()
  }
}

function ensureChannelReplyForwarder(
  context: CommanderRoutesContext,
  conversation: Conversation,
  options: ChannelReplyForwarderOptions = {},
): ChannelReplyForwarder | null {
  if (!conversation.channelMeta || !conversation.lastRoute || !context.sessionsInterface) {
    return null
  }

  const sessionName = buildConversationSessionName(conversation)
  const existing = context.channelReplyForwarders.get(sessionName)
  if (existing) {
    existing.skippedCompletedTurns += Math.max(0, Math.floor(options.skipCompletedTurns ?? 0))
    void runAutomaticChannelReplyReconciliation(context, conversation)
      .catch((error) => {
        console.warn(
          `[channels] Failed to reconcile assistant replies for conversation "${conversation.id}":`,
          error,
        )
      })
    return existing
  }

  const forwarder: ChannelReplyForwarder = {
    unsubscribe: () => {},
    pendingClientSendIds: new Set<string>(),
    activeClientSendId: null,
    activeTurnId: null,
    turnEvents: [],
    streamDispatch: null,
    streamDispatchPromise: null,
    skippedTurnIds: new Set<string>(),
    skippedCompletedTurns: Math.max(0, Math.floor(options.skipCompletedTurns ?? 0)),
  }

  forwarder.unsubscribe = context.sessionsInterface.subscribeToEvents(sessionName, (event) => {
    const eventTurnId = transcriptTurnId(event)
    const matchedClientSend = matchingUserClientSend(event, forwarder.pendingClientSendIds)
    if (matchedClientSend) {
      forwarder.activeClientSendId = matchedClientSend.clientSendId
      forwarder.activeTurnId = matchedClientSend.turnId
      if (matchedClientSend.turnId) {
        forwarder.skippedTurnIds.delete(matchedClientSend.turnId)
      }
      forwarder.turnEvents = [event]
      return
    }

    if (!forwarder.activeClientSendId) {
      if (
        forwarder.skippedCompletedTurns > 0 &&
        eventTurnId &&
        (isTopLevelTurnStart(event) || isTopLevelAssistantMessageStart(event))
      ) {
        forwarder.skippedTurnIds.add(eventTurnId)
      }
      if (isTopLevelTurnEnd(event) && forwarder.skippedCompletedTurns > 0) {
        if (eventTurnId) {
          forwarder.skippedTurnIds.delete(eventTurnId)
        }
        forwarder.skippedCompletedTurns -= 1
      }
      return
    }

    if (eventTurnId && forwarder.skippedTurnIds.has(eventTurnId)) {
      if (isTopLevelTurnEnd(event) && forwarder.skippedCompletedTurns > 0) {
        forwarder.skippedTurnIds.delete(eventTurnId)
        forwarder.skippedCompletedTurns -= 1
      }
      return
    }

    if (!forwarder.activeTurnId && eventTurnId && shouldBindActiveTurn(event)) {
      forwarder.activeTurnId = eventTurnId
    }

    if (!isSameTranscriptTurn(event, forwarder.activeTurnId)) {
      return
    }

    if (isTopLevelAssistantMessageStart(event)) {
      forwarder.turnEvents = [event]
    } else {
      forwarder.turnEvents.push(event)
    }

    const currentReplyText = extractTopLevelAssistantReplyText(forwarder.turnEvents)
    if (currentReplyText && !isTopLevelTurnEnd(event)) {
      void updateAutomaticChannelReplyStream(
        context,
        conversation,
        forwarder,
        currentReplyText,
        forwarder.activeClientSendId,
      )
    }

    if (!isTopLevelTurnEnd(event)) {
      return
    }

    const completedClientSendId = forwarder.activeClientSendId
    const streamDispatch = forwarder.streamDispatch
    const streamDispatchPromise = forwarder.streamDispatchPromise
    forwarder.activeClientSendId = null
    forwarder.activeTurnId = null
    forwarder.streamDispatch = null
    forwarder.streamDispatchPromise = null
    forwarder.pendingClientSendIds.delete(completedClientSendId)

    if (!isTopLevelSuccessfulTurnEnd(event)) {
      forwarder.turnEvents = []
      const error = extractTurnFailureError(event)
      void failAutomaticChannelReplyTurn(
        context,
        conversation,
        completedClientSendId,
        streamDispatch,
        streamDispatchPromise,
        error,
      )
      return
    }

    const replyText = extractTopLevelAssistantReplyText(forwarder.turnEvents)
    forwarder.turnEvents = []
    if (!replyText) {
      const error = 'Assistant turn completed without final assistant text'
      void failAutomaticChannelReplyTurn(
        context,
        conversation,
        completedClientSendId,
        streamDispatch,
        streamDispatchPromise,
        error,
      )
      return
    }

    void (async () => {
      const resolvedStreamDispatch = streamDispatch ?? await streamDispatchPromise?.catch((error) => {
        console.warn(
          `[channels] Failed to prepare streamed assistant reply for conversation "${conversation.id}":`,
          error,
        )
        return null
      }) ?? null
      if (resolvedStreamDispatch) {
        await finalizeAutomaticChannelReplyStream(context, conversation, resolvedStreamDispatch, replyText)
        return
      }
      await dispatchAutomaticChannelReply(context, conversation, replyText, completedClientSendId)
    })()
  })

  context.channelReplyForwarders.set(sessionName, forwarder)
  void runAutomaticChannelReplyReconciliation(context, conversation)
    .catch((error) => {
      console.warn(
        `[channels] Failed to reconcile assistant replies for conversation "${conversation.id}":`,
        error,
      )
    })
  return forwarder
}

function armChannelReplyForwarder(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string | undefined,
): void {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return
  }
  const forwarder = ensureChannelReplyForwarder(context, conversation)
  forwarder?.pendingClientSendIds.add(normalizedClientSendId)
}

function disarmChannelReplyForwarder(
  context: CommanderRoutesContext,
  conversation: Conversation,
  clientSendId: string | undefined,
): void {
  const normalizedClientSendId = normalizeClientSendId(clientSendId)
  if (!normalizedClientSendId) {
    return
  }
  const forwarder = context.channelReplyForwarders.get(buildConversationSessionName(conversation))
  if (!forwarder) {
    return
  }
  forwarder.pendingClientSendIds.delete(normalizedClientSendId)
  if (forwarder.activeClientSendId === normalizedClientSendId) {
    forwarder.activeClientSendId = null
    forwarder.activeTurnId = null
    forwarder.turnEvents = []
  }
}

function ensureChannelReplyPayloadClientSendId(
  conversation: Conversation,
  payload: ConversationMessagePayload,
): ConversationMessagePayload {
  if (normalizeClientSendId(payload.clientSendId)) {
    return payload
  }
  channelReplyClientSendSequence += 1
  return {
    ...payload,
    clientSendId: [
      'channel-reply-trigger',
      conversation.id,
      Date.now().toString(36),
      String(channelReplyClientSendSequence),
    ].join(':'),
  }
}

export async function persistConversationRuntimeSnapshot(
  context: CommanderRoutesContext,
  conversation: Conversation,
  nextStatus: Conversation['status'],
): Promise<Conversation | null> {
  const liveSession = getLiveConversationSession(context, conversation)
  const usageCostUsd = liveSession?.usage?.costUsd ?? 0
  const occurredAtDate = context.now()
  const occurredAt = occurredAtDate.toISOString()
  const monthlyUsageCostUsd = liveSession
    ? computeLiveSessionMonthlySpendUsd(liveSession, occurredAtDate)
    : 0
  if (monthlyUsageCostUsd > 0) {
    await appendCommanderCostRecord(context, {
      commanderId: conversation.commanderId,
      conversationId: conversation.id,
      costUsd: monthlyUsageCostUsd,
      occurredAt,
    })
  }
  return context.conversationStore.update(conversation.id, (current) => ({
    ...current,
    model: liveSession?.model,
    providerContext: sanitizeConversationProviderContext(liveSession) ?? current.providerContext,
    totalCostUsd: current.totalCostUsd + usageCostUsd,
    status: nextStatus,
    lastMessageAt: occurredAt,
  }))
}

/**
 * Stop a single conversation's live stream session, persist its final snapshot,
 * stop its heartbeat, and clean up commander-level runtime references when no
 * other live conversation remains. Used by:
 *   - POST /api/conversations/:id/{pause,archive,resume}        (per-conversation lifecycle)
 *   - POST /api/commanders/:id/stop                              (sweep across every conversation)
 *   - DELETE /api/commanders/:id                                 (cascade cleanup before commander delete)
 *   - POST /api/commanders/channel-message (orphan path)         (archive when commander is gone)
 *
 * `nextStatus` is the persisted status the conversation lands in: `idle` for
 * stop/pause, `archived` for archive/delete/orphan.
 */
export async function stopConversationSession(
  context: CommanderRoutesContext,
  conversation: Conversation,
  nextStatus: Conversation['status'],
): Promise<Conversation | null> {
  cancelDeepThinkingOperation(conversation.id, 'conversation session stopped')
  const sessionName = buildConversationSessionName(conversation)
  removeChannelReplyForwarder(context, sessionName, conversation)
  const updated = await persistConversationRuntimeSnapshot(context, conversation, nextStatus)
  context.heartbeatManager.stop(conversation.id)
  context.sessionsInterface?.deleteSession(sessionName)
  const remainingConversations = await context.conversationStore.listByCommander(conversation.commanderId)
  const hasOtherLiveConversation = remainingConversations.some((candidate) => {
    if (candidate.id === conversation.id || candidate.status !== 'active') {
      return false
    }
    return Boolean(getLiveConversationSession(context, candidate))
  })
  if (!hasOtherLiveConversation) {
    context.runtimes.delete(conversation.commanderId)
  }
  if (
    !hasOtherLiveConversation ||
    context.activeCommanderSessions.get(conversation.commanderId)?.sessionName === sessionName
  ) {
    context.activeCommanderSessions.delete(conversation.commanderId)
  }
  await updateCommanderDerivedState(context, conversation.commanderId)
  return updated
}

export async function deliverConversationMessage(
  context: CommanderRoutesContext,
  conversation: Conversation,
  payload: ConversationMessagePayload,
  options?: DeliverConversationMessageOptions,
): Promise<DeliverConversationMessageResult> {
  const deliveryPayload = options?.dispatchChannelReplies
    ? ensureChannelReplyPayloadClientSendId(conversation, payload)
    : payload
  const dedupeKey = conversationDeliveryDedupeKey(conversation, deliveryPayload.clientSendId)
  if (!dedupeKey) {
    return deliverConversationMessageUnchecked(context, conversation, deliveryPayload, options)
  }

  const inFlightDelivery = inFlightConversationDeliveries.get(dedupeKey)
  if (inFlightDelivery) {
    return inFlightDelivery
  }

  const delivery = deliverConversationMessageUnchecked(context, conversation, deliveryPayload, options)
  inFlightConversationDeliveries.set(dedupeKey, delivery)
  try {
    return await delivery
  } finally {
    if (inFlightConversationDeliveries.get(dedupeKey) === delivery) {
      inFlightConversationDeliveries.delete(dedupeKey)
    }
  }
}

async function deliverConversationMessageUnchecked(
  context: CommanderRoutesContext,
  conversation: Conversation,
  payload: ConversationMessagePayload,
  options?: DeliverConversationMessageOptions,
): Promise<DeliverConversationMessageResult> {
  if (conversation.status === 'archived') {
    return { ok: false, status: 409, error: `Conversation "${conversation.id}" is archived` }
  }

  const commander = await context.sessionStore.get(conversation.commanderId)
  if (!commander) {
    return { ok: false, status: 404, error: `Commander "${conversation.commanderId}" not found` }
  }
  if (conversation.status === 'idle' && options?.autoStartIdle && commander.state === 'stopped') {
    return {
      ok: false,
      status: 409,
      error: `Commander "${conversation.commanderId}" is stopped. Start the commander before sending to idle conversations.`,
    }
  }

  const sendOptions = {
    intent: options?.intent ?? 'interrupt',
    priority: options?.priority,
  }

  const liveSession = getLiveConversationSession(context, conversation)
  if (await conversationAlreadyHasClientSendId(context, conversation, liveSession, payload.clientSendId)) {
    if (options?.dispatchChannelReplies === true) {
      await recordChannelReplyIntentPending(context, conversation, payload.clientSendId)
      scheduleAutomaticChannelReplyReconciliation(context, conversation)
    }
    return {
      ok: true,
      createdSession: false,
      conversation,
      disposition: 'duplicate',
    }
  }

  if (!liveSession) {
    if (conversation.status === 'idle' && options?.autoStartIdle) {
      const shouldSendAutoStartSeed = options.autoStartSeedPrompt !== false
        && options.dispatchChannelReplies === true
      const costCap = await enforceCommanderCostCap(context, conversation.commanderId)
      if (!costCap.ok) {
        return {
          ok: false,
          status: costCap.status,
          error: costCap.body.error,
        }
      }
      let started: Awaited<ReturnType<typeof startConversationSession>>
      try {
        started = await startConversationSession(
          context,
          conversation.commanderId,
          conversation,
          shouldSendAutoStartSeed ? null : '',
          options.startSpawnOptions,
          { intent: 'interrupt' },
          options.dispatchChannelReplies === true,
          shouldSendAutoStartSeed ? 1 : 0,
        )
      } catch (error) {
        if (isProviderLaunchError(error)) {
          return {
            ok: false,
            status: error.statusCode,
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
          }
        }
        throw error
      }
      if (!started.sent) {
        return {
          ok: false,
          status: 503,
          error: `Conversation "${conversation.id}" could not be auto-started`,
        }
      }
      const sessionName = buildConversationSessionName(started.conversation)
      const autoStartedSendOptions = shouldSendAutoStartSeed
        ? { intent: 'queue' as const, priority: 'normal' as const }
        : sendOptions
      const startedLiveSession = getLiveConversationSession(context, started.conversation)
      if (!startedLiveSession) {
        await stopConversationSession(context, started.conversation, 'idle')
        return {
          ok: false,
          status: 503,
          error: `Conversation "${conversation.id}" could not receive its auto-start message`,
        }
      }
      if (options.dispatchChannelReplies === true) {
        await recordChannelReplyIntentPending(context, started.conversation, payload.clientSendId)
        armChannelReplyForwarder(context, started.conversation, payload.clientSendId)
      }
      const sent = await sendConversationPayloadWithDeepThinkingGuard({
        context,
        conversation: started.conversation,
        commander,
        liveSession: startedLiveSession,
        sessionName,
        payload,
        sendOptions: autoStartedSendOptions,
        abortSignal: options?.abortSignal,
      })
      if (!sent.ok) {
        disarmChannelReplyForwarder(context, started.conversation, payload.clientSendId)
        if (options.dispatchChannelReplies === true) {
          await removePendingChannelReplyIntent(context, started.conversation, payload.clientSendId)
        }
        await stopConversationSession(context, started.conversation, 'idle')
        return {
          ok: false,
          status: sent.status,
          error: sent.error,
          ...(sent.code ? { code: sent.code } : {}),
          ...(sent.retryable !== undefined ? { retryable: sent.retryable } : {}),
        }
      }
      if (options.dispatchChannelReplies === true) {
        scheduleAutomaticChannelReplyReconciliation(context, started.conversation)
      }
      const updated = await context.conversationStore.update(started.conversation.id, (current) => ({
        ...current,
        status: 'active',
        lastMessageAt: new Date().toISOString(),
      }))
      await updateCommanderDerivedState(context, conversation.commanderId)
      return {
        ok: true,
        createdSession: true,
        conversation: updated ?? started.conversation,
        disposition: sent.disposition,
        ...(sent.operationId ? { operationId: sent.operationId } : {}),
      }
    }
    if (conversation.status === 'idle') {
      return {
        ok: false,
        status: 409,
        error: `Conversation is idle. Call POST /api/conversations/${conversation.id}/start first.`,
      }
    }
    if (conversation.status === 'active') {
      const costCap = await enforceCommanderCostCap(context, conversation.commanderId)
      if (!costCap.ok) {
        return {
          ok: false,
          status: costCap.status,
          error: costCap.body.error,
        }
      }
      let restarted: Awaited<ReturnType<typeof startConversationSession>>
      try {
        restarted = await startConversationSession(
          context,
          conversation.commanderId,
          conversation,
          null,
          options?.startSpawnOptions,
          { intent: 'interrupt' },
          options?.dispatchChannelReplies === true,
          options?.dispatchChannelReplies === true ? 1 : 0,
        )
      } catch (error) {
        if (isProviderLaunchError(error)) {
          return {
            ok: false,
            status: error.statusCode,
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
          }
        }
        throw error
      }
      if (!restarted.sent) {
        return {
          ok: false,
          status: 503,
          error: `Conversation "${conversation.id}" could not be recovered`,
        }
      }
      const sessionName = buildConversationSessionName(restarted.conversation)
      const restartedLiveSession = getLiveConversationSession(context, restarted.conversation)
      if (!restartedLiveSession) {
        await stopConversationSession(context, restarted.conversation, 'idle')
        return {
          ok: false,
          status: 503,
          error: `Conversation "${conversation.id}" recovered without a live session`,
        }
      }
      if (options?.dispatchChannelReplies === true) {
        await recordChannelReplyIntentPending(context, restarted.conversation, payload.clientSendId)
        armChannelReplyForwarder(context, restarted.conversation, payload.clientSendId)
      }
      const recoveredSendOptions = options?.dispatchChannelReplies === true
        ? { intent: 'queue' as const, priority: 'normal' as const }
        : sendOptions
      const sent = await sendConversationPayloadWithDeepThinkingGuard({
        context,
        conversation: restarted.conversation,
        commander,
        liveSession: restartedLiveSession,
        sessionName,
        payload,
        sendOptions: recoveredSendOptions,
        abortSignal: options?.abortSignal,
      })
      if (!sent.ok) {
        disarmChannelReplyForwarder(context, restarted.conversation, payload.clientSendId)
        if (options?.dispatchChannelReplies === true) {
          await removePendingChannelReplyIntent(context, restarted.conversation, payload.clientSendId)
        }
        await stopConversationSession(context, restarted.conversation, 'idle')
        return {
          ok: false,
          status: sent.status,
          error: sent.error,
          ...(sent.code ? { code: sent.code } : {}),
          ...(sent.retryable !== undefined ? { retryable: sent.retryable } : {}),
        }
      }
      if (options?.dispatchChannelReplies === true) {
        scheduleAutomaticChannelReplyReconciliation(context, restarted.conversation)
      }
      const updated = await context.conversationStore.update(restarted.conversation.id, (current) => ({
        ...current,
        status: 'active',
        lastMessageAt: new Date().toISOString(),
      }))
      await updateCommanderDerivedState(context, conversation.commanderId)
      return {
        ok: true,
        createdSession: true,
        conversation: updated ?? restarted.conversation,
        disposition: sent.disposition,
        ...(sent.operationId ? { operationId: sent.operationId } : {}),
      }
    }
    return {
      ok: false,
      status: 409,
      error: `Conversation "${conversation.id}" session unavailable`,
    }
  }

  const sessionName = buildConversationSessionName(conversation)
  const costCap = await enforceCommanderCostCap(context, conversation.commanderId)
  if (!costCap.ok) {
    return {
      ok: false,
      status: costCap.status,
      error: costCap.body.error,
    }
  }
  if (options?.dispatchChannelReplies === true) {
    await recordChannelReplyIntentPending(context, conversation, payload.clientSendId)
    armChannelReplyForwarder(context, conversation, payload.clientSendId)
  }
  const sent = await sendConversationPayloadWithDeepThinkingGuard({
    context,
    conversation,
    commander,
    liveSession,
    sessionName,
    payload,
    sendOptions,
    abortSignal: options?.abortSignal,
  })
  if (!sent.ok) {
    disarmChannelReplyForwarder(context, conversation, payload.clientSendId)
    if (options?.dispatchChannelReplies === true) {
      await removePendingChannelReplyIntent(context, conversation, payload.clientSendId)
    }
    return {
      ok: false,
      status: sent.status,
      error: sent.error,
      ...(sent.code ? { code: sent.code } : {}),
      ...(sent.retryable !== undefined ? { retryable: sent.retryable } : {}),
    }
  }
  if (options?.dispatchChannelReplies === true) {
    scheduleAutomaticChannelReplyReconciliation(context, conversation)
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

  return {
    ok: true,
    createdSession: false,
    conversation: updated ?? conversation,
    disposition: sent.disposition,
    ...(sent.operationId ? { operationId: sent.operationId } : {}),
  }
}
