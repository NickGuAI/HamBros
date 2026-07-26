import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import type {
  AgentSession,
  AgentType,
  ProviderModelDiscoveryState,
  ProviderModelOption,
} from '@/types'
import type { AgentEffortLevel } from '@modules/agents/effort.js'
import type { MsgItem } from '@modules/agents/messages/model'
import type { CommanderCurrentTask } from '@modules/commanders/hooks/useCommander'
import type { ClaudeAdaptiveThinkingMode } from '@modules/claude-adaptive-thinking.js'
import type { ClaudeMaxThinkingTokens } from '@modules/claude-max-thinking-tokens.js'
import type {
  Conversation as ConversationContract,
  ConversationStatus,
  ConversationSurface,
} from '@gehirn/herd-cli/session-contract'
import type { WorkspaceContextPayload } from '@modules/workspace/types'
import type { ConversationCredentialSelectionModes } from '@modules/commanders/conversation-credential-selection.js'

const CONVERSATIONS_POLL_INTERVAL_MS = 5000
const CONVERSATIONS_LIST_STALE_MS = 30_000
const ACTIVE_CONVERSATION_STALE_MS = 30_000
const COMMANDER_CONVERSATIONS_QUERY_KEY = ['commanders', 'conversations'] as const
const COMMANDER_ACTIVE_CONVERSATION_QUERY_KEY = ['commanders', 'conversations', 'active'] as const
export const COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY = ['commanders', 'conversations', 'bootstrap'] as const
const CONVERSATION_DETAIL_QUERY_KEY = ['conversations', 'detail'] as const
const CONVERSATION_MESSAGES_QUERY_KEY = ['conversations', 'messages'] as const

export interface ConversationRecord extends Omit<ConversationContract, 'currentTask' | 'status' | 'surface'> {
  currentTask: CommanderCurrentTask | null
  status: ConversationStatus
  surface: ConversationSurface
  agentType?: AgentType | null
  model?: string | null
  providerContext?: ConversationContract['providerContext']
  runtimeState?: ConversationRuntimeState
  websocketReady?: boolean
  runtimeError?: string | null
  liveSession: AgentSession | null
  canonicalOrder?: number
  displayState?: ConversationDisplayState
  sendTarget?: ConversationSendTarget | null
  allowedActions?: ConversationAllowedActions
  runtimeSettings?: ConversationRuntimeSettings
  initialMessagePage?: ConversationMessagesPage
}

export type ConversationRuntimeState = 'idle' | 'starting' | 'active' | 'failed' | 'archived'

export type ConversationAction =
  | 'send'
  | 'queue'
  | 'media'
  | 'start'
  | 'pause'
  | 'resume'
  | 'archive'
  | 'delete'
  | 'updateProvider'

export type ConversationDisabledReasons = Record<ConversationAction, string | null>

export type ConversationAllowedActions = Record<ConversationAction, boolean>

export interface ConversationCapabilityState {
  supported: boolean
  reason: string | null
}

export interface ConversationRuntimeSettingsValues {
  agentType: AgentType
  model: string | null
  effort: AgentEffortLevel | null
  adaptiveThinking: ClaudeAdaptiveThinkingMode | null
  maxThinkingTokens: number | null
}

export interface ConversationRuntimeSettings {
  credentialSelectionModes: ConversationCredentialSelectionModes
  current: ConversationRuntimeSettingsValues
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
  modelDiscovery: ProviderModelDiscoveryState
  supportsCustomModels: boolean
  allowed: boolean
  disabledReason: string | null
}

export interface ConversationSendTarget {
  kind: 'conversation'
  conversationId: string
  commanderId: string
  sessionName: string
  transportType: AgentSession['transportType'] | null
  agentType: AgentType | null
  queue: ConversationCapabilityState
  media: ConversationCapabilityState
}

export interface ConversationDisplayState {
  status: ConversationStatus
  runtimeState?: ConversationRuntimeState
  websocketReady?: boolean
  runtimeError?: string | null
  isVisible: boolean
  isDefaultConversation: boolean
  hasLiveSession: boolean
  isSendable: boolean
  isQueueable: boolean
  isMediaSendable: boolean
  label: string
  disabledReasons: ConversationDisabledReasons
}

export interface ConversationMessageInput {
  conversationId: string
  message: string
  images?: Array<{
    mediaType: string
    data: string
  }>
  clientSendId?: string
  queue?: boolean
  workspaceContext?: WorkspaceContextPayload
}

export interface CreateConversationInput {
  commanderId: string
  surface?: ConversationSurface
  id?: string
  channelMeta?: Record<string, unknown>
  currentTask?: CommanderCurrentTask | null
  agentType?: AgentType
  model?: string | null
  credentialPoolId?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
}

export interface StartConversationInput {
  conversationId: string
  agentType?: AgentType
  model?: string | null
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  cwd?: string
  host?: string
}

export interface StopConversationInput {
  conversationId: string
}

export interface UpdateConversationInput {
  conversationId: string
  name?: string
  agentType?: AgentType
  model?: string | null
  credentialPoolId?: string
  effort?: AgentEffortLevel
  adaptiveThinking?: ClaudeAdaptiveThinkingMode
  maxThinkingTokens?: ClaudeMaxThinkingTokens
  status?: ConversationStatus
}

export type ConversationRuntimeSettingsUpdate = Pick<
  UpdateConversationInput,
  | 'agentType'
  | 'model'
  | 'credentialPoolId'
  | 'effort'
  | 'adaptiveThinking'
  | 'maxThinkingTokens'
>

export interface DeleteConversationInput {
  conversationId: string
  hard?: boolean
}

interface ConversationMessageResponse {
  accepted: boolean
  createdSession: boolean
  disposition: 'started' | 'interrupted' | 'queued' | 'duplicate'
  conversation: ConversationRecord
  messagePage?: ConversationMessagesPage
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

interface ConversationMessagesInfiniteData {
  pages: ConversationMessagesPage[]
  pageParams: unknown[]
}

interface StartConversationResponse {
  conversation: ConversationRecord
}

interface DeleteConversationResponse {
  deleted: boolean
  hard: boolean
  id: string
  commanderId: string
}

export interface CommanderConversationBootstrapProjection {
  commanderId: string
  conversations: ConversationRecord[]
  activeConversation: ConversationRecord | null
  selectedConversation: ConversationRecord | null
  selectedConversationId: string | null
}

function isCommanderConversationBootstrapProjection(
  value: unknown,
): value is CommanderConversationBootstrapProjection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<CommanderConversationBootstrapProjection>
  return typeof candidate.commanderId === 'string'
    && Array.isArray(candidate.conversations)
    && (candidate.activeConversation === null || typeof candidate.activeConversation === 'object')
    && (candidate.selectedConversation === null || typeof candidate.selectedConversation === 'object')
    && (
      candidate.selectedConversationId === null
      || typeof candidate.selectedConversationId === 'string'
      || candidate.selectedConversationId === undefined
    )
}

function conversationStatusPriority(status: ConversationStatus): number {
  switch (status) {
    case 'active':
      return 0
    case 'idle':
      return 1
    case 'archived':
      return 2
    default:
      return 3
  }
}

export function sortConversations(conversations: readonly ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((left, right) => {
    if (
      typeof left.canonicalOrder === 'number'
      && typeof right.canonicalOrder === 'number'
      && Number.isFinite(left.canonicalOrder)
      && Number.isFinite(right.canonicalOrder)
    ) {
      const canonicalDelta = left.canonicalOrder - right.canonicalOrder
      if (canonicalDelta !== 0) {
        return canonicalDelta
      }
    }

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
}

function conversationReadinessRank(conversation: ConversationRecord | null | undefined): number {
  if (!conversation) {
    return -1
  }
  if (
    conversation.websocketReady === true ||
    conversation.displayState?.websocketReady === true ||
    conversation.allowedActions?.send === true
  ) {
    return 4
  }
  if (conversation.runtimeState === 'active' || conversation.status === 'active') {
    return 3
  }
  if (conversation.runtimeState === 'starting') {
    return 2
  }
  if (conversation.runtimeState === 'failed') {
    return 1
  }
  return 0
}

function conversationBootstrapRefetchInterval(query: {
  state: {
    data?: unknown
    error: unknown
  }
}, options: UseConversationsOptions = {}): number | false {
  if (query.state.error) {
    return CONVERSATIONS_POLL_INTERVAL_MS
  }
  if (bootstrapNeedsPushFallbackPolling(query.state.data, options)) {
    return CONVERSATIONS_POLL_INTERVAL_MS
  }
  return false
}

function conversationNeedsPushFallbackPolling(
  conversation: ConversationRecord | null | undefined,
  options: UseConversationsOptions,
): boolean {
  if (!conversation) {
    return false
  }
  const isLiveOrStarting = conversation.runtimeState === 'starting'
    || conversation.runtimeState === 'active'
    || conversation.status === 'active'
  const websocketReady = conversation.websocketReady === true
    || conversation.displayState?.websocketReady === true
  return isLiveOrStarting && (!websocketReady || options.clientPushConnected === false)
}

function bootstrapNeedsPushFallbackPolling(value: unknown, options: UseConversationsOptions): boolean {
  if (!isCommanderConversationBootstrapProjection(value)) {
    return false
  }
  return conversationNeedsPushFallbackPolling(value.selectedConversation, options)
    || conversationNeedsPushFallbackPolling(value.activeConversation, options)
    || value.conversations.some((conversation) => conversationNeedsPushFallbackPolling(conversation, options))
}

function timestampMs(value: string | null | undefined): number {
  if (!value) {
    return 0
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function conversationFreshnessMs(conversation: ConversationRecord): number {
  return Math.max(
    timestampMs(conversation.lastMessageAt),
    timestampMs(conversation.createdAt),
  )
}

function selectConversationCandidate(
  detail: ConversationRecord | null | undefined,
  list: ConversationRecord | null | undefined,
): ConversationRecord | null {
  if (!detail) {
    return list ?? null
  }
  if (!list) {
    return detail
  }

  const detailRank = conversationReadinessRank(detail)
  const listRank = conversationReadinessRank(list)
  if (listRank > detailRank) {
    return list
  }
  if (detailRank > listRank) {
    return detail
  }
  return conversationFreshnessMs(list) > conversationFreshnessMs(detail) ? list : detail
}

export function commanderConversationsQueryKey(commanderId: string) {
  return [...COMMANDER_CONVERSATIONS_QUERY_KEY, commanderId] as const
}

export function commanderActiveConversationQueryKey(commanderId: string) {
  return [...COMMANDER_ACTIVE_CONVERSATION_QUERY_KEY, commanderId] as const
}

export function commanderConversationBootstrapQueryKey(
  commanderId: string,
  selectedConversationId?: string | null,
) {
  return [
    ...COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY,
    commanderId,
    selectedConversationId ?? 'active',
  ] as const
}

export function conversationDetailQueryKey(conversationId: string) {
  return [...CONVERSATION_DETAIL_QUERY_KEY, conversationId] as const
}

export function conversationMessagesQueryKey(conversationId: string) {
  return [...CONVERSATION_MESSAGES_QUERY_KEY, conversationId] as const
}

export async function fetchCommanderConversationBootstrap(
  commanderId: string,
  selectedConversationId?: string | null,
): Promise<CommanderConversationBootstrapProjection> {
  const params = new URLSearchParams()
  if (selectedConversationId) {
    params.set('conversationId', selectedConversationId)
  }
  const query = params.toString()
  return fetchJson<CommanderConversationBootstrapProjection>(
    `/api/commanders/${encodeURIComponent(commanderId)}/conversations/bootstrap${query ? `?${query}` : ''}`,
  )
}

export async function fetchCommanderActiveConversation(
  commanderId: string,
): Promise<ConversationRecord | null> {
  return fetchJson<ConversationRecord | null>(
    `/api/commanders/${encodeURIComponent(commanderId)}/conversations/active`,
  )
}

export const ACTIVE_CONVERSATION_FETCH_STALE_MS = ACTIVE_CONVERSATION_STALE_MS
export const CONVERSATION_MESSAGES_PAGE_SIZE = 50

async function fetchConversationMessagesPage(input: {
  conversationId: string
  before?: string | null
  limit?: number
}): Promise<ConversationMessagesPage> {
  const params = new URLSearchParams()
  if (input.limit !== undefined) {
    params.set('limit', String(input.limit))
  }
  if (input.before) {
    params.set('before', input.before)
  }

  const query = params.toString()
  return fetchJson<ConversationMessagesPage>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}/messages${query ? `?${query}` : ''}`,
  )
}

async function postConversationMessage(
  input: ConversationMessageInput,
): Promise<ConversationMessageResponse> {
  return fetchJson<ConversationMessageResponse>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        ...(input.clientSendId ? { clientSendId: input.clientSendId } : {}),
        ...(input.queue ? { queue: true } : {}),
        ...(input.workspaceContext ? { workspaceContext: input.workspaceContext } : {}),
      }),
    },
  )
}

async function postCreateConversation(
  input: CreateConversationInput,
): Promise<ConversationRecord> {
  return fetchJson<ConversationRecord>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/conversations`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        surface: input.surface ?? 'ui',
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.channelMeta !== undefined ? { channelMeta: input.channelMeta } : {}),
        ...(input.currentTask !== undefined ? { currentTask: input.currentTask } : {}),
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.credentialPoolId !== undefined
          ? { credentialPoolId: input.credentialPoolId }
          : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.adaptiveThinking !== undefined
          ? { adaptiveThinking: input.adaptiveThinking }
          : {}),
        ...(input.maxThinkingTokens !== undefined
          ? { maxThinkingTokens: input.maxThinkingTokens }
          : {}),
      }),
    },
  )
}

async function postStartConversation(
  input: StartConversationInput,
): Promise<ConversationRecord> {
  const response = await fetchJson<StartConversationResponse>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}/start`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.adaptiveThinking !== undefined
          ? { adaptiveThinking: input.adaptiveThinking }
          : {}),
        ...(input.maxThinkingTokens !== undefined
          ? { maxThinkingTokens: input.maxThinkingTokens }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
      }),
    },
  )

  return response.conversation
}

async function postStopConversation(
  input: StopConversationInput,
): Promise<ConversationRecord> {
  return fetchJson<ConversationRecord>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}/pause`,
    {
      method: 'POST',
    },
  )
}

async function patchConversation(
  input: UpdateConversationInput,
): Promise<ConversationRecord> {
  const runtimeSettings = {
    ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.credentialPoolId !== undefined
      ? { credentialPoolId: input.credentialPoolId }
      : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.adaptiveThinking !== undefined
      ? { adaptiveThinking: input.adaptiveThinking }
      : {}),
    ...(input.maxThinkingTokens !== undefined
      ? { maxThinkingTokens: input.maxThinkingTokens }
      : {}),
  }
  return fetchJson<ConversationRecord>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(Object.keys(runtimeSettings).length > 0 ? { runtimeSettings } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),
    },
  )
}

async function deleteConversation(
  input: DeleteConversationInput,
): Promise<DeleteConversationResponse> {
  const querySuffix = input.hard ? '?hard=true' : ''
  return fetchJson<DeleteConversationResponse>(
    `/api/conversations/${encodeURIComponent(input.conversationId)}${querySuffix}`,
    {
      method: 'DELETE',
    },
  )
}

export function upsertConversationList(
  current: ConversationRecord[] | undefined,
  nextConversation: ConversationRecord,
): ConversationRecord[] {
  const existing = current ?? []
  const withoutPrevious = existing.filter((conversation) => conversation.id !== nextConversation.id)
  return sortConversations([...withoutPrevious, nextConversation])
}

function updateConversationMessagePageCache(
  queryClient: QueryClient,
  messagePage: ConversationMessagesPage,
) {
  queryClient.setQueryData(
    conversationMessagesQueryKey(messagePage.conversationId),
    (current: ConversationMessagesInfiniteData | undefined) => ({
      pages: [
        messagePage,
        ...(current?.pages.slice(1) ?? []),
      ],
      pageParams: [
        null,
        ...(current?.pageParams.slice(1) ?? []),
      ],
    }),
  )
}

function updateConversationCaches(
  queryClient: QueryClient,
  conversation: ConversationRecord,
  options: {
    messagePage?: ConversationMessagesPage
  } = {},
) {
  queryClient.setQueryData(
    conversationDetailQueryKey(conversation.id),
    conversation,
  )
  queryClient.setQueryData(
    commanderConversationsQueryKey(conversation.commanderId),
    (current: ConversationRecord[] | undefined) =>
      upsertConversationList(current, conversation),
  )
  queryClient.setQueriesData<CommanderConversationBootstrapProjection>(
    { queryKey: COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY },
    (current) => {
      if (!current || current.commanderId !== conversation.commanderId) {
        return current
      }
      return {
        ...current,
        conversations: upsertConversationList(current.conversations, conversation),
        activeConversation: conversation.status === 'active'
          ? conversation
          : current.activeConversation?.id === conversation.id
            ? null
            : current.activeConversation,
        selectedConversation: current.selectedConversation?.id === conversation.id
          || current.selectedConversationId === conversation.id
          ? conversation
          : current.selectedConversation,
      }
    },
  )
  void queryClient.invalidateQueries({
    queryKey: commanderActiveConversationQueryKey(conversation.commanderId),
  })
  if (options.messagePage) {
    updateConversationMessagePageCache(queryClient, options.messagePage)
  } else {
    void queryClient.invalidateQueries({
      queryKey: conversationMessagesQueryKey(conversation.id),
    })
  }
}

function removeConversationCaches(
  queryClient: QueryClient,
  payload: DeleteConversationResponse,
) {
  queryClient.removeQueries({
    queryKey: conversationDetailQueryKey(payload.id),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: conversationMessagesQueryKey(payload.id),
    exact: true,
  })
  queryClient.setQueryData(
    commanderConversationsQueryKey(payload.commanderId),
    (current: ConversationRecord[] | undefined) =>
      (current ?? []).filter((conversation) => conversation.id !== payload.id),
  )
  queryClient.setQueriesData<CommanderConversationBootstrapProjection>(
    { queryKey: COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY },
    (current) => {
      if (!current || current.commanderId !== payload.commanderId) {
        return current
      }
      return {
        ...current,
        conversations: current.conversations.filter((conversation) => conversation.id !== payload.id),
        activeConversation: current.activeConversation?.id === payload.id
          ? null
          : current.activeConversation,
        selectedConversation: current.selectedConversation?.id === payload.id
          ? null
          : current.selectedConversation,
        selectedConversationId: current.selectedConversationId === payload.id
          ? null
          : current.selectedConversationId,
      }
    },
  )
  void queryClient.invalidateQueries({
    queryKey: commanderActiveConversationQueryKey(payload.commanderId),
  })
}

export function applyCommanderConversationBootstrapProjection(
  queryClient: QueryClient,
  projection: CommanderConversationBootstrapProjection,
): void {
  queryClient.setQueryData(
    commanderConversationsQueryKey(projection.commanderId),
    sortConversations(projection.conversations),
  )
  queryClient.setQueryData(
    commanderActiveConversationQueryKey(projection.commanderId),
    projection.activeConversation,
  )
  for (const conversation of projection.conversations) {
    queryClient.setQueryData(conversationDetailQueryKey(conversation.id), conversation)
    if (conversation.initialMessagePage) {
      updateConversationMessagePageCache(queryClient, conversation.initialMessagePage)
    }
  }
}

function getRecordInitialMessagePage(
  conversation: ConversationRecord | null | undefined,
  conversationId: string,
): ConversationMessagesPage | undefined {
  return conversation?.id === conversationId && conversation.initialMessagePage?.conversationId === conversationId
    ? conversation.initialMessagePage
    : undefined
}

function getInitialConversationMessagePage(
  queryClient: QueryClient,
  conversationId: string,
): ConversationMessagesPage | undefined {
  const detailPage = getRecordInitialMessagePage(
    queryClient.getQueryData<ConversationRecord>(conversationDetailQueryKey(conversationId)),
    conversationId,
  )
  if (detailPage) {
    return detailPage
  }

  for (const [, activeConversation] of queryClient.getQueriesData<ConversationRecord | null>({
    queryKey: COMMANDER_ACTIVE_CONVERSATION_QUERY_KEY,
  })) {
    const page = getRecordInitialMessagePage(activeConversation, conversationId)
    if (page) {
      return page
    }
  }

  for (const [, conversations] of queryClient.getQueriesData<unknown>({
    queryKey: COMMANDER_CONVERSATIONS_QUERY_KEY,
  })) {
    if (!Array.isArray(conversations)) {
      continue
    }
    const cachedConversations = conversations as ConversationRecord[]
    const page = cachedConversations
      .map((conversation) => getRecordInitialMessagePage(conversation, conversationId))
      .find(Boolean)
    if (page) {
      return page
    }
  }

  for (const [, projection] of queryClient.getQueriesData<CommanderConversationBootstrapProjection>({
    queryKey: COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY,
  })) {
    if (!isCommanderConversationBootstrapProjection(projection)) {
      continue
    }
    const selectedPage = getRecordInitialMessagePage(projection.selectedConversation, conversationId)
    if (selectedPage) {
      return selectedPage
    }
    const activePage = getRecordInitialMessagePage(projection.activeConversation, conversationId)
    if (activePage) {
      return activePage
    }
    const listPage = projection.conversations
      .map((conversation) => getRecordInitialMessagePage(conversation, conversationId))
      .find(Boolean)
    if (listPage) {
      return listPage
    }
  }

  return undefined
}

function toConversationMessagesInfiniteData(
  page: ConversationMessagesPage,
): ConversationMessagesInfiniteData {
  return {
    pages: [page],
    pageParams: [null],
  }
}

interface UseConversationsOptions {
  clientPushConnected?: boolean | null
}

export function useConversations(
  commanderId?: string | null,
  selectedConversationId?: string | null,
  options: UseConversationsOptions = {},
) {
  const safeCommanderId = typeof commanderId === 'string' && commanderId.trim().length > 0
    ? commanderId.trim()
    : null
  const safeSelectedConversationId =
    typeof selectedConversationId === 'string' && selectedConversationId.trim().length > 0
      ? selectedConversationId.trim()
      : null
  const explicitEmptySelection = selectedConversationId !== undefined && safeSelectedConversationId === null
  const queryClient = useQueryClient()

  const bootstrapQuery = useQuery({
    queryKey: safeCommanderId
      ? commanderConversationBootstrapQueryKey(safeCommanderId, safeSelectedConversationId)
      : [...COMMANDER_CONVERSATION_BOOTSTRAP_QUERY_KEY, 'none'],
    queryFn: () => fetchCommanderConversationBootstrap(safeCommanderId ?? '', safeSelectedConversationId),
    enabled: Boolean(safeCommanderId),
    staleTime: CONVERSATIONS_LIST_STALE_MS,
    refetchInterval: safeCommanderId
      ? (query) => conversationBootstrapRefetchInterval(query, options)
      : false,
  })
  const bootstrapProjection = isCommanderConversationBootstrapProjection(bootstrapQuery.data)
    ? bootstrapQuery.data
    : undefined

  useEffect(() => {
    if (bootstrapProjection) {
      applyCommanderConversationBootstrapProjection(queryClient, bootstrapProjection)
    }
  }, [bootstrapProjection, queryClient])

  const cachedConversations = safeCommanderId
    ? queryClient.getQueryData<ConversationRecord[]>(commanderConversationsQueryKey(safeCommanderId))
    : undefined
  const cachedConversationList = Array.isArray(cachedConversations) ? cachedConversations : undefined
  const conversations = useMemo(
    () => sortConversations(bootstrapProjection?.conversations ?? cachedConversationList ?? []),
    [bootstrapProjection?.conversations, cachedConversationList],
  )
  const selectedConversationFromList =
    conversations.find((conversation) => conversation.id === safeSelectedConversationId) ?? null
  const cachedSelectedConversation = safeSelectedConversationId
    ? queryClient.getQueryData<ConversationRecord>(conversationDetailQueryKey(safeSelectedConversationId))
    : null
  const selectedConversation = explicitEmptySelection
    ? null
    : selectConversationCandidate(
        bootstrapProjection?.selectedConversation ?? cachedSelectedConversation,
        selectedConversationFromList,
      )

  return {
    conversations,
    selectedConversation,
    isLoading: bootstrapQuery.isLoading,
    isFetching: bootstrapQuery.isFetching,
    error: bootstrapQuery.error ?? null,
    refetch: async () => {
      await bootstrapQuery.refetch()
    },
  }
}

export function useConversationMessages(
  conversationId?: string | null,
  enabled = true,
) {
  const queryClient = useQueryClient()
  const safeConversationId = typeof conversationId === 'string' && conversationId.trim().length > 0
    ? conversationId.trim()
    : null

  return useInfiniteQuery({
    queryKey: safeConversationId
      ? conversationMessagesQueryKey(safeConversationId)
      : [...CONVERSATION_MESSAGES_QUERY_KEY, 'none'],
    queryFn: ({ pageParam }) => fetchConversationMessagesPage({
      conversationId: safeConversationId ?? '',
      before: pageParam as string | null,
      limit: CONVERSATION_MESSAGES_PAGE_SIZE,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    enabled: Boolean(safeConversationId) && enabled,
    initialData: () => {
      if (!safeConversationId) {
        return undefined
      }
      const initialMessagePage = getInitialConversationMessagePage(queryClient, safeConversationId)
      return initialMessagePage
        ? toConversationMessagesInfiniteData(initialMessagePage)
        : undefined
    },
    staleTime: 5_000,
  })
}

export function useConversationMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: postConversationMessage,
    onSuccess: ({ conversation, messagePage }) => {
      updateConversationCaches(queryClient, conversation, { messagePage })
    },
  })
}

export function useCreateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: postCreateConversation,
    onSuccess: (conversation) => {
      updateConversationCaches(queryClient, conversation)
    },
  })
}

export function useStartConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: postStartConversation,
    onSuccess: (conversation) => {
      updateConversationCaches(queryClient, conversation)
    },
  })
}

export function useStopConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: postStopConversation,
    onSuccess: (conversation) => {
      updateConversationCaches(queryClient, conversation)
    },
  })
}

export function useUpdateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: patchConversation,
    onSuccess: (conversation) => {
      updateConversationCaches(queryClient, conversation)
    },
  })
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteConversation,
    onSuccess: (payload) => {
      removeConversationCaches(queryClient, payload)
    },
  })
}
