import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentType } from '../agents/types.js'
import {
  parseStoredAgentEffort,
  type AgentEffortLevel,
} from '../agents/effort.js'
import { parseProviderId } from '../agents/providers/registry.js'
import {
  isClaudeAdaptiveThinkingMode,
  type ClaudeAdaptiveThinkingMode,
} from '../claude-adaptive-thinking.js'
import {
  isClaudeMaxThinkingTokens,
  type ClaudeMaxThinkingTokens,
} from '../claude-max-thinking-tokens.js'
import {
  type ProviderSessionContext,
} from '../agents/providers/provider-session-context.js'
import {
  normalizeVoiceConfig,
  type VoiceConfigOverride,
} from './voice-config.js'
import {
  conversationNamesEqual,
  generateConversationName,
  normalizeConversationName,
} from './conversation-names.js'
import {
  buildDefaultCommanderConversationId,
  parseCommanderChannelMeta,
  parseCommanderLastRoute,
  type CommanderChannelMeta,
  type CommanderConversationSurface,
  type CommanderCurrentTask,
  type CommanderLastRoute,
} from './store.js'
import { resolveCommanderDataDir, resolveCommanderPaths } from './paths.js'
import {
  parseCanonicalProviderContext,
} from '../agents/providers/provider-context-normalization.js'
import { quarantineJsonFile, writeJsonFileAtomically } from '../json-file.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import { withCommanderChildCreation } from './child-mutation-coordinator.js'

const CONVERSATION_STATUSES = new Set<Conversation['status']>([
  'active',
  'idle',
  'archived',
])
const CHAT_SURFACES = new Set<Conversation['surface']>([
  'api',
  'cli',
  'ui',
])
const CREATION_SOURCES = new Set<ConversationCreationSource>([
  'ui',
  'cli',
  'api',
  'channel',
  'system-default',
  'unknown',
])
const CREATED_BY_KINDS = new Set<ConversationCreatedByKind>([
  'human',
  'api-key',
  'system',
  'channel',
  'unknown',
])
const CHANNEL_REPLY_DELIVERY_STATUSES = new Set<ChannelReplyDelivery['status']>([
  'pending',
  'delivered',
  'failed',
])
const CHANNEL_REPLY_INTENT_STATUSES = new Set<ChannelReplyIntent['status']>([
  'pending',
  'delivered',
  'failed',
])
const CHANNEL_INBOUND_TERMINAL_FATES = new Set<ChannelInboundMessageFate['fate']>([
  'replied',
  'turn-failed',
  'policy-denied',
  'ingest-failed',
  'duplicate',
])
const DEFAULT_CHAT_STATUSES = new Set<Conversation['status']>([
  'active',
  'idle',
])

function activeChatStatusPriority(status: Conversation['status']): number {
  return status === 'active' ? 0 : status === 'idle' ? 1 : 2
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Conversation-lifetime approval bridge credential state. Owned by the
 * conversation — not by any provider runtime session — so provider
 * replacement, credential recovery, auto-rotation, model switch, relaunch,
 * and server restart all preserve it. Revoked only when the conversation is
 * archived/deleted or when an operator explicitly rotates the epoch.
 */
export interface ConversationApprovalBridgeState {
  credentialId: string
  epoch: number
  createdAt: string
}

export interface Conversation {
  id: string
  commanderId: string
  surface: CommanderConversationSurface
  channelMeta?: CommanderChannelMeta
  lastRoute?: CommanderLastRoute
  channelReplyDelivery?: ChannelReplyDelivery
  channelReplyIntents?: ChannelReplyIntent[]
  channelInboundFates?: ChannelInboundMessageFate[]
  voiceConfig?: VoiceConfigOverride
  agentType?: AgentType | null
  model?: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  name: string
  status: 'active' | 'idle' | 'archived'
  currentTask: CommanderCurrentTask | null
  providerContext?: ProviderSessionContext
  credentialPoolId?: string
  approvalBridge?: ConversationApprovalBridgeState
  lastHeartbeat: string | null
  heartbeatTickCount: number
  completedTasks: number
  totalCostUsd: number
  creationSource: ConversationCreationSource
  createdByKind: ConversationCreatedByKind
  createdById?: string
  createdBySessionName?: string
  createdByConversationId?: string
  requestId?: string
  createdAt: string
  lastMessageAt: string
}

export type ConversationCreationSource =
  | 'ui'
  | 'cli'
  | 'api'
  | 'channel'
  | 'system-default'
  | 'unknown'

export type ConversationCreatedByKind =
  | 'human'
  | 'api-key'
  | 'system'
  | 'channel'
  | 'unknown'

export interface ChannelReplyDelivery {
  id: string
  status: 'pending' | 'delivered' | 'failed'
  message: string
  clientSendId?: string
  provider: CommanderChannelMeta['provider']
  sessionKey: string
  lastRoute: CommanderLastRoute
  attemptCount: number
  attemptedAt: string
  updatedAt: string
  deliveredAt?: string
  failedAt?: string
  error?: string
}

export interface ChannelReplyIntent {
  id: string
  clientSendId: string
  status: 'pending' | 'delivered' | 'failed'
  provider: CommanderChannelMeta['provider']
  sessionKey: string
  lastRoute: CommanderLastRoute
  createdAt: string
  updatedAt: string
  deliveryId?: string
  message?: string
  error?: string
  settledAt?: string
}

export interface ChannelInboundMessageFate {
  id: string
  fate: 'replied' | 'turn-failed' | 'policy-denied' | 'ingest-failed' | 'duplicate'
  provider: CommanderChannelMeta['provider']
  accountId: string
  rawSourceId: string
  at: string
  clientSendId?: string
  sourceHash?: string
  error?: string
}

type ParsedConversation = Omit<Conversation, 'name'> & {
  name?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string'
    ? (value.trim() || null)
    : null
}

function asOptionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  return value.trim() || null
}

function parseCurrentTask(raw: unknown): CommanderCurrentTask | null {
  if (raw === null || raw === undefined || !isObject(raw)) {
    return null
  }

  const issueNumber = raw.issueNumber
  const issueUrl = typeof raw.issueUrl === 'string' ? raw.issueUrl.trim() : ''
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt.trim() : ''
  if (
    typeof issueNumber !== 'number' ||
    !Number.isInteger(issueNumber) ||
    issueNumber < 1 ||
    issueUrl.length === 0 ||
    startedAt.length === 0
  ) {
    return null
  }

  return { issueNumber, issueUrl, startedAt }
}

function parseSurface(raw: unknown): Conversation['surface'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as Conversation['surface']
    : null
}

function parseStatus(raw: unknown): Conversation['status'] | null {
  return typeof raw === 'string' && CONVERSATION_STATUSES.has(raw as Conversation['status'])
    ? raw as Conversation['status']
    : null
}

function parseCreationSource(raw: unknown): ConversationCreationSource | null {
  return typeof raw === 'string' && CREATION_SOURCES.has(raw as ConversationCreationSource)
    ? raw as ConversationCreationSource
    : null
}

function parseCreatedByKind(raw: unknown): ConversationCreatedByKind | null {
  return typeof raw === 'string' && CREATED_BY_KINDS.has(raw as ConversationCreatedByKind)
    ? raw as ConversationCreatedByKind
    : null
}

function parseChannelReplyProvider(raw: unknown): CommanderChannelMeta['provider'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as CommanderChannelMeta['provider']
    : null
}

function parseChannelReplyDelivery(raw: unknown): ChannelReplyDelivery | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const id = asOptionalString(raw.id)
  const status = typeof raw.status === 'string' && CHANNEL_REPLY_DELIVERY_STATUSES.has(raw.status as ChannelReplyDelivery['status'])
    ? raw.status as ChannelReplyDelivery['status']
    : null
  const message = asOptionalString(raw.message)
  const provider = parseChannelReplyProvider(raw.provider)
  const sessionKey = asOptionalString(raw.sessionKey)
  const lastRoute = parseCommanderLastRoute(raw.lastRoute)
  const attemptedAt = asOptionalString(raw.attemptedAt)
  const updatedAt = asOptionalString(raw.updatedAt)
  if (!id || !status || !message || !provider || !sessionKey || !lastRoute || !attemptedAt || !updatedAt) {
    return undefined
  }

  const attemptCount = typeof raw.attemptCount === 'number' && Number.isFinite(raw.attemptCount)
    ? Math.max(1, Math.floor(raw.attemptCount))
    : 1

  return {
    id,
    status,
    message,
    ...(asOptionalString(raw.clientSendId) ? { clientSendId: asOptionalString(raw.clientSendId) } : {}),
    provider,
    sessionKey,
    lastRoute,
    attemptCount,
    attemptedAt,
    updatedAt,
    ...(asOptionalString(raw.deliveredAt) ? { deliveredAt: asOptionalString(raw.deliveredAt) } : {}),
    ...(asOptionalString(raw.failedAt) ? { failedAt: asOptionalString(raw.failedAt) } : {}),
    ...(asOptionalString(raw.error) ? { error: asOptionalString(raw.error) } : {}),
  }
}

function parseChannelReplyIntent(raw: unknown): ChannelReplyIntent | null {
  if (!isObject(raw)) {
    return null
  }

  const id = asOptionalString(raw.id)
  const clientSendId = asOptionalString(raw.clientSendId)
  const status = typeof raw.status === 'string' && CHANNEL_REPLY_INTENT_STATUSES.has(raw.status as ChannelReplyIntent['status'])
    ? raw.status as ChannelReplyIntent['status']
    : null
  const provider = parseChannelReplyProvider(raw.provider)
  const sessionKey = asOptionalString(raw.sessionKey)
  const lastRoute = parseCommanderLastRoute(raw.lastRoute)
  const createdAt = asOptionalString(raw.createdAt)
  const updatedAt = asOptionalString(raw.updatedAt)
  if (!id || !clientSendId || !status || !provider || !sessionKey || !lastRoute || !createdAt || !updatedAt) {
    return null
  }

  return {
    id,
    clientSendId,
    status,
    provider,
    sessionKey,
    lastRoute,
    createdAt,
    updatedAt,
    ...(asOptionalString(raw.deliveryId) ? { deliveryId: asOptionalString(raw.deliveryId) } : {}),
    ...(asOptionalString(raw.message) ? { message: asOptionalString(raw.message) } : {}),
    ...(asOptionalString(raw.error) ? { error: asOptionalString(raw.error) } : {}),
    ...(asOptionalString(raw.settledAt) ? { settledAt: asOptionalString(raw.settledAt) } : {}),
  }
}

function parseChannelReplyIntents(raw: unknown): ChannelReplyIntent[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const intents = raw
    .map(parseChannelReplyIntent)
    .filter((intent): intent is ChannelReplyIntent => Boolean(intent))
  return intents.length > 0 ? intents : undefined
}

function parseChannelInboundMessageFate(raw: unknown): ChannelInboundMessageFate | null {
  if (!isObject(raw)) {
    return null
  }

  const id = asOptionalString(raw.id)
  const fate = typeof raw.fate === 'string' && CHANNEL_INBOUND_TERMINAL_FATES.has(raw.fate as ChannelInboundMessageFate['fate'])
    ? raw.fate as ChannelInboundMessageFate['fate']
    : null
  const provider = parseChannelReplyProvider(raw.provider)
  const accountId = asOptionalString(raw.accountId)
  const rawSourceId = asOptionalString(raw.rawSourceId)
  const at = asOptionalString(raw.at)
  if (!id || !fate || !provider || !accountId || !rawSourceId || !at) {
    return null
  }

  return {
    id,
    fate,
    provider,
    accountId,
    rawSourceId,
    at,
    ...(asOptionalString(raw.clientSendId) ? { clientSendId: asOptionalString(raw.clientSendId) } : {}),
    ...(asOptionalString(raw.sourceHash) ? { sourceHash: asOptionalString(raw.sourceHash) } : {}),
    ...(asOptionalString(raw.error) ? { error: asOptionalString(raw.error) } : {}),
  }
}

function parseChannelInboundMessageFates(raw: unknown): ChannelInboundMessageFate[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const fates = raw
    .map(parseChannelInboundMessageFate)
    .filter((fate): fate is ChannelInboundMessageFate => Boolean(fate))
  return fates.length > 0 ? fates : undefined
}

function parseProviderContext(
  raw: Record<string, unknown>,
): ProviderSessionContext | undefined {
  return parseCanonicalProviderContext(raw.providerContext) ?? undefined
}

function parseApprovalBridgeState(raw: unknown): ConversationApprovalBridgeState | undefined {
  if (!isObject(raw)) {
    return undefined
  }

  const credentialId = asOptionalString(raw.credentialId)
  const createdAt = asOptionalString(raw.createdAt)
  const epoch = typeof raw.epoch === 'number' && Number.isInteger(raw.epoch) && raw.epoch >= 1
    ? raw.epoch
    : null
  if (!credentialId || !createdAt || epoch === null) {
    return undefined
  }

  return { credentialId, epoch, createdAt }
}

function cloneConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    approvalBridge: conversation.approvalBridge ? { ...conversation.approvalBridge } : undefined,
    currentTask: conversation.currentTask ? { ...conversation.currentTask } : null,
    channelMeta: conversation.channelMeta ? { ...conversation.channelMeta } : undefined,
    lastRoute: conversation.lastRoute ? { ...conversation.lastRoute } : undefined,
    channelReplyDelivery: conversation.channelReplyDelivery
      ? {
        ...conversation.channelReplyDelivery,
        lastRoute: { ...conversation.channelReplyDelivery.lastRoute },
      }
      : undefined,
    channelReplyIntents: conversation.channelReplyIntents
      ? conversation.channelReplyIntents.map((intent) => ({
        ...intent,
        lastRoute: { ...intent.lastRoute },
      }))
      : undefined,
    channelInboundFates: conversation.channelInboundFates
      ? conversation.channelInboundFates.map((fate) => ({ ...fate }))
      : undefined,
    voiceConfig: conversation.voiceConfig
      ? {
        ...(conversation.voiceConfig.tts ? { tts: { ...conversation.voiceConfig.tts } } : {}),
        ...(conversation.voiceConfig.stt ? { stt: { ...conversation.voiceConfig.stt } } : {}),
      }
      : undefined,
  }
}

function parseConversation(raw: unknown): ParsedConversation | null {
  if (!isObject(raw)) {
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const commanderId = typeof raw.commanderId === 'string' ? raw.commanderId.trim() : ''
  const surface = parseSurface(raw.surface)
  const status = parseStatus(raw.status)
  const name = asOptionalString(raw.name)
  const creationSource = parseCreationSource(raw.creationSource)
  const createdByKind = parseCreatedByKind(raw.createdByKind)
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt.trim() : ''
  const lastMessageAt = typeof raw.lastMessageAt === 'string' ? raw.lastMessageAt.trim() : ''
  if (
    !id ||
    !commanderId ||
    !surface ||
    !status ||
    !name ||
    !creationSource ||
    !createdByKind ||
    Object.prototype.hasOwnProperty.call(raw, 'heartbeat') ||
    !createdAt ||
    !lastMessageAt
  ) {
    return null
  }

  const lastHeartbeat = asNullableString(raw.lastHeartbeat)
  const heartbeatTickCount = typeof raw.heartbeatTickCount === 'number' && Number.isFinite(raw.heartbeatTickCount)
    ? Math.max(0, Math.floor(raw.heartbeatTickCount))
    : 0
  const completedTasks = typeof raw.completedTasks === 'number' && Number.isFinite(raw.completedTasks)
    ? Math.max(0, Math.floor(raw.completedTasks))
    : 0
  const totalCostUsd = typeof raw.totalCostUsd === 'number' && Number.isFinite(raw.totalCostUsd)
    ? Math.max(0, raw.totalCostUsd)
    : 0
  const agentType = parseProviderId(raw.agentType)
  const model = asOptionalNullableString(raw.model)
  const providerContext = parseProviderContext(raw)
  const effort = parseStoredAgentEffort(agentType ?? providerContext?.providerId ?? '', raw.effort)
  const adaptiveThinking = isClaudeAdaptiveThinkingMode(raw.adaptiveThinking)
    ? raw.adaptiveThinking
    : undefined
  const maxThinkingTokens = isClaudeMaxThinkingTokens(raw.maxThinkingTokens)
    ? raw.maxThinkingTokens
    : undefined
  const credentialPoolId = asOptionalString(raw.credentialPoolId)
  const approvalBridge = parseApprovalBridgeState(raw.approvalBridge)

  return {
    id,
    commanderId,
    surface,
    channelMeta: parseCommanderChannelMeta(raw.channelMeta),
    lastRoute: parseCommanderLastRoute(raw.lastRoute),
    channelReplyDelivery: parseChannelReplyDelivery(raw.channelReplyDelivery),
    channelReplyIntents: parseChannelReplyIntents(raw.channelReplyIntents),
    channelInboundFates: parseChannelInboundMessageFates(raw.channelInboundFates),
    voiceConfig: normalizeVoiceConfig(raw.voiceConfig),
    agentType,
    ...(model !== undefined ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(adaptiveThinking ? { adaptiveThinking } : {}),
    ...(maxThinkingTokens ? { maxThinkingTokens } : {}),
    name,
    status,
    currentTask: parseCurrentTask(raw.currentTask),
    ...(providerContext ? { providerContext } : {}),
    ...(credentialPoolId ? { credentialPoolId } : {}),
    ...(approvalBridge ? { approvalBridge } : {}),
    lastHeartbeat,
    heartbeatTickCount,
    completedTasks,
    totalCostUsd,
    creationSource,
    createdByKind,
    ...(asOptionalString(raw.createdById) ? { createdById: asOptionalString(raw.createdById) } : {}),
    ...(asOptionalString(raw.createdBySessionName) ? { createdBySessionName: asOptionalString(raw.createdBySessionName) } : {}),
    ...(asOptionalString(raw.createdByConversationId) ? { createdByConversationId: asOptionalString(raw.createdByConversationId) } : {}),
    ...(asOptionalString(raw.requestId) ? { requestId: asOptionalString(raw.requestId) } : {}),
    createdAt,
    lastMessageAt,
  }
}

function isSafeUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

function normalizeConversation(
  input: Conversation,
): Conversation {
  if (!isSafeUuid(input.id)) {
    throw new Error(`Invalid conversation id "${input.id}"`)
  }
  if (input.commanderId.trim().length === 0) {
    throw new Error(`Invalid commander id "${input.commanderId}"`)
  }
  const name = normalizeConversationName(input.name)
  if (!name) {
    throw new Error('Conversation name must be 1-64 characters')
  }
  if (!CONVERSATION_STATUSES.has(input.status)) {
    throw new Error(`Invalid conversation status "${input.status}"`)
  }
  if (!CREATION_SOURCES.has(input.creationSource)) {
    throw new Error(`Invalid conversation creationSource "${input.creationSource}"`)
  }
  if (!CREATED_BY_KINDS.has(input.createdByKind)) {
    throw new Error(`Invalid conversation createdByKind "${input.createdByKind}"`)
  }
  const model = asOptionalNullableString(input.model)
  const effort = parseStoredAgentEffort(input.agentType ?? input.providerContext?.providerId ?? '', input.effort)
  const approvalBridge = parseApprovalBridgeState(input.approvalBridge)
  const createdById = asOptionalString(input.createdById)
  const createdBySessionName = asOptionalString(input.createdBySessionName)
  const createdByConversationId = asOptionalString(input.createdByConversationId)
  const requestId = asOptionalString(input.requestId)
  const credentialPoolId = asOptionalString(input.credentialPoolId)

  return {
    id: input.id,
    commanderId: input.commanderId,
    surface: input.surface,
    ...(input.channelMeta ? { channelMeta: { ...input.channelMeta } } : {}),
    ...(input.lastRoute ? { lastRoute: { ...input.lastRoute } } : {}),
    ...(input.channelReplyDelivery
      ? {
        channelReplyDelivery: {
          ...input.channelReplyDelivery,
          lastRoute: { ...input.channelReplyDelivery.lastRoute },
        },
      }
      : {}),
    ...(input.channelReplyIntents?.length
      ? {
        channelReplyIntents: input.channelReplyIntents.map((intent) => ({
          ...intent,
          lastRoute: { ...intent.lastRoute },
        })),
      }
      : {}),
    ...(input.channelInboundFates?.length
      ? { channelInboundFates: input.channelInboundFates.map((fate) => ({ ...fate })) }
      : {}),
    ...(input.voiceConfig ? { voiceConfig: normalizeVoiceConfig(input.voiceConfig) } : {}),
    agentType: input.agentType ?? null,
    ...(model !== undefined ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(isClaudeAdaptiveThinkingMode(input.adaptiveThinking)
      ? { adaptiveThinking: input.adaptiveThinking }
      : {}),
    ...(isClaudeMaxThinkingTokens(input.maxThinkingTokens)
      ? { maxThinkingTokens: input.maxThinkingTokens }
      : {}),
    name,
    status: input.status,
    currentTask: input.currentTask ? { ...input.currentTask } : null,
    ...(input.providerContext ? { providerContext: { ...input.providerContext } } : {}),
    ...(credentialPoolId ? { credentialPoolId } : {}),
    ...(approvalBridge ? { approvalBridge } : {}),
    lastHeartbeat: input.lastHeartbeat,
    heartbeatTickCount: Math.max(0, Math.floor(input.heartbeatTickCount)),
    completedTasks: Math.max(0, Math.floor(input.completedTasks)),
    totalCostUsd: Math.max(0, input.totalCostUsd),
    creationSource: input.creationSource,
    createdByKind: input.createdByKind,
    ...(createdById ? { createdById } : {}),
    ...(createdBySessionName ? { createdBySessionName } : {}),
    ...(createdByConversationId ? { createdByConversationId } : {}),
    ...(requestId ? { requestId } : {}),
    createdAt: input.createdAt,
    lastMessageAt: input.lastMessageAt,
  }
}

function toConversationFilePath(dataDir: string, commanderId: string, conversationId: string): string {
  const commanderRoot = resolveCommanderPaths(commanderId, dataDir).commanderRoot
  return path.join(commanderRoot, 'conversations', `${conversationId}.json`)
}

export class ConversationStore {
  private readonly dataDir: string
  private conversationsById: Map<string, Conversation> | null = null
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string = resolveCommanderDataDir()) {
    this.dataDir = path.resolve(dataDir)
  }

  async listAll(): Promise<Conversation[]> {
    await this.ensureLoaded()
    return [...this.items().values()]
      .map((conversation) => cloneConversation(conversation))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async listByCommander(commanderId: string): Promise<Conversation[]> {
    await this.ensureLoaded()
    return [...this.items().values()]
      .filter((conversation) => conversation.commanderId === commanderId)
      .map((conversation) => cloneConversation(conversation))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async getActiveChatForCommander(commanderId: string): Promise<Conversation | null> {
    await this.ensureLoaded()
    const defaultConversationId = buildDefaultCommanderConversationId(commanderId)
    const [active] = [...this.items().values()]
      .filter((conversation) => (
        conversation.commanderId === commanderId
        && conversation.id !== defaultConversationId
        && DEFAULT_CHAT_STATUSES.has(conversation.status)
        && CHAT_SURFACES.has(conversation.surface)
      ))
      .sort((left, right) => {
        // Status priority (issue #1362 corrected contract): active before idle.
        // Within a single status bucket, prefer the most recently created chat
        // so a brand-new chat the user just clicked Create on always wins.
        const statusDelta = activeChatStatusPriority(left.status) - activeChatStatusPriority(right.status)
        if (statusDelta !== 0) {
          return statusDelta
        }

        const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt)
        if (Number.isFinite(createdDelta) && createdDelta !== 0) {
          return createdDelta
        }

        return left.id.localeCompare(right.id)
      })

    return active ? cloneConversation(active) : null
  }

  async get(conversationId: string): Promise<Conversation | null> {
    await this.ensureLoaded()
    const found = this.items().get(conversationId)
    return found ? cloneConversation(found) : null
  }

  async create(
    input: Omit<Conversation, 'id' | 'name'> & { id?: string; name?: string },
  ): Promise<Conversation> {
    return withCommanderChildCreation(input.commanderId, this.dataDir, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const id = input.id?.trim() || randomUUID()
        if (this.items().has(id)) {
          throw new Error(`Conversation "${id}" already exists`)
        }

        const name = this.resolveConversationName(input.commanderId, input.name)
        this.assertConversationNameAvailable(input.commanderId, name)

        const normalized = normalizeConversation({
          ...input,
          id,
          name,
        })
        this.items().set(id, cloneConversation(normalized))
        await this.writeConversation(normalized)
        return cloneConversation(normalized)
      })
    ))
  }

  async update(
    conversationId: string,
    mutate: (current: Conversation) => Conversation,
  ): Promise<Conversation | null> {
    await this.ensureLoaded()
    const observed = this.items().get(conversationId)
    if (!observed) {
      return null
    }

    return withCommanderChildCreation(observed.commanderId, this.dataDir, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const existing = this.items().get(conversationId)
        if (!existing) {
          return null
        }
        if (existing.commanderId !== observed.commanderId) {
          throw new Error(`Conversation "${conversationId}" changed commander during update`)
        }

        const next = normalizeConversation(mutate(cloneConversation(existing)))
        if (next.commanderId !== existing.commanderId) {
          throw new Error('Conversation commanderId cannot be changed by update')
        }
        this.assertConversationNameAvailable(next.commanderId, next.name, conversationId)
        this.items().set(conversationId, cloneConversation(next))
        await this.writeConversation(next)
        return cloneConversation(next)
      })
    ))
  }

  async delete(conversationId: string): Promise<Conversation | null> {
    await this.ensureLoaded()
    const observed = this.items().get(conversationId)
    if (!observed) {
      return null
    }

    return withCommanderChildCreation(observed.commanderId, this.dataDir, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const existing = this.items().get(conversationId)
        if (!existing) {
          return null
        }
        if (existing.commanderId !== observed.commanderId) {
          throw new Error(`Conversation "${conversationId}" changed commander during delete`)
        }

        this.items().delete(conversationId)
        await this.deleteConversationFile(existing)
        return cloneConversation(existing)
      })
    ))
  }

  /**
   * Resolve the conversation-lifetime approval bridge credential, creating it
   * on first use. Every provider launch/replacement path for the same
   * conversation resolves this same credential, so all process generations
   * hold equivalent bridge tokens and provider rotation stays invisible to
   * the approval path. Returns null when the conversation does not exist.
   */
  async ensureApprovalBridgeCredential(
    conversationId: string,
  ): Promise<ConversationApprovalBridgeState | null> {
    const existing = await this.get(conversationId)
    if (!existing) {
      return null
    }
    if (existing.approvalBridge) {
      return { ...existing.approvalBridge }
    }

    const updated = await this.update(conversationId, (current) => {
      if (current.approvalBridge) {
        return current
      }
      return {
        ...current,
        approvalBridge: {
          credentialId: randomUUID(),
          epoch: 1,
          createdAt: new Date().toISOString(),
        },
      }
    })
    return updated?.approvalBridge ? { ...updated.approvalBridge } : null
  }

  /**
   * Explicit operator revocation: mint a fresh credential id and bump the
   * epoch so every outstanding bridge token for this conversation stops
   * validating. This is the only revocation trigger besides conversation
   * archive/delete — provider replacement must never call this.
   */
  async rotateApprovalBridgeCredential(
    conversationId: string,
  ): Promise<ConversationApprovalBridgeState | null> {
    const updated = await this.update(conversationId, (current) => ({
      ...current,
      approvalBridge: {
        credentialId: randomUUID(),
        epoch: (current.approvalBridge?.epoch ?? 1) + 1,
        createdAt: new Date().toISOString(),
      },
    }))
    return updated?.approvalBridge ? { ...updated.approvalBridge } : null
  }

  async ensureDefaultConversation(input: {
    commanderId: string
    surface?: Conversation['surface']
    createdAt: string
    currentTask?: CommanderCurrentTask | null
  }): Promise<Conversation> {
    const id = buildDefaultCommanderConversationId(input.commanderId)
    const existing = await this.get(id)
    if (existing) {
      return existing
    }

    return this.create({
      id,
      commanderId: input.commanderId,
      surface: input.surface ?? 'ui',
      status: 'idle',
      currentTask: input.currentTask ?? null,
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      completedTasks: 0,
      totalCostUsd: 0,
      creationSource: 'system-default',
      createdByKind: 'system',
      createdAt: input.createdAt,
      lastMessageAt: input.createdAt,
    })
  }

  private items(): Map<string, Conversation> {
    if (!this.conversationsById) {
      throw new Error('ConversationStore not loaded')
    }
    return this.conversationsById
  }

  private async ensureLoaded(): Promise<void> {
    if (this.conversationsById) {
      return
    }
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      const loaded = await this.readAllFromDisk()
      if (!this.conversationsById) {
        this.conversationsById = new Map(
          loaded.map((conversation) => [conversation.id, cloneConversation(conversation)]),
        )
      }
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async readAllFromDisk(): Promise<Conversation[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    const conversationsById = new Map<string, Conversation>()
    const namesByCommander = new Map<string, Set<string>>()
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const conversationsDir = path.join(this.dataDir, entry.name, 'conversations')
      let files: import('node:fs').Dirent[]
      try {
        files = await readdir(conversationsDir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw error
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) {
          continue
        }
        const filePath = path.join(conversationsDir, file.name)

        try {
          const raw = await readFile(filePath, 'utf8')
          const parsedJson = JSON.parse(raw) as unknown
          if (!isObject(parsedJson)) {
            await this.quarantineUnreadableConversation(filePath)
            continue
          }

          const parsed = parseConversation(parsedJson)
          if (parsed) {
            const normalized = this.normalizePersistedConversation(parsed, namesByCommander)
            conversationsById.set(normalized.id, normalized)
          } else {
            await this.quarantineUnreadableConversation(filePath)
          }
        } catch {
          await this.quarantineUnreadableConversation(filePath)
        }
      }
    }

    return [...conversationsById.values()]
  }

  private async quarantineUnreadableConversation(filePath: string): Promise<void> {
    try {
      await quarantineJsonFile(filePath)
    } catch {
      // Keep the API readable even if the operator must clean up the file by hand.
    }
  }

  private async writeConversation(conversation: Conversation): Promise<void> {
    const filePath = toConversationFilePath(this.dataDir, conversation.commanderId, conversation.id)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeJsonFileAtomically(filePath, withJsonStoreSchema({ ...normalizeConversation(conversation) }))
  }

  private async deleteConversationFile(conversation: Conversation): Promise<void> {
    const filePath = toConversationFilePath(this.dataDir, conversation.commanderId, conversation.id)
    await rm(filePath, { force: true })
  }

  private resolveConversationName(commanderId: string, requestedName?: string): string {
    const parsed = normalizeConversationName(requestedName)
    if (parsed) {
      return parsed
    }

    return generateConversationName(this.listConversationNames(commanderId))
  }

  private listConversationNames(commanderId: string, excludeConversationId?: string): string[] {
    return [...this.items().values()]
      .filter((conversation) => (
        conversation.commanderId === commanderId
        && conversation.id !== excludeConversationId
      ))
      .map((conversation) => conversation.name)
  }

  private assertConversationNameAvailable(
    commanderId: string,
    name: string,
    excludeConversationId?: string,
  ): void {
    const collision = [...this.items().values()].find((conversation) => (
      conversation.commanderId === commanderId
      && conversation.id !== excludeConversationId
      && conversationNamesEqual(conversation.name, name)
    ))
    if (!collision) {
      return
    }

    throw new Error(
      `Conversation name "${name}" already exists for commander "${commanderId}"`,
    )
  }

  private normalizePersistedConversation(
    parsed: ParsedConversation,
    namesByCommander: Map<string, Set<string>>,
  ): Conversation {
    const commanderNames = namesByCommander.get(parsed.commanderId) ?? new Set<string>()
    namesByCommander.set(parsed.commanderId, commanderNames)

    const name = normalizeConversationName(parsed.name)
    if (!name) {
      throw new Error(`Conversation "${parsed.id}" is missing a valid name`)
    }
    const normalized = normalizeConversation({
      ...parsed,
      name,
    })

    commanderNames.add(name)
    return normalized
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
