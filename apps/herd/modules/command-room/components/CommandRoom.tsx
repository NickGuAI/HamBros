/**
 * Herd — Command Room Assembly.
 *
 * Three-column layout: SessionsColumn (232px) | CenterColumn | right panel.
 * Manages shared state: selected commander, active right panel, selected worker, and workspace column.
 *
 * ┌──────────┬────────────────────────────┬──────────────┐
 * │ Sessions │       Center Column        │ Right Panel  │
 * │  (232px) │                            │ 232px / wide │
 * │          │                            │              │
 * │ Cmdrs    │  ┌──────────────────────┐  │ Quests/Auto  │
 * │ Chats    │  │  Chat / Placeholder  │  │ Identity     │
 * │ Teams    │  │  Chat / Placeholder  │  │              │
 * │ nested   │  └──────────────────────┘  │  Optional    │
 * │          │  [Composer]                │              │
 * └──────────┴────────────────────────────┴──────────────┘
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createSession,
  getDebriefStatus,
  killSession,
  resumeSession as resumeAgentSession,
  triggerPreKillDebrief,
  useAgentSessions,
  useMachines,
} from '@/hooks/use-agents'
import { usePendingApprovals } from '@/hooks/use-approvals'
import { useAgentSessionStream } from '@/hooks/use-agent-session-stream'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { createHttpConversationDispatcher } from '@/hooks/send-dispatcher'
import { useTheme } from '@/lib/theme-context'
import { fetchJson } from '@/lib/api'
import {
  buildTouchedReasoningPayload,
  findProviderEntry,
  getProviderControlDefaults,
  resolveDefaultProviderId,
  useProviderRegistry,
  type ProviderReasoningTouched,
} from '@/hooks/use-providers'
import {
  findModuleGraphUiRouteMetadata,
  resolveModuleGraphWebSocketPath,
} from '@/module-graph-bindings'
import { useModuleGraphContext } from '@/module-graph-context'
import { ModalFormContainer } from '@modules/components/ModalFormContainer'
import { workerLifecycleWithRuntimeState } from '@modules/agents/session-lifecycle'
import type {
  AgentSession,
  AgentType,
  SessionCreator,
  SessionQueueSnapshot,
  SessionTransportType,
} from '@/types'
import { AddWorkerWizard } from '@modules/agents/components/AddWorkerWizard'
import { NewSessionForm } from '@modules/agents/components/NewSessionForm'
import type { AgentEffortLevel } from '@modules/agents/effort.js'
import type { ClaudeAdaptiveThinkingMode } from '@modules/claude-adaptive-thinking.js'
import type { ClaudeMaxThinkingTokens } from '@modules/claude-max-thinking-tokens.js'
import {
  formatError,
  isNotFoundRequestFailure,
  shouldAttemptDebriefOnKill,
} from '@modules/agents/page-shell/session-helpers'
import { Toast } from '@modules/components/Toast'
import { runQueueMutationRequest } from '@modules/agents/queue-mutation'
import {
  clearSessionQueue,
  fetchSessionQueueSnapshot,
  queueSessionMessage,
  removeQueuedSessionMessage,
  reorderSessionQueue,
} from '@modules/agents/session-queue-api'
import {
  EMPTY_QUEUE_SNAPSHOT,
  normalizeQueueSnapshot,
} from '@modules/agents/queue-state'
import {
  GLOBAL_COMMANDER_ID,
  isGlobalCommanderId,
  useCommander,
  type CommanderSession,
} from '@modules/commanders/hooks/useCommander'
import {
  normalizeCommandRoomGlobalSearchParams,
  normalizeCommandRoomRouteMetadata,
} from '@modules/command-room/route-metadata'
import {
  ACTIVE_CONVERSATION_FETCH_STALE_MS,
  applyCommanderConversationBootstrapProjection,
  commanderActiveConversationQueryKey,
  commanderConversationBootstrapQueryKey,
  fetchCommanderConversationBootstrap,
  useCreateConversation,
  useDeleteConversation,
  useConversationMessages,
  useConversationMessage,
  useConversations,
  useStartConversation,
  useStopConversation,
  useUpdateConversation,
  type ConversationAction,
  type ConversationRecord,
  type ConversationRuntimeSettingsUpdate,
} from '@modules/conversation/hooks/use-conversations'
import type { CreateConversationReasoningConfig } from '@modules/conversation/components/CreateConversationPanel'
import { CreateCommanderWizard } from '@modules/commanders/components/CreateCommanderWizard'
import { SessionsColumn } from './desktop/SessionsColumn'
import type { ChatSession } from './desktop/SessionsColumn'
import type { Commander, Worker, Approval } from './desktop/SessionRow'
import { CenterColumn } from './desktop/CenterColumn'
import type { HervaldCommander } from './desktop/CenterColumn'
import { AutomationPanel } from '@modules/commanders/components/AutomationPanel'
import { CommanderIdentityTab } from '@modules/commanders/components/CommanderIdentityTab'
import { QuestBoard } from '@modules/commanders/components/QuestBoard'
import { WorkspacePanel } from '@modules/workspace/components/WorkspacePanel'
import {
  fetchWorkspacePathResolution,
  getWorkspaceSourceKey,
  isWorkspaceTargetNotFoundError,
  openWorkspaceTarget,
  type WorkspacePendingFileAnnotation,
  type WorkspaceSource,
  type WorkspaceSourceRecovery,
} from '@modules/workspace/use-workspace'
import type { WorkspaceContextPayload, WorkspaceTreeNode } from '@modules/workspace/types'
import type {
  SessionComposerContextAttachments,
  SessionComposerSubmitPayload,
} from '@modules/agents/components/SessionComposer'
import {
  appendQueuedMessagesToTranscript,
  createPendingConversationMessage,
  hasPendingConversationMessages,
  mapSessionMessagesToTranscript,
  mergeConversationLiveTranscript,
  mergeConversationTranscriptSources,
  pruneConfirmedPendingConversationMessages,
  type PendingConversationMessage,
} from './transcript'
import { MobileCommandRoom } from './mobile/MobileCommandRoom'

const SIDE_COLUMN_WIDTH = 232
const WORKSPACE_EXPANDED_WIDTH = 520
const CENTER_COLUMN_MIN_WIDTH = 340

const gridStyleBase: CSSProperties = {
  display: 'grid',
  width: '100%',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
}

const shellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100%',
  minWidth: '100%',
  overflow: 'hidden',
}

const COMMAND_ROOM_TABS = new Set(['chat', 'quests', 'automation', 'identity'])
const RIGHT_PANEL_TABS = [
  { id: 'chat', label: 'Workspace' },
  { id: 'quests', label: 'Quests' },
  { id: 'automation', label: 'Automations' },
  { id: 'identity', label: 'Identity' },
] as const
const SUMI_BUTTON_RADIUS = '2px 12px 2px 12px'
const WORKSPACE_OPEN_STORAGE_KEY = 'hervald.command-room.workspace-open'
type WorkspacePanelDefault = 'open' | 'closed' | 'last-used'
type WorkspaceTargetOrigin = 'auto' | 'manual'
type WorkspaceTargetState = {
  targetId: string
  label: string
  readOnly: boolean
}
type WorkspaceOwner = {
  key: string
  input: {
    conversationId?: string
    sessionName?: string
    commanderId?: string
  }
}
type WorkspaceTargetOpenOptions = {
  onlyIfCurrentTargetId?: string
}
type SessionGroup = 'workers' | 'automation'
const GLOBAL_COMMANDER_ROW: Commander = {
  id: GLOBAL_COMMANDER_ID,
  name: 'Global',
  status: 'idle',
  description: 'unattached automations',
  iconName: 'globe',
  isVirtual: true,
}

function mapCommanderSessionToCommander(commander: CommanderSession): Commander {
  return {
    id: commander.id,
    name: commander.displayName?.trim() || commander.host,
    archived: commander.archived === true,
    // Preserve the raw identity fields so <AgentAvatar /> can derive the
    // initial-letter fallback from the same source the row title uses.
    displayName: commander.displayName,
    host: commander.host,
    credentialSelectionModes: commander.credentialSelectionModes,
    status: commander.state,
    description: commander.currentTask?.title,
    // Wire the backend-supplied avatar route so every Commander surface
    // renders the same profile image without per-commander color identity.
    avatarUrl: commander.avatarUrl ?? null,
    ui: commander.ui ?? null,
  }
}

function resolvePanelTab(panel: string | null): string {
  if (panel === 'cron' || panel === 'automation') {
    return 'automation'
  }

  return panel && COMMAND_ROOM_TABS.has(panel) ? panel : 'chat'
}

function rightPanelActionsStyle(expanded: boolean): CSSProperties {
  return {
    display: expanded ? 'flex' : 'grid',
    gridTemplateColumns: expanded ? undefined : 'repeat(2, minmax(0, 1fr))',
    gap: expanded ? 10 : '10px 8px',
    padding: expanded ? '16px 18px 14px' : '14px 14px 12px',
    borderBottom: '1px solid var(--hv-border-hair)',
    overflowX: expanded ? 'auto' : 'visible',
    alignItems: 'stretch',
  }
}

function rightPanelButtonStyle(active: boolean, compact: boolean): CSSProperties {
  return {
    flex: compact ? '1 1 auto' : '0 0 auto',
    minWidth: 0,
    width: compact ? '100%' : undefined,
    minHeight: compact ? 38 : 42,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: active ? 'var(--hv-fg)' : 'var(--hv-border-firm)',
    borderRadius: SUMI_BUTTON_RADIUS,
    background: active ? 'var(--hv-fg)' : 'var(--hv-bg)',
    color: active ? 'var(--hv-fg-inverse)' : 'var(--hv-fg)',
    boxShadow: active ? 'var(--hv-shadow-block)' : '2px 2px 0 var(--hv-ink-wash-03)',
    padding: compact ? '9px 4px' : '10px 14px',
    fontSize: compact ? 10 : 11,
    letterSpacing: compact ? '0.06em' : '0.1em',
    lineHeight: 1.1,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    transition: 'background 160ms var(--hv-ease-gentle), color 160ms var(--hv-ease-gentle), box-shadow 160ms var(--hv-ease-gentle)',
  }
}

function workspaceHiddenOpenButtonStyle(): CSSProperties {
  return {
    marginTop: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--hv-border-firm)',
    borderRadius: SUMI_BUTTON_RADIUS,
    background: 'var(--hv-bg)',
    color: 'var(--hv-fg)',
    boxShadow: '2px 2px 0 var(--hv-ink-wash-03)',
  }
}

function formatQueueError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function resolveWorkspaceSource({
  targetId,
  label,
  readOnly,
}: {
  targetId?: string | null
  label?: string | null
  readOnly?: boolean
}): WorkspaceSource | null {
  if (targetId) {
    return {
      kind: 'target',
      targetId,
      label: label ?? undefined,
      readOnly,
    }
  }

  return null
}

function resolveSessionGroup(session: {
  name?: unknown
  sessionType?: unknown
  creator?: unknown
}): SessionGroup {
  if (
    session.sessionType === 'sentinel'
    || session.sessionType === 'cron'
    || session.sessionType === 'automation'
  ) {
    return 'automation'
  }

  const creator = resolveSessionCreator(session)
  if (
    creator?.kind === 'sentinel'
    || creator?.kind === 'cron'
    || creator?.kind === 'automation'
  ) {
    return 'automation'
  }
  return 'workers'
}

function formatSessionAge(lastActivityAt: unknown): string | undefined {
  if (typeof lastActivityAt !== 'string') {
    return undefined
  }

  const timestamp = Date.parse(lastActivityAt)
  if (Number.isNaN(timestamp)) {
    return undefined
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)
  if (elapsedMinutes < 60) {
    return `${Math.max(elapsedMinutes, 1)}m`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) {
    return `${elapsedHours}h`
  }

  return `${Math.floor(elapsedHours / 24)}d`
}

interface HervaldCommanderSession extends CommanderSession {
  name: string
  status: string
  description?: string
  contextConfig?: {
    fatPinInterval: number
  }
  runtime?: {
    heartbeatCount: number
  }
}

interface HervaldAgentSession extends AgentSession {
  id?: string
  lastActivityAt?: string
  parentCommanderId?: string | null
}

interface CommandRoomAutomationRecord {
  id: string
  name: string
  parentCommanderId?: string | null
}

function normalizeCommandRoomAutomationRecord(value: unknown): CommandRoomAutomationRecord | null {
  if (!isRecord(value)) {
    return null
  }
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || !name) {
    return null
  }
  const parentCommanderId = value.parentCommanderId === null
    ? null
    : typeof value.parentCommanderId === 'string' && value.parentCommanderId.trim()
      ? value.parentCommanderId.trim()
      : undefined
  return {
    id,
    name,
    ...(parentCommanderId !== undefined ? { parentCommanderId } : {}),
  }
}

async function fetchCommandRoomAutomations(): Promise<CommandRoomAutomationRecord[]> {
  const payload = await fetchJson<unknown>('/api/automations')
  if (!Array.isArray(payload)) {
    return []
  }
  return payload.flatMap((item) => {
    const automation = normalizeCommandRoomAutomationRecord(item)
    return automation ? [automation] : []
  })
}

function resolveSessionCreator(session: {
  creator?: unknown
}): SessionCreator | undefined {
  if (!isRecord(session.creator)) {
    return undefined
  }

  const kind = typeof session.creator.kind === 'string'
    ? session.creator.kind
    : null
  if (
    kind !== 'human'
    && kind !== 'commander'
    && kind !== 'cron'
    && kind !== 'sentinel'
    && kind !== 'automation'
  ) {
    return undefined
  }

  const id = typeof session.creator.id === 'string' && session.creator.id.trim().length > 0
    ? session.creator.id.trim()
    : undefined
  return id ? { kind, id } : { kind }
}

function resolveSessionParentCommanderId(session: {
  parentCommanderId?: unknown
}): string | null | undefined {
  if (session.parentCommanderId === null) {
    return null
  }
  if (typeof session.parentCommanderId !== 'string') {
    return undefined
  }
  const parentCommanderId = session.parentCommanderId.trim()
  return parentCommanderId ? parentCommanderId : null
}

function mapAgentSessionToChatSession(
  session: HervaldAgentSession,
  automationsById?: ReadonlyMap<string, CommandRoomAutomationRecord>,
): ChatSession {
  const spawnedBy = typeof session.spawnedBy === 'string'
    ? session.spawnedBy
    : null
  const processAlive = typeof session.processAlive === 'boolean'
    ? session.processAlive
    : undefined
  const sessionName = String(session.name || session.id || '')
  const creator = resolveSessionCreator(session)
  const automation = creator?.kind === 'automation' && creator.id
    ? automationsById?.get(creator.id)
    : undefined
  const sessionParentCommanderId = resolveSessionParentCommanderId(session)

  return {
    id: sessionName,
    name: sessionName,
    label: typeof session.label === 'string'
      ? session.label
      : automation?.name,
    created: typeof session.created === 'string' ? session.created : new Date(0).toISOString(),
    pid: typeof session.pid === 'number' ? session.pid : 0,
    age: formatSessionAge(session.lastActivityAt),
    state: session.state,
    status: typeof session.status === 'string' ? session.status : undefined,
    agentType: typeof session.agentType === 'string' ? session.agentType : undefined,
    sessionType: typeof session.sessionType === 'string' ? session.sessionType : undefined,
    transportType: session.transportType === 'pty' || session.transportType === 'stream'
      ? session.transportType
      : undefined,
    lastActivityAt: typeof session.lastActivityAt === 'string' ? session.lastActivityAt : undefined,
    cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
    host: typeof session.host === 'string' ? session.host : undefined,
    creator,
    parentCommanderId: automation ? (automation.parentCommanderId ?? null) : sessionParentCommanderId,
    spawnedBy: spawnedBy ?? undefined,
    spawnedWorkers: Array.isArray(session.spawnedWorkers)
      ? session.spawnedWorkers.filter((worker): worker is string => typeof worker === 'string')
      : undefined,
    workerSummary: session.workerSummary,
    processAlive,
    hadResult: typeof session.hadResult === 'boolean' ? session.hadResult : undefined,
    resumedFrom: typeof session.resumedFrom === 'string' ? session.resumedFrom : undefined,
    resumeAvailable: typeof session.resumeAvailable === 'boolean' ? session.resumeAvailable : undefined,
    queuedMessageCount: typeof session.queuedMessageCount === 'number'
      ? session.queuedMessageCount
      : undefined,
    credentialPoolId: typeof session.credentialPoolId === 'string' ? session.credentialPoolId : undefined,
    credentialPool: session.credentialPool,
    effort: session.effort,
    adaptiveThinking: session.adaptiveThinking,
    maxThinkingTokens: session.maxThinkingTokens,
  }
}

function conversationActionAllowed(
  conversation: ConversationRecord | null | undefined,
  action: ConversationAction,
): boolean {
  return conversation?.allowedActions?.[action] === true
}

function conversationDisabledReason(
  conversation: ConversationRecord | null | undefined,
  action: ConversationAction,
  fallback: string,
): string {
  return conversation?.displayState?.disabledReasons[action] ?? fallback
}

function conversationWebSocketReady(conversation: ConversationRecord | null | undefined): boolean {
  return conversation?.websocketReady === true || conversation?.displayState?.websocketReady === true
}

function mapConversationLiveSession(conversation: ConversationRecord | null): ChatSession | null {
  if (!conversationWebSocketReady(conversation) || !conversation?.liveSession || !conversation.sendTarget) {
    return null
  }

  return mapAgentSessionToChatSession({
    ...(conversation.liveSession as HervaldAgentSession),
    name: conversation.sendTarget.sessionName,
    id: conversation.sendTarget.sessionName,
  })
}

export function CommandRoom() {
  return <CommandRoomContent />
}

function CommandRoomContent() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isMobile = useIsMobile()
  const commanderState = useCommander()
  const queryClient = useQueryClient()
  const moduleGraph = useModuleGraphContext()
  const commandRoomRouteMetadata = useMemo(
    () => normalizeCommandRoomRouteMetadata(
      findModuleGraphUiRouteMetadata(moduleGraph, 'command-room.ui'),
    ),
    [moduleGraph],
  )
  // Downstream chrome (sheets, overlays, quick theme toggles) works with a
  // binary light/dark, so pass the resolved theme; `system` resolution lives
  // in the theme context.
  const { resolvedTheme: theme, setTheme } = useTheme()
  const { data: rawAgentSessions = [], refetch: refetchAgentSessions } = useAgentSessions()
  const { data: pendingApprovals = [] } = usePendingApprovals()
  const { data: machines } = useMachines()
  const { data: providers = [], defaultProviderId } = useProviderRegistry()
  const initialProviderControls = getProviderControlDefaults(null)
  const { launch: commandRoomLaunch, globalCommander: globalCommanderRoute } = commandRoomRouteMetadata
  const panelParam = searchParams.get(globalCommanderRoute.panelParam)
  const commanderParam = searchParams.get(commandRoomLaunch.commanderParam)
  const normalizedCommanderParam = commanderParam === globalCommanderRoute.commanderValue
    ? GLOBAL_COMMANDER_ID
    : commanderParam
  const normalizedConversationParam = searchParams.get(commandRoomLaunch.conversationParam)?.trim() || null
  const searchParamsString = searchParams.toString()

  /* ---- Live data ---- */
  const [selectedChatSessionId, setSelectedChatSessionId] = useState<string | null>(null)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [requestedNewChatCommanderId, setRequestedNewChatCommanderId] = useState<string | null>(null)
  const [conversationLoadError, setConversationLoadError] = useState<unknown>(null)
  const [conversationClientPushState, setConversationClientPushState] = useState<{
    commanderId: string
    conversationId: string
    connected: boolean
  } | null>(null)
  const [queueSnapshot, setQueueSnapshot] = useState<SessionQueueSnapshot>(EMPTY_QUEUE_SNAPSHOT)
  const [pendingConversationMessages, setPendingConversationMessages] = useState<PendingConversationMessage[]>([])
  const [queueError, setQueueError] = useState<string | null>(null)
  const [isQueueMutating, setIsQueueMutating] = useState(false)

  /* ---- Shared state ---- */
  const activeTab = resolvePanelTab(panelParam)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const appliedWorkspaceDefaultRef = useRef<string | null>(null)
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTargetState | null>(null)
  const [workspaceRequestedPath, setWorkspaceRequestedPath] = useState<{
    path: string
    token: number
  } | null>(null)
  const [contextFilePaths, setContextFilePaths] = useState<string[]>([])
  const [contextDirectoryPaths, setContextDirectoryPaths] = useState<string[]>([])
  const [contextFileAnnotations, setContextFileAnnotations] = useState<WorkspacePendingFileAnnotation[]>([])
  const commanderSelectionRequestRef = useRef(0)
  const manualConversationSelectionRef = useRef(0)
  const selectedCommanderIdRef = useRef('')
  const workspaceTargetRef = useRef<WorkspaceTargetState | null>(null)
  const workspaceOwnerRef = useRef<WorkspaceOwner | null>(null)
  const workspaceOwnerKeyRef = useRef<string | null>(null)
  const workspaceTargetVersionRef = useRef(0)
  const workspaceTargetOriginRef = useRef<{
    ownerKey: string | null
    origin: WorkspaceTargetOrigin
  } | null>(null)
  const workspaceFileOpenRequestRef = useRef(0)
  const [showCreateCommanderForm, setShowCreateCommanderForm] = useState(false)
  const [showCreateSessionForm, setShowCreateSessionForm] = useState(false)
  const [showAddWorkerForm, setShowAddWorkerForm] = useState(false)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState('')
  const [sessionCwd, setSessionCwd] = useState('')
  const [sessionTask, setSessionTask] = useState('')
  const [sessionEffort, setSessionEffort] = useState<AgentEffortLevel>(initialProviderControls.effort)
  const [sessionAdaptiveThinking, setSessionAdaptiveThinking] = useState<ClaudeAdaptiveThinkingMode>(
    initialProviderControls.adaptiveThinking,
  )
  const [sessionMaxThinkingTokens, setSessionMaxThinkingTokens] = useState<ClaudeMaxThinkingTokens>(
    initialProviderControls.maxThinkingTokens,
  )
  const [sessionReasoningTouched, setSessionReasoningTouched] = useState<ProviderReasoningTouched>({})
  const [sessionAgentType, setSessionAgentType] = useState<AgentType>('')
  const [sessionTransportType, setSessionTransportType] =
    useState<Exclude<SessionTransportType, 'external'>>(initialProviderControls.transportType)
  const [sessionSelectedMachineId, setSessionSelectedMachineId] = useState('')
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [createSessionError, setCreateSessionError] = useState<string | null>(null)

  /* ---- Derived ---- */
  const machineList = machines ?? []
  const defaultSessionAgentType = resolveDefaultProviderId(
    providers,
    defaultProviderId,
    { predicate: (provider) => provider.capabilities?.supportsWorkerDispatch === true },
  )
  const sessionProvider = findProviderEntry(
    providers.filter((provider) => provider.capabilities?.supportsWorkerDispatch === true),
    sessionAgentType,
  )
  const selectedCommanderId = commanderState.selectedCommanderId ?? ''
  const selectedCommander = commanderState.selectedCommander as HervaldCommanderSession | null
  const setCommanderSelection = commanderState.setSelectedCommanderId
  const isGlobalScope = !selectedChatSessionId && isGlobalCommanderId(selectedCommanderId)
  const agentSessions = rawAgentSessions as HervaldAgentSession[]
  useEffect(() => {
    if (!defaultSessionAgentType) {
      return
    }
    if (!providers.some((provider) => (
      provider.id === sessionAgentType && provider.capabilities?.supportsWorkerDispatch === true
    ))) {
      setSessionAgentType(defaultSessionAgentType)
    }
  }, [defaultSessionAgentType, providers, sessionAgentType])

  useEffect(() => {
    if (!sessionProvider) {
      return
    }
    const defaults = getProviderControlDefaults(sessionProvider)
    setSessionTransportType(defaults.transportType)
    setSessionEffort(defaults.effort)
    setSessionAdaptiveThinking(defaults.adaptiveThinking)
    setSessionMaxThinkingTokens(defaults.maxThinkingTokens)
    setSessionReasoningTouched({})
  }, [sessionProvider])

  useEffect(() => {
    selectedCommanderIdRef.current = selectedCommanderId
  }, [selectedCommanderId])
  const requiresAutomationOwnershipJoin = useMemo(
    () => agentSessions.some((session) => {
      const creator = resolveSessionCreator(session)
      return creator?.kind === 'automation' && Boolean(creator.id)
    }),
    [agentSessions],
  )
  const automationDefinitionsQuery = useQuery({
    queryKey: ['automations', 'command-room', 'ownership'],
    queryFn: fetchCommandRoomAutomations,
    enabled: requiresAutomationOwnershipJoin,
    staleTime: 30_000,
    retry: false,
  })
  const automationDefinitionsById = useMemo(
    () => new Map(
      (automationDefinitionsQuery.data ?? []).map((automation) => [automation.id, automation] as const),
    ),
    [automationDefinitionsQuery.data],
  )
  const urlCommanderIsKnown = Boolean(
    normalizedCommanderParam === GLOBAL_COMMANDER_ID
      || (
        normalizedCommanderParam
        && commanderState.commanders.some((commander) => commander.id === normalizedCommanderParam)
      ),
  )
  const urlCommanderSelectionPending = Boolean(
    normalizedCommanderParam
      && (
        commanderState.commandersLoading
        || (urlCommanderIsKnown && normalizedCommanderParam !== selectedCommanderId)
      ),
  )
  const urlConversationSelectionPending = Boolean(
    normalizedConversationParam
      && normalizedCommanderParam === selectedCommanderId
      && normalizedConversationParam !== selectedConversationId,
  )
  const urlSelectionPending = urlCommanderSelectionPending || urlConversationSelectionPending
  const conversationListCommanderScope = normalizedCommanderParam
    && !isGlobalCommanderId(normalizedCommanderParam)
    && urlCommanderIsKnown
    ? normalizedCommanderParam
    : selectedCommanderId && !isGlobalCommanderId(selectedCommanderId)
      ? selectedCommanderId
      : null
  let conversationClientPushConnected: boolean | null = null
  if (conversationClientPushState?.commanderId === conversationListCommanderScope) {
    conversationClientPushConnected = selectedConversationId
      && conversationClientPushState.conversationId !== selectedConversationId
      ? null
      : conversationClientPushState.connected
  }
  const {
    conversations,
    selectedConversation: selectedConversationRecord,
    isLoading: conversationsLoading,
    error: conversationsError,
    refetch: refetchConversations,
  } = useConversations(
    conversationListCommanderScope,
    urlSelectionPending ? null : selectedConversationId,
    { clientPushConnected: conversationClientPushConnected },
  )
  // Per issue 1878: the mobile chat shell mounts keyed on the commander URL
  // param; while the client has no cached knowledge of the commander list or
  // this commander's conversations, the shell renders header + composer +
  // transcript skeleton instead of a blank section or a create-chat flash.
  const conversationResolutionPending = Boolean(
    normalizedCommanderParam
    && !isGlobalCommanderId(normalizedCommanderParam)
    && (commanderState.commandersLoading || conversationsLoading),
  )
  const conversationFetchError = conversationsError
    ? formatError(conversationsError, 'Failed to load conversations')
    : null
  const conversationBootstrapError = conversationLoadError
    ? formatError(conversationLoadError, 'Failed to load active conversation')
    : null
  const conversationErrorMessage = conversationBootstrapError ?? conversationFetchError
  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => conversation.isDefaultConversation !== true),
    [conversations],
  )
  // Per issue 1362 contract: selection is driven by explicit user actions (clicks)
  // and one-shot deep-link hydration. Never by a passive polling hook. The
  // synthetic-default conversation is filtered here so a stale URL pointing
  // at one renders the Create panel instead of a fake selected chat shell.
  const selectedConversation = selectedConversationRecord?.isDefaultConversation === true
    ? null
    : selectedConversationRecord
  const createConversation = useCreateConversation()
  const startConversation = useStartConversation()
  const stopConversation = useStopConversation()
  const updateConversation = useUpdateConversation()
  const deleteConversation = useDeleteConversation()
  const conversationMessageMutation = useConversationMessage()
  const {
    workers,
    workerSessions,
    automationSessions,
  } = useMemo(() => {
    const nextWorkers: Worker[] = []
    const nextWorkerSessions: ChatSession[] = []
    const nextAutomationSessions: ChatSession[] = []

    for (const session of agentSessions) {
      if (!isRecord(session)) {
        continue
      }

      const spawnedBy = typeof session.spawnedBy === 'string'
        ? session.spawnedBy
        : null
      const creator = resolveSessionCreator(session)
      const semanticSessionType = typeof session.sessionType === 'string'
        ? session.sessionType
        : null
      const processAlive = typeof session.processAlive === 'boolean'
        ? session.processAlive
        : undefined
      const lifecycle = workerLifecycleWithRuntimeState({
        state: session.state,
        status: typeof session.status === 'string' ? session.status : undefined,
        processAlive,
      })
      const sessionName = String(session.name || session.id || '')
      const nextSession = mapAgentSessionToChatSession(session, automationDefinitionsById)

      if (creator?.kind === 'commander') {
        nextWorkers.push({
          id: sessionName,
          name: sessionName,
          label: typeof session.label === 'string' ? session.label : semanticSessionType ?? 'worker',
          kind: semanticSessionType ?? 'worker',
          state: lifecycle,
          creator,
          commanderId: creator.id,
          processAlive,
          resumeAvailable: typeof session.resumeAvailable === 'boolean' ? session.resumeAvailable : undefined,
        })
      }

      if (semanticSessionType === 'commander') {
        continue
      }

      const group = resolveSessionGroup(session)
      if (group === 'automation') {
        nextAutomationSessions.push(nextSession)
      } else {
        nextWorkerSessions.push(nextSession)
      }
    }

    return {
      workers: nextWorkers,
      workerSessions: nextWorkerSessions,
      automationSessions: nextAutomationSessions,
    }
  }, [agentSessions, automationDefinitionsById])
  const approvals = useMemo(() => pendingApprovals.flatMap((approval) => {
    if (!isRecord(approval)) {
      return []
    }

    const rawWorkerId = typeof approval.raw.workerId === 'string'
      ? approval.raw.workerId
      : null
    const contextWorkerId = approval.context && typeof approval.context.workerId === 'string'
      ? approval.context.workerId
      : null

    return [{
      id: approval.id,
      commanderId: approval.commanderId ?? '',
      conversationId: approval.conversationId,
      sessionName: approval.sessionName,
      workerId: rawWorkerId ?? contextWorkerId ?? approval.sessionName ?? '',
      action: approval.actionLabel,
    }]
  }) as Approval[], [pendingApprovals])
  const availableSessions = useMemo(
    () => [...workerSessions, ...automationSessions],
    [automationSessions, workerSessions],
  )
  const selectedStandaloneSession = availableSessions.find((session) => session.id === selectedChatSessionId) ?? null
  const selectedConversationSession = mapConversationLiveSession(selectedConversation)
  const conversationSelectionSettling = urlSelectionPending
    || Boolean(selectedConversationId && !selectedConversationRecord)
  const activeStandaloneSession = selectedStandaloneSession
  const activeConversationSession = selectedConversationSession
  const activeChatSession = activeStandaloneSession ?? activeConversationSession
  const workspaceOwner = useMemo<WorkspaceOwner | null>(() => {
    const standaloneSessionName = activeStandaloneSession?.id ?? null
    const fallbackCommanderId = !isGlobalScope && selectedCommanderId ? selectedCommanderId : null
    if (selectedConversationId) {
      return {
        key: `conversation:${selectedConversationId}`,
        input: { conversationId: selectedConversationId },
      }
    }
    if (standaloneSessionName) {
      return {
        key: `session:${standaloneSessionName}`,
        input: { sessionName: standaloneSessionName },
      }
    }
    if (fallbackCommanderId) {
      return {
        key: `commander:${fallbackCommanderId}`,
        input: { commanderId: fallbackCommanderId },
      }
    }
    return null
  }, [activeStandaloneSession?.id, isGlobalScope, selectedCommanderId, selectedConversationId])
  const selectedConversationWebSocketReady = conversationWebSocketReady(selectedConversation)
  const streamSessionName = activeStandaloneSession?.id
    ?? (!conversationSelectionSettling ? selectedConversationSession?.name : undefined)
  const streamWebSocketPath = useMemo(() => {
    if (activeStandaloneSession || !selectedConversationWebSocketReady || !selectedConversation) {
      return undefined
    }

    return resolveModuleGraphWebSocketPath(
      moduleGraph,
      'conversation.session-stream',
      { id: selectedConversation.id },
    ) ?? undefined
  }, [activeStandaloneSession, moduleGraph, selectedConversation, selectedConversationWebSocketReady])
  const composerSessionName = selectedConversation
    ? (selectedConversation.sendTarget?.sessionName ?? activeStandaloneSession?.id ?? streamSessionName ?? 'hervald-command-room')
    : (activeStandaloneSession?.id ?? streamSessionName ?? 'hervald-command-room')
  const workspaceSource = resolveWorkspaceSource({
    targetId: workspaceTarget?.targetId,
    label: workspaceTarget?.label,
    readOnly: workspaceTarget?.readOnly,
  })
  const workspacePreferencesQuery = useQuery({
    queryKey: ['workspace', 'preferences'],
    queryFn: () => fetchJson<{ panelDefault: WorkspacePanelDefault }>('/api/workspace/preferences'),
    enabled: Boolean(workspaceTarget?.targetId),
  })
  const workspacePanelDefault = workspacePreferencesQuery.data?.panelDefault ?? 'last-used'
  const workspaceSelectionKey = useMemo(
    () => workspaceSource ? getWorkspaceSourceKey(workspaceSource) : `none:${composerSessionName}`,
    [composerSessionName, workspaceSource],
  )
  const rightColumnWidth = workspaceOpen ? WORKSPACE_EXPANDED_WIDTH : SIDE_COLUMN_WIDTH
  const gridStyle = useMemo<CSSProperties>(() => ({
    ...gridStyleBase,
    gridTemplateColumns: isGlobalScope
      ? `${SIDE_COLUMN_WIDTH}px minmax(${CENTER_COLUMN_MIN_WIDTH}px, 1fr)`
      : `${SIDE_COLUMN_WIDTH}px minmax(${CENTER_COLUMN_MIN_WIDTH}px, 1fr) ${rightColumnWidth}px`,
    minWidth: isGlobalScope
      ? SIDE_COLUMN_WIDTH + CENTER_COLUMN_MIN_WIDTH
      : SIDE_COLUMN_WIDTH + CENTER_COLUMN_MIN_WIDTH + rightColumnWidth,
  }), [isGlobalScope, rightColumnWidth])
  const activeChatIsStream = activeChatSession ? activeChatSession.transportType !== 'pty' : true
  const selectedConversationRunning = activeStandaloneSession
    ? activeChatIsStream && activeStandaloneSession.processAlive !== false
    : conversationSelectionSettling
    ? false
    : Boolean(
        selectedConversation
        && selectedConversationSession
        && selectedConversationWebSocketReady
        && selectedConversation.sendTarget?.transportType !== 'pty',
      )
  const canQueueDraft = activeStandaloneSession
    ? activeChatIsStream
    : selectedConversation
      ? conversationActionAllowed(selectedConversation, 'queue')
      : false
  const showCommanderRuntimeControls = !activeStandaloneSession && !selectedConversation
  const {
    messages: sessionMessages,
    sendDispatcher: streamSendDispatcher,
    pushOptimisticUserMessage,
    answerQuestion,
    isStreaming,
    status: streamStatus,
  } = useAgentSessionStream(streamSessionName, {
    enabled: selectedConversationRunning,
    websocketPath: streamWebSocketPath,
    onQueueUpdate: setQueueSnapshot,
  })
  useEffect(() => {
    const nextState = selectedConversation && !activeStandaloneSession && selectedConversationRunning
      ? {
          commanderId: selectedConversation.commanderId,
          conversationId: selectedConversation.id,
          connected: streamStatus === 'connected',
        }
      : null
    setConversationClientPushState((current) => {
      if (
        current?.commanderId === nextState?.commanderId
        && current?.conversationId === nextState?.conversationId
        && current?.connected === nextState?.connected
      ) {
        return current
      }
      return nextState
    })
  }, [
    activeStandaloneSession,
    selectedConversation,
    selectedConversationRunning,
    streamStatus,
  ])
  const conversationMessagesQuery = useConversationMessages(
    selectedConversation?.id ?? null,
    Boolean(selectedConversation),
  )
  // The backend read model owns send/queue/media policy. Idle conversations may
  // allow normal text send because POST /message can auto-start them; queue and
  // media still require a live stream.
  const conversationCanSend = conversationActionAllowed(selectedConversation, 'send')
  const conversationCanSendMedia = conversationActionAllowed(selectedConversation, 'media')
  const composerEnabled = isGlobalScope
    ? false
    : activeStandaloneSession
      ? streamStatus === 'connected' && activeChatIsStream && activeStandaloneSession.processAlive !== false
      : selectedConversation
        ? conversationCanSend || conversationCanSendMedia
        : false
  const composerSendReady = selectedConversation
    ? conversationCanSend || conversationCanSendMedia
    : activeStandaloneSession
      ? streamStatus === 'connected'
      : false
  const conversationComposerDisabledMessage = selectedConversation && !conversationCanSend && !conversationCanSendMedia
    ? conversationDisabledReason(
      selectedConversation,
      'send',
      'Start or resume the conversation before sending messages.',
    )
    : undefined
  const liveTranscript = mapSessionMessagesToTranscript(sessionMessages)
  const historicalConversationMessages = useMemo(() => {
    const pages = conversationMessagesQuery.data?.pages ?? []
    return [...pages]
      .reverse()
      .flatMap((page) => page.messages)
  }, [conversationMessagesQuery.data?.pages])
  const selectedConversationIdForTranscript = selectedConversation?.id ?? null
  const selectedConversationHasLiveTranscript = Boolean(
    selectedConversationIdForTranscript && liveTranscript.length > 0,
  )
  const selectedConversationConfirmedTranscript = useMemo(() => (
    selectedConversation
      ? mergeConversationLiveTranscript(historicalConversationMessages, liveTranscript)
      : liveTranscript
  ), [historicalConversationMessages, liveTranscript, selectedConversation])
  const selectedConversationHasPendingMessages = selectedConversation
    ? hasPendingConversationMessages(
        selectedConversationConfirmedTranscript,
        pendingConversationMessages,
        selectedConversationIdForTranscript,
      )
    : false
  useEffect(() => {
    if (!selectedConversationIdForTranscript) {
      return
    }

    setPendingConversationMessages((previous) => {
      const next = pruneConfirmedPendingConversationMessages(
        previous,
        selectedConversationConfirmedTranscript,
        selectedConversationIdForTranscript,
      )
      return next.length === previous.length ? previous : next
    })
  }, [selectedConversationConfirmedTranscript, selectedConversationIdForTranscript])
  const selectedConversationShouldPollTranscript = Boolean(
    selectedConversationIdForTranscript
    && !selectedConversationHasLiveTranscript
    && (selectedConversationHasPendingMessages || isStreaming),
  )
  useEffect(() => {
    if (!selectedConversationShouldPollTranscript) {
      return undefined
    }

    void conversationMessagesQuery.refetch()
    const interval = window.setInterval(() => {
      void conversationMessagesQuery.refetch()
    }, 1000)
    return () => {
      window.clearInterval(interval)
    }
  }, [
    conversationMessagesQuery.refetch,
    isStreaming,
    selectedConversationHasPendingMessages,
    selectedConversationShouldPollTranscript,
  ])
  const transcript = selectedConversation
    ? mergeConversationTranscriptSources({
        canonicalMessages: historicalConversationMessages,
        liveMessages: liveTranscript,
        pendingMessages: pendingConversationMessages,
        conversationId: selectedConversationIdForTranscript,
      })
    : liveTranscript
  const chatTranscript = appendQueuedMessagesToTranscript(transcript, queueSnapshot)
  const hasOlderConversationMessages = Boolean(
    selectedConversation && conversationMessagesQuery.hasNextPage,
  )
  const loadingOlderConversationMessages = conversationMessagesQuery.isFetchingNextPage
  const handleLoadOlderConversationMessages = useCallback(() => {
    if (!hasOlderConversationMessages || loadingOlderConversationMessages) {
      return
    }
    void conversationMessagesQuery.fetchNextPage()
  }, [
    conversationMessagesQuery,
    hasOlderConversationMessages,
    loadingOlderConversationMessages,
  ])
  const commanderIdentities = useMemo(
    () => commanderState.commanders.map(mapCommanderSessionToCommander),
    [commanderState.commanders],
  )
  const sessionCommanders: Commander[] = useMemo(() => [
    GLOBAL_COMMANDER_ROW,
    ...commanderIdentities.filter((commander) => commander.archived !== true),
  ], [commanderIdentities])
  const mobileCommanders = useMemo(
    () => sessionCommanders.filter((commander) => !commander.isVirtual),
    [sessionCommanders],
  )
  const selectedCommanderRunning = selectedCommander?.state === 'running'
  const handleActiveTabChange = useCallback((nextTab: string) => {
    const resolvedTab = resolvePanelTab(nextTab)
    const desiredPanel = resolvedTab === 'chat' ? null : resolvedTab
    if (panelParam === desiredPanel) {
      return
    }

    const nextParams = new URLSearchParams(searchParamsString)
    if (desiredPanel) {
      nextParams.set(globalCommanderRoute.panelParam, desiredPanel)
    } else {
      nextParams.delete(globalCommanderRoute.panelParam)
    }
    setSearchParams(nextParams, { replace: true })
  }, [globalCommanderRoute.panelParam, panelParam, searchParamsString, setSearchParams])

  const handleSelectCommanderId = useCallback(async (commanderId: string) => {
    // Per issue 1362 contract: selection still comes from explicit clicks and a
    // single backend active-chat lookup. The visible commander switch commits
    // first; the lookup applies later only if this click is still current.
    setRequestedNewChatCommanderId(null)
    setSelectedChatSessionId(null)
    setConversationLoadError(null)
    const requestId = commanderSelectionRequestRef.current + 1
    commanderSelectionRequestRef.current = requestId
    const manualSelectionVersion = manualConversationSelectionRef.current

    const isGlobal = commanderId === GLOBAL_COMMANDER_ID
    const activeQueryKey = commanderActiveConversationQueryKey(commanderId)
    const activeQueryState = !isGlobal
      ? queryClient.getQueryState<ConversationRecord | null>(activeQueryKey)
      : undefined
    const cachedActiveChatId = activeQueryState?.data?.id ?? null
    const hasCachedActiveChat = Boolean(activeQueryState?.dataUpdatedAt)

    const nextParams = new URLSearchParams(searchParamsString)
    nextParams.set(
      commandRoomLaunch.commanderParam,
      isGlobal ? globalCommanderRoute.commanderValue : commanderId,
    )
    if (isGlobal) {
      nextParams.set(globalCommanderRoute.panelParam, globalCommanderRoute.defaultPanel)
    } else {
      nextParams.delete(globalCommanderRoute.panelParam)
    }
    if (cachedActiveChatId) {
      nextParams.set(commandRoomLaunch.conversationParam, cachedActiveChatId)
    } else if (nextParams.has(commandRoomLaunch.conversationParam)) {
      nextParams.delete(commandRoomLaunch.conversationParam)
    }
    setSearchParams(nextParams, { replace: true })

    setSelectedConversationId(cachedActiveChatId)
    selectedCommanderIdRef.current = commanderId
    setCommanderSelection(commanderId)

    if (isGlobal || hasCachedActiveChat) {
      return
    }

    void queryClient.fetchQuery({
      queryKey: commanderConversationBootstrapQueryKey(commanderId),
      queryFn: () => fetchCommanderConversationBootstrap(commanderId),
      staleTime: ACTIVE_CONVERSATION_FETCH_STALE_MS,
    }).then((projection) => {
      applyCommanderConversationBootstrapProjection(queryClient, projection)
      if (
        commanderSelectionRequestRef.current !== requestId
        || manualConversationSelectionRef.current !== manualSelectionVersion
        || selectedCommanderIdRef.current !== commanderId
      ) {
        return
      }

      const activeChatId = projection.selectedConversation?.id ?? projection.activeConversation?.id ?? null
      setConversationLoadError(null)
      const currentParams = new URLSearchParams(window.location.search)
      currentParams.set(commandRoomLaunch.commanderParam, commanderId)
      currentParams.delete(globalCommanderRoute.panelParam)
      if (activeChatId) {
        currentParams.set(commandRoomLaunch.conversationParam, activeChatId)
      } else {
        currentParams.delete(commandRoomLaunch.conversationParam)
      }
      setSearchParams(currentParams, { replace: true })
      setSelectedConversationId(activeChatId)
    }).catch((error) => {
      if (
        commanderSelectionRequestRef.current !== requestId
        || manualConversationSelectionRef.current !== manualSelectionVersion
        || selectedCommanderIdRef.current !== commanderId
      ) {
        return
      }
      setConversationLoadError(error)
    })
  }, [
    commandRoomLaunch.commanderParam,
    commandRoomLaunch.conversationParam,
    globalCommanderRoute.commanderValue,
    globalCommanderRoute.defaultPanel,
    globalCommanderRoute.panelParam,
    queryClient,
    searchParamsString,
    setCommanderSelection,
    setSearchParams,
  ])

  const handleRetryConversationLoad = useCallback(() => {
    setConversationLoadError(null)
    void refetchConversations()
    if (selectedCommanderId && !isGlobalCommanderId(selectedCommanderId)) {
      void handleSelectCommanderId(selectedCommanderId)
    }
  }, [handleSelectCommanderId, refetchConversations, selectedCommanderId])

  const handleSelectConversationId = useCallback((
    conversationId: string,
    commanderId = selectedCommanderId,
  ) => {
    setConversationLoadError(null)
    manualConversationSelectionRef.current += 1
    setRequestedNewChatCommanderId(null)
    setSelectedConversationId(conversationId)
    setSelectedChatSessionId(null)

    const nextParams = new URLSearchParams(searchParamsString)
    if (commanderId && !isGlobalCommanderId(commanderId)) {
      nextParams.set(commandRoomLaunch.commanderParam, commanderId)
    }
    nextParams.set(commandRoomLaunch.conversationParam, conversationId)
    nextParams.delete(globalCommanderRoute.panelParam)
    setSearchParams(nextParams, { replace: true })
  }, [
    commandRoomLaunch.commanderParam,
    commandRoomLaunch.conversationParam,
    globalCommanderRoute.panelParam,
    searchParamsString,
    selectedCommanderId,
    setSearchParams,
  ])

  const handleClearConversationSelection = useCallback((
    commanderId = selectedCommanderId,
  ) => {
    manualConversationSelectionRef.current += 1
    setRequestedNewChatCommanderId(null)
    setSelectedConversationId(null)
    setSelectedChatSessionId(null)

    const nextParams = new URLSearchParams(searchParamsString)
    if (commanderId && !isGlobalCommanderId(commanderId)) {
      nextParams.set(commandRoomLaunch.commanderParam, commanderId)
    }
    nextParams.delete(commandRoomLaunch.conversationParam)
    nextParams.delete(globalCommanderRoute.panelParam)
    setSearchParams(nextParams, { replace: true })
  }, [
    commandRoomLaunch.commanderParam,
    commandRoomLaunch.conversationParam,
    globalCommanderRoute.panelParam,
    searchParamsString,
    selectedCommanderId,
    setSearchParams,
  ])

  const handleSelectStandaloneChat = useCallback((chatSessionId: string) => {
    setRequestedNewChatCommanderId(null)
    setSelectedChatSessionId(chatSessionId)
    setSelectedConversationId(null)

    if (isMobile) {
      return
    }

    const nextParams = new URLSearchParams(searchParamsString)
    nextParams.delete(commandRoomLaunch.conversationParam)
    nextParams.delete(globalCommanderRoute.panelParam)
    setSearchParams(nextParams, { replace: true })
  }, [
    commandRoomLaunch.conversationParam,
    globalCommanderRoute.panelParam,
    isMobile,
    searchParamsString,
    setSearchParams,
  ])

  const refreshSessions = useCallback(async () => {
    await refetchAgentSessions()
  }, [refetchAgentSessions])

  const setWorkspaceOpenPreference = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setWorkspaceOpen((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      try {
        window.localStorage.setItem(WORKSPACE_OPEN_STORAGE_KEY, resolved ? 'open' : 'closed')
      } catch {
        // Storage can be unavailable in embedded/webview contexts.
      }
      return resolved
    })
  }, [])

  const adoptWorkspaceTarget = useCallback((
    target: WorkspaceTargetState | null,
    origin: WorkspaceTargetOrigin,
    ownerKey: string | null,
  ) => {
    workspaceTargetVersionRef.current += 1
    workspaceTargetRef.current = target
    workspaceTargetOriginRef.current = target
      ? { ownerKey, origin }
      : null
    setWorkspaceTarget(target)
  }, [])

  const openCurrentWorkspaceOwnerTarget = useCallback(async (
    origin: WorkspaceTargetOrigin = 'auto',
    options: WorkspaceTargetOpenOptions = {},
  ): Promise<WorkspaceTargetState | null> => {
    const currentOwner = workspaceOwnerRef.current
    const owner = currentOwner?.key === workspaceOwner?.key
      ? currentOwner
      : workspaceOwner
    if (!owner) {
      adoptWorkspaceTarget(null, origin, null)
      return null
    }
    const ownerKeyAtStart = owner.key
    const targetVersionAtStart = workspaceTargetVersionRef.current
    const openedTarget = await openWorkspaceTarget(owner.input)
    if (workspaceOwnerKeyRef.current !== ownerKeyAtStart) {
      return null
    }
    const currentTargetAfterOpen = workspaceTargetRef.current
    if (options.onlyIfCurrentTargetId) {
      if (currentTargetAfterOpen?.targetId !== options.onlyIfCurrentTargetId) {
        return null
      }
    } else if (workspaceTargetVersionRef.current !== targetVersionAtStart) {
      return workspaceTargetRef.current
    }
    const nextTarget = {
      targetId: openedTarget.targetId,
      label: openedTarget.label,
      readOnly: openedTarget.readOnly,
    }
    adoptWorkspaceTarget(nextTarget, origin, owner.key)
    return nextTarget
  }, [adoptWorkspaceTarget, workspaceOwner])

  const recoverStaleWorkspaceTarget = useCallback<WorkspaceSourceRecovery>(async (staleSource) => {
    const currentTarget = workspaceTargetRef.current
    if (!currentTarget || currentTarget.targetId !== staleSource.targetId) {
      return null
    }
    const recoveredTarget = await openCurrentWorkspaceOwnerTarget('auto', {
      onlyIfCurrentTargetId: staleSource.targetId,
    })
    return recoveredTarget
      ? {
          kind: 'target',
          targetId: recoveredTarget.targetId,
          label: recoveredTarget.label,
          readOnly: recoveredTarget.readOnly,
        }
      : null
  }, [openCurrentWorkspaceOwnerTarget])

  useEffect(() => {
    workspaceTargetRef.current = workspaceTarget
  }, [workspaceTarget])

  useEffect(() => {
    workspaceOwnerRef.current = workspaceOwner
  }, [workspaceOwner])

  useEffect(() => {
    const nextOwnerKey = workspaceOwner?.key ?? null
    if (workspaceOwnerKeyRef.current === nextOwnerKey) {
      return
    }
    workspaceOwnerKeyRef.current = nextOwnerKey
    workspaceTargetVersionRef.current += 1
    workspaceTargetOriginRef.current = null
    workspaceTargetRef.current = null
    setWorkspaceTarget(null)
    setWorkspaceRequestedPath(null)
  }, [workspaceOwner?.key])

  const handleAddWorkspaceContextPath = useCallback((contextPath: string, type: WorkspaceTreeNode['type'] = 'file') => {
    const normalizedPath = contextPath.trim().replace(/\/+$/u, '')
    if (!normalizedPath) {
      return
    }
    if (type === 'directory') {
      setContextDirectoryPaths((current) => (
        current.includes(normalizedPath) ? current : [...current, normalizedPath]
      ))
      return
    }
    setContextFilePaths((current) => (
      current.includes(normalizedPath) ? current : [...current, normalizedPath]
    ))
  }, [])

  const handleAddContextFileAnnotation = useCallback((annotation: WorkspacePendingFileAnnotation) => {
    setContextFileAnnotations((current) => (
      current.some((entry) => entry.id === annotation.id) ? current : [...current, annotation]
    ))
  }, [])

  const handleOpenWorkspaceFilePath = useCallback(async (filePath: string) => {
    const trimmedPath = filePath.trim()
    if (!trimmedPath) {
      return
    }
    const requestId = workspaceFileOpenRequestRef.current + 1
    workspaceFileOpenRequestRef.current = requestId
    const ownerKeyAtStart = workspaceOwner?.key ?? null
    const isCurrentRequest = () => (
      workspaceFileOpenRequestRef.current === requestId
      && workspaceOwnerKeyRef.current === ownerKeyAtStart
    )

    handleActiveTabChange('chat')
    setWorkspaceOpenPreference(true)

    let target = workspaceTargetRef.current
    if (!target?.targetId) {
      if (!workspaceOwner) {
        setWorkspaceRequestedPath({
          path: trimmedPath,
          token: requestId,
        })
        return
      }

      try {
        target = await openCurrentWorkspaceOwnerTarget('auto')
        if (!isCurrentRequest()) {
          return
        }
      } catch {
        if (!isCurrentRequest()) {
          return
        }
        adoptWorkspaceTarget(null, 'auto', workspaceOwner.key)
        setWorkspaceRequestedPath({
          path: trimmedPath,
          token: requestId,
        })
        return
      }
    }

    if (!target?.targetId) {
      if (!isCurrentRequest()) {
        return
      }
      setWorkspaceRequestedPath({
        path: trimmedPath,
        token: requestId,
      })
      return
    }

    try {
      let resolutionTarget = target
      let resolvedPath
      try {
        resolvedPath = await fetchWorkspacePathResolution({
          kind: 'target',
          targetId: resolutionTarget.targetId,
          label: resolutionTarget.label,
          readOnly: resolutionTarget.readOnly,
        }, trimmedPath)
      } catch (error) {
        if (!isWorkspaceTargetNotFoundError(error)) {
          throw error
        }
        const recoveredTarget = await openCurrentWorkspaceOwnerTarget('auto')
        if (!isCurrentRequest()) {
          return
        }
        if (!recoveredTarget) {
          throw error
        }
        resolutionTarget = recoveredTarget
        resolvedPath = await fetchWorkspacePathResolution({
          kind: 'target',
          targetId: recoveredTarget.targetId,
          label: recoveredTarget.label,
          readOnly: recoveredTarget.readOnly,
        }, trimmedPath)
      }
      if (!isCurrentRequest()) {
        return
      }
      const resolvedTarget = resolvedPath.targetId
        ? {
            targetId: resolvedPath.targetId,
            label: resolvedPath.targetLabel ?? resolutionTarget.label,
            readOnly: resolvedPath.targetReadOnly ?? resolutionTarget.readOnly,
          }
        : resolutionTarget
      if (resolvedPath.targetId) {
        adoptWorkspaceTarget(resolvedTarget, 'manual', workspaceOwner?.key ?? null)
      }
      setWorkspaceRequestedPath({
        path: resolvedPath.path,
        token: requestId,
      })
      return
    } catch {
      if (!isCurrentRequest()) {
        return
      }
      setWorkspaceRequestedPath({
        path: trimmedPath,
        token: requestId,
      })
    }
  }, [
    adoptWorkspaceTarget,
    handleActiveTabChange,
    openCurrentWorkspaceOwnerTarget,
    setWorkspaceOpenPreference,
    workspaceOwner,
  ])

  const handleWorkspaceRequestedPathConsumed = useCallback((token: number) => {
    setWorkspaceRequestedPath((current) => (
      current?.token === token ? null : current
    ))
  }, [])

  const handleRemoveContextFilePath = useCallback((filePath: string) => {
    setContextFilePaths((current) => current.filter((entry) => entry !== filePath))
  }, [])

  const handleRemoveContextDirectoryPath = useCallback((directoryPath: string) => {
    setContextDirectoryPaths((current) => current.filter((entry) => entry !== directoryPath))
  }, [])

  const handleRemoveContextFileAnnotation = useCallback((annotationId: string) => {
    setContextFileAnnotations((current) => current.filter((entry) => entry.id !== annotationId))
  }, [])

  const handleClearContextFilePaths = useCallback(() => {
    setContextFilePaths([])
    setContextDirectoryPaths([])
    setContextFileAnnotations([])
  }, [])

  const handleRestoreContextAttachments = useCallback((context: SessionComposerContextAttachments) => {
    setContextFilePaths(context.filePaths)
    setContextDirectoryPaths(context.directoryPaths)
    setContextFileAnnotations(context.fileAnnotations)
  }, [])

  useEffect(() => {
    if (!commanderParam) {
      return
    }
    if (normalizedCommanderParam !== GLOBAL_COMMANDER_ID) {
      return
    }
    if (isGlobalScope && activeTab !== globalCommanderRoute.defaultPanel) {
      handleActiveTabChange(globalCommanderRoute.defaultPanel)
    }
  }, [
    activeTab,
    commanderParam,
    globalCommanderRoute.defaultPanel,
    handleActiveTabChange,
    isGlobalScope,
    normalizedCommanderParam,
  ])

  useEffect(() => {
    if (!normalizedCommanderParam) {
      return
    }

    if (!urlCommanderIsKnown) {
      return
    }

    if (normalizedCommanderParam === selectedCommanderId) {
      if (normalizedConversationParam !== selectedConversationId) {
        setSelectedChatSessionId(null)
        setSelectedConversationId(
          isGlobalCommanderId(normalizedCommanderParam)
            ? null
            : normalizedConversationParam,
        )
      }
      return
    }

    setSelectedChatSessionId(null)
    setSelectedConversationId(
      isGlobalCommanderId(normalizedCommanderParam)
        ? null
        : normalizedConversationParam,
    )
    setCommanderSelection(normalizedCommanderParam)
  }, [
    normalizedCommanderParam,
    normalizedConversationParam,
    selectedCommanderId,
    selectedConversationId,
    setCommanderSelection,
    urlCommanderIsKnown,
  ])

  useEffect(() => {
    setContextFilePaths([])
    setContextDirectoryPaths([])
    setContextFileAnnotations([])
  }, [workspaceSelectionKey])

  useEffect(() => {
    let cancelled = false
    const owner = workspaceOwner
    if (!owner) {
      adoptWorkspaceTarget(null, 'auto', null)
      return
    }
    const targetVersionAtStart = workspaceTargetVersionRef.current

    void (async () => {
      try {
        const target = await openWorkspaceTarget(owner.input)
        if (cancelled || workspaceOwnerKeyRef.current !== owner.key) {
          return
        }
        const currentOrigin = workspaceTargetOriginRef.current
        if (currentOrigin?.origin === 'manual' && currentOrigin.ownerKey === owner.key) {
          return
        }
        if (workspaceTargetVersionRef.current !== targetVersionAtStart) {
          return
        }
        adoptWorkspaceTarget({
          targetId: target.targetId,
          label: target.label,
          readOnly: target.readOnly,
        }, 'auto', owner.key)
      } catch {
        if (!cancelled && workspaceOwnerKeyRef.current === owner.key) {
          const currentOrigin = workspaceTargetOriginRef.current
          if (currentOrigin?.origin !== 'manual') {
            adoptWorkspaceTarget(null, 'auto', owner.key)
          }
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [adoptWorkspaceTarget, workspaceOwner])

  useEffect(() => {
    if (!workspaceSource) {
      appliedWorkspaceDefaultRef.current = null
      setWorkspaceOpen(false)
      return
    }

    const defaultKey = `${workspaceSelectionKey}:${workspacePanelDefault}`
    if (appliedWorkspaceDefaultRef.current === defaultKey) {
      return
    }
    appliedWorkspaceDefaultRef.current = defaultKey

    if (workspacePanelDefault === 'open') {
      setWorkspaceOpen(true)
      return
    }
    if (workspacePanelDefault === 'closed') {
      setWorkspaceOpen(false)
      return
    }

    try {
      setWorkspaceOpen(window.localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY) === 'open')
    } catch {
      setWorkspaceOpen(false)
    }
  }, [workspacePanelDefault, workspaceSelectionKey, workspaceSource])

  useEffect(() => {
    if (selectedChatSessionId && !availableSessions.some((session) => session.id === selectedChatSessionId)) {
      setSelectedChatSessionId(null)
    }
  }, [availableSessions, selectedChatSessionId])

  useLayoutEffect(() => {
    if (location.pathname !== commandRoomLaunch.path) {
      return
    }

    if (commanderParam) {
      return
    }

    const nextParams = normalizeCommandRoomGlobalSearchParams(
      new URLSearchParams(searchParamsString),
      commandRoomRouteMetadata,
    )
    setSearchParams(nextParams, { replace: true })
    setSelectedChatSessionId(null)
    setSelectedConversationId(null)
    setCommanderSelection(GLOBAL_COMMANDER_ID)
  }, [
    commanderParam,
    commandRoomLaunch.path,
    commandRoomRouteMetadata,
    location.pathname,
    searchParamsString,
    setCommanderSelection,
    setSearchParams,
  ])

  // Deep-link hydration: when the URL arrives with a commander param but no
  // conversation param on a commander launch route, do exactly one
  // backend lookup per commander id transition and then write ?conversation=
  // atomically. This is the ONLY autonomous selection write — clicks go
  // through handleSelectCommanderId. Guarded by a ref so dep churn (poll
  // refresh of conversations list, commander list, etc.) cannot re-fire it.
  const deepLinkFetchedForCommanderRef = useRef<string | null>(null)
  useEffect(() => {
    if (!normalizedCommanderParam) {
      return
    }
    if (isGlobalCommanderId(normalizedCommanderParam)) {
      return
    }
    if (normalizedConversationParam) {
      return
    }
    if (requestedNewChatCommanderId === normalizedCommanderParam) {
      return
    }
    if (!urlCommanderIsKnown) {
      return
    }
    if (deepLinkFetchedForCommanderRef.current === normalizedCommanderParam) {
      return
    }

    deepLinkFetchedForCommanderRef.current = normalizedCommanderParam
    const targetCommander = normalizedCommanderParam

    // Per issue 1878: apply the resolved conversation only while the user is
    // still viewing this commander-only launch URL. This preserves the
    // still-viewing guard that used to live in the org CheckOnHero second
    // rail (pathname + commander match + no manual conversation selection).
    const applyResolvedConversation = (activeChatId: string) => {
      if (window.location.pathname !== commandRoomLaunch.path) {
        return
      }
      const liveSearch = new URLSearchParams(window.location.search)
      if (liveSearch.get(commandRoomLaunch.commanderParam) !== targetCommander) {
        return
      }
      if (liveSearch.get(commandRoomLaunch.conversationParam)) {
        return
      }

      liveSearch.set(commandRoomLaunch.conversationParam, activeChatId)
      setSearchParams(liveSearch, { replace: true })
      setSelectedConversationId(activeChatId)
    }

    // Cache-first rail (issue 1878): external commander-only arrivals resolve
    // from the same cached active-chat projection in-room clicks use
    // (handleSelectCommanderId). When the client already knows the answer the
    // conversation param is written synchronously with zero fetches — even a
    // cached "no active chat" skips the network round-trip.
    const activeQueryState = queryClient.getQueryState<ConversationRecord | null>(
      commanderActiveConversationQueryKey(targetCommander),
    )
    if (activeQueryState?.dataUpdatedAt) {
      const cachedActiveChatId = activeQueryState.data?.id ?? null
      if (cachedActiveChatId) {
        applyResolvedConversation(cachedActiveChatId)
      }
      return
    }

    void (async () => {
      let activeChatId: string | null = null
      try {
        const projection = await queryClient.fetchQuery({
          queryKey: commanderConversationBootstrapQueryKey(targetCommander),
          queryFn: () => fetchCommanderConversationBootstrap(targetCommander),
          staleTime: ACTIVE_CONVERSATION_FETCH_STALE_MS,
        })
        applyCommanderConversationBootstrapProjection(queryClient, projection)
        activeChatId = projection.selectedConversation?.id ?? projection.activeConversation?.id ?? null
      } catch (error) {
        setConversationLoadError(error)
        return
      }

      if (!activeChatId) {
        return
      }
      setConversationLoadError(null)

      // Bail if the user navigated again while we were fetching.
      applyResolvedConversation(activeChatId)
    })()
  }, [
    normalizedCommanderParam,
    normalizedConversationParam,
    commandRoomLaunch.commanderParam,
    commandRoomLaunch.conversationParam,
    commandRoomLaunch.path,
    queryClient,
    requestedNewChatCommanderId,
    setSearchParams,
    urlCommanderIsKnown,
  ])

  /* ---- Workspace modal keyboard shortcut ---- */
  const handleWorkspaceKey = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && workspaceSource) {
        e.preventDefault()
        handleActiveTabChange('chat')
        setWorkspaceOpenPreference((prev) => activeTab === 'chat' ? !prev : true)
      }
    },
    [activeTab, handleActiveTabChange, setWorkspaceOpenPreference, workspaceSource],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleWorkspaceKey)
    return () => document.removeEventListener('keydown', handleWorkspaceKey)
  }, [handleWorkspaceKey])

  const handleKillSession = useCallback(async (
    sessionName: string,
    agentType?: AgentType,
    selectedSessionType?: SessionTransportType,
  ) => {
    setSessionActionError(null)

    try {
      const isStream = selectedSessionType === 'stream'
      const shouldDebrief = isStream && shouldAttemptDebriefOnKill(agentType)

      if (shouldDebrief) {
        try {
          const preResp = await triggerPreKillDebrief(sessionName)
          if (preResp.debriefStarted && preResp.timeoutMs) {
            const deadline = Date.now() + preResp.timeoutMs
            const pollIntervalMs = 2000
            while (Date.now() < deadline) {
              const { status } = await getDebriefStatus(sessionName)
              if (status === 'completed' || status === 'timed-out') {
                break
              }
              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
            }
          }
        } catch (caughtError) {
          if (!isNotFoundRequestFailure(caughtError)) {
            throw caughtError
          }
        }
      }

      await killSession(sessionName)
      setSelectedChatSessionId((current) => (current === sessionName ? null : current))
      await refreshSessions()
    } catch (caughtError) {
      const message = formatError(caughtError, 'Failed to kill session')
      setSessionActionError(message)
      throw caughtError
    }
  }, [refreshSessions])

  const handleResumeSession = useCallback(async (sessionName: string) => {
    setSessionActionError(null)

    try {
      const resumed = await resumeAgentSession(sessionName)
      handleSelectStandaloneChat(resumed.name)
      await refreshSessions()
    } catch (caughtError) {
      const message = formatError(caughtError, 'Failed to resume session')
      setSessionActionError(message)
      throw caughtError
    }
  }, [handleSelectStandaloneChat, refreshSessions])

  const fetchQueueSnapshot = useCallback(async (): Promise<SessionQueueSnapshot> => {
    if (!streamSessionName) {
      return EMPTY_QUEUE_SNAPSHOT
    }

    const nextQueue = await fetchSessionQueueSnapshot(streamSessionName)
    return normalizeQueueSnapshot(nextQueue)
  }, [streamSessionName])

  const refreshQueueSnapshot = useCallback(async (): Promise<void> => {
    if (!streamSessionName || !canQueueDraft || !selectedConversationRunning) {
      setQueueSnapshot(EMPTY_QUEUE_SNAPSHOT)
      return
    }

    try {
      setQueueSnapshot(await fetchQueueSnapshot())
      setQueueError(null)
    } catch (error) {
      setQueueError(formatQueueError(error, 'Failed to load message queue'))
      throw error
    }
  }, [canQueueDraft, fetchQueueSnapshot, selectedConversationRunning, streamSessionName])

  useEffect(() => {
    let cancelled = false
    setQueueError(null)

    if (!streamSessionName || !canQueueDraft || !selectedConversationRunning) {
      setQueueSnapshot(EMPTY_QUEUE_SNAPSHOT)
      return
    }

    void (async () => {
      try {
        const nextQueue = await fetchQueueSnapshot()
        if (!cancelled) {
          setQueueSnapshot(nextQueue)
        }
      } catch (error) {
        if (!cancelled) {
          setQueueError(formatQueueError(error, 'Failed to load message queue'))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [canQueueDraft, fetchQueueSnapshot, selectedConversationRunning, streamSessionName])

  /* ---- Build CenterColumn commander shape ---- */
  const centerCommander: HervaldCommander = activeStandaloneSession
    ? {
        id: '',
        name: activeStandaloneSession.label ?? activeStandaloneSession.name,
        status: activeStandaloneSession.status ?? 'active',
        description: activeStandaloneSession.transportType === 'pty'
          ? 'interactive terminal session'
          : 'standalone chat session',
        agentType: activeStandaloneSession.agentType,
      }
    : isGlobalScope
      ? {
          id: '',
          name: 'Global',
          status: 'idle',
          description: 'unattached automations',
        }
    : selectedCommander
      ? {
          ...selectedCommander,
          id: selectedCommander.id,
          name: selectedCommander.displayName?.trim() || selectedCommander.host,
          status: selectedConversation
            ? selectedConversation.status
            : 'idle',
          description: selectedConversation?.currentTask?.title
            ?? selectedCommander.currentTask?.title,
          cost: selectedConversation?.totalCostUsd ?? selectedCommander.totalCostUsd,
          agentType: selectedConversationSession?.agentType ?? selectedCommander.agentType,
        }
      : { id: '', name: 'No commander', status: 'offline' }

  /* ---- Workers for the selected commander ---- */
  const commanderWorkers = workers.filter(
    (worker) => (
      worker.creator?.kind === 'commander'
      && worker.creator.id?.trim() === selectedCommanderId.trim()
    ),
  )
  const commanderAutomationSessions = automationSessions.filter(
    (session) => session.parentCommanderId === selectedCommanderId.trim(),
  )
  const submitConversationMessage = useCallback(async ({
    message,
    images,
    clientSendId,
    workspaceContext,
    queue = false,
  }: {
    message: string
    images?: Array<{ mediaType: string; data: string }>
    clientSendId?: string
    workspaceContext?: WorkspaceContextPayload
    queue?: boolean
  }): Promise<boolean> => {
    if (!selectedConversation) {
      return false
    }

    setSessionActionError(null)

    try {
      const response = await conversationMessageMutation.mutateAsync({
        conversationId: selectedConversation.id,
        message,
        images,
        clientSendId,
        workspaceContext,
        queue,
      })
      return response.accepted
    } catch (caughtError) {
      setSessionActionError(
        formatError(
          caughtError,
          queue ? 'Failed to queue conversation message' : 'Failed to send conversation message',
        ),
      )
      return false
    }
  }, [conversationMessageMutation, selectedConversation])
  const conversationSendDispatcher = useMemo(
    () => createHttpConversationDispatcher({ submitConversationMessage }),
    [submitConversationMessage],
  )
  const paintPendingConversationMessage = useCallback((
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    clientSendId?: string,
  ) => {
    const pendingMessage = createPendingConversationMessage({
      conversationId: selectedConversation?.id,
      text,
      images,
      clientSendId,
      timestamp: new Date().toISOString(),
    })
    if (!pendingMessage) {
      return
    }

    setPendingConversationMessages((previous) => {
      const existingIndex = previous.findIndex((message) => (
        message.conversationId === pendingMessage.conversationId
        && message.clientSendId === pendingMessage.clientSendId
      ))
      if (existingIndex === -1) {
        return [...previous, pendingMessage]
      }

      const next = [...previous]
      next[existingIndex] = pendingMessage
      return next
    })
  }, [selectedConversation?.id])
  const removePendingConversationMessage = useCallback((
    conversationId?: string | null,
    clientSendId?: string,
  ) => {
    const safeConversationId = conversationId?.trim()
    const safeClientSendId = clientSendId?.trim()
    if (!safeConversationId || !safeClientSendId) {
      return
    }

    setPendingConversationMessages((previous) => previous.filter((message) => (
      message.conversationId !== safeConversationId
      || message.clientSendId !== safeClientSendId
    )))
  }, [])

  const applyQueueMutation = useCallback(async (
    request: () => Promise<unknown>,
    mutationErrorFallback: string,
    refreshErrorFallback: string,
  ): Promise<boolean> => {
    if (!streamSessionName || !canQueueDraft) {
      return false
    }

    setIsQueueMutating(true)
    setQueueError(null)

    try {
      return await runQueueMutationRequest(request, refreshQueueSnapshot, {
        onMutationError: (error) => {
          setQueueError(formatQueueError(error, mutationErrorFallback))
        },
        onRefreshError: (error) => {
          setQueueError(formatQueueError(error, refreshErrorFallback))
        },
      })
    } finally {
      setIsQueueMutating(false)
    }
  }, [canQueueDraft, refreshQueueSnapshot, streamSessionName])

  const buildWorkspaceContextPayload = useCallback((
    payload: SessionComposerSubmitPayload,
  ): WorkspaceContextPayload | undefined => {
    const context = payload.context
    const hasContext = Boolean(
      context?.filePaths?.length
      || context?.directoryPaths?.length
      || context?.fileAnnotations?.length,
    )
    if (!hasContext) {
      return undefined
    }
    return {
      ...(workspaceSource?.targetId ? { targetId: workspaceSource.targetId } : {}),
      ...(selectedConversationId ? { conversationId: selectedConversationId } : {}),
      ...(context?.filePaths?.length ? { filePaths: context.filePaths } : {}),
      ...(context?.directoryPaths?.length ? { directoryPaths: context.directoryPaths } : {}),
      ...(context?.fileAnnotations?.length ? { fileAnnotations: context.fileAnnotations } : {}),
    }
  }, [selectedConversationId, workspaceSource?.targetId])

  const handleSend = useCallback((payload: SessionComposerSubmitPayload): boolean | Promise<boolean> => {
    const trimmed = payload.text.trim()
    const workspaceContext = buildWorkspaceContextPayload(payload)
    const { images } = payload
    const attachedImages = images && images.length > 0 ? images : undefined
    if (!trimmed && !attachedImages && !workspaceContext) {
      return false
    }
    if (selectedConversation && attachedImages?.length && !conversationActionAllowed(selectedConversation, 'media')) {
      setSessionActionError(
        conversationDisabledReason(
          selectedConversation,
          'media',
          'Start or resume the conversation before sending images.',
        ),
      )
      return false
    }
    if (selectedConversation && !attachedImages?.length && !conversationActionAllowed(selectedConversation, 'send')) {
      setSessionActionError(
        conversationDisabledReason(
          selectedConversation,
          'send',
          'Start or resume the conversation before sending messages.',
        ),
      )
      return false
    }
    if (!selectedConversation) {
      if (!streamSessionName) {
        return false
      }
    }

    const sendInput = {
      text: trimmed,
      images: attachedImages,
      clientSendId: payload.clientSendId,
      workspaceContext,
    }

    if (selectedConversation) {
      const conversationId = selectedConversation.id
      const clientSendId = payload.clientSendId
      return conversationSendDispatcher
        .send(sendInput, paintPendingConversationMessage)
        .then((accepted) => {
          if (!accepted) {
            removePendingConversationMessage(conversationId, clientSendId)
          }
          return accepted
        }, (caughtError) => {
          removePendingConversationMessage(conversationId, clientSendId)
          throw caughtError
        })
    }

    return streamSendDispatcher.send(sendInput, pushOptimisticUserMessage)
  }, [
    buildWorkspaceContextPayload,
    conversationSendDispatcher,
    paintPendingConversationMessage,
    removePendingConversationMessage,
    selectedConversation,
    streamSessionName,
    streamSendDispatcher,
    pushOptimisticUserMessage,
  ])

  const handleQueue = useCallback(async (payload: SessionComposerSubmitPayload) => {
    const trimmed = payload.text.trim()
    const workspaceContext = buildWorkspaceContextPayload(payload)
    const { images } = payload
    const queuedImages = images && images.length > 0 ? images : undefined
    if (!trimmed && !queuedImages && !workspaceContext) {
      return
    }

    if (selectedConversation) {
      if (queuedImages?.length) {
        if (
          !conversationActionAllowed(selectedConversation, 'queue')
          || !conversationActionAllowed(selectedConversation, 'media')
        ) {
          setSessionActionError(
            conversationDisabledReason(
              selectedConversation,
              !conversationActionAllowed(selectedConversation, 'media') ? 'media' : 'queue',
              'Start or resume the conversation before queueing images.',
            ),
          )
          return
        }
      } else if (!trimmed && !workspaceContext) {
        return
      } else if (!conversationActionAllowed(selectedConversation, 'queue')) {
        setSessionActionError(
          conversationDisabledReason(
            selectedConversation,
            'queue',
            'Start or resume the conversation before queueing messages.',
          ),
        )
        return
      }
      if (await submitConversationMessage({
        message: trimmed,
        images: queuedImages,
        clientSendId: payload.clientSendId,
        workspaceContext,
        queue: true,
      })) {
        try {
          await refreshQueueSnapshot()
        } catch {
          // refreshQueueSnapshot already preserves the prior queue and records the user-visible error.
        }
      }
      return
    }

    if (!streamSessionName) {
      return
    }

    await applyQueueMutation(
      () => queueSessionMessage(streamSessionName, {
        text: trimmed,
        images: queuedImages,
        clientSendId: payload.clientSendId,
        workspaceContext,
      }),
      'Failed to queue message',
      'Queue updated, but failed to refresh queue',
    )
  }, [
    applyQueueMutation,
    buildWorkspaceContextPayload,
    refreshQueueSnapshot,
    selectedConversation,
    streamSessionName,
    submitConversationMessage,
  ])

  const handleStopCommander = useCallback(async () => {
    if (!selectedCommanderId || isGlobalScope) {
      return
    }

    await commanderState.stopCommander(selectedCommanderId)
  }, [commanderState, isGlobalScope, selectedCommanderId])

  const handleMoveQueuedMessage = useCallback(async (messageId: string, offset: number) => {
    if (!streamSessionName || !canQueueDraft) {
      return
    }

    const currentIndex = queueSnapshot.items.findIndex((message) => message.id === messageId)
    const nextIndex = currentIndex + offset
    if (currentIndex === -1 || nextIndex < 0 || nextIndex >= queueSnapshot.items.length) {
      return
    }

    const reordered = [...queueSnapshot.items]
    const [moved] = reordered.splice(currentIndex, 1)
    if (!moved) {
      return
    }
    reordered.splice(nextIndex, 0, moved)

    await applyQueueMutation(
      () => reorderSessionQueue(streamSessionName, reordered.map((message) => message.id)),
      'Failed to reorder queued messages',
      'Queue reordered, but failed to refresh queue',
    )
  }, [applyQueueMutation, canQueueDraft, queueSnapshot.items, streamSessionName])

  const handleRemoveQueuedMessage = useCallback(async (messageId: string) => {
    if (!streamSessionName || !canQueueDraft) {
      return
    }

    await applyQueueMutation(
      () => removeQueuedSessionMessage(streamSessionName, messageId),
      'Failed to remove queued message',
      'Queue updated, but failed to refresh queue',
    )
  }, [applyQueueMutation, canQueueDraft, streamSessionName])

  const handleClearQueue = useCallback(async () => {
    if (!streamSessionName || !canQueueDraft) {
      return
    }

    await applyQueueMutation(
      () => clearSessionQueue(streamSessionName),
      'Failed to clear queued messages',
      'Queue cleared, but failed to refresh queue',
    )
  }, [applyQueueMutation, canQueueDraft, streamSessionName])

  const handleOpenAddWorker = useCallback(() => {
    setShowAddWorkerForm(true)
  }, [])

  const handleOpenCreateSession = useCallback(() => {
    setCreateSessionError(null)
    setShowCreateSessionForm(true)
  }, [])

  const handleCreateChatForCommander = useCallback(async (
    commanderId: string,
    agentType?: AgentType,
    model?: string | null,
    reasoningConfig: CreateConversationReasoningConfig = {},
    credentialPoolId?: string,
  ) => {
    setSessionActionError(null)

    try {
      const created = await createConversation.mutateAsync({
        commanderId,
        surface: 'ui',
        ...(agentType ? { agentType } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(credentialPoolId ? { credentialPoolId } : {}),
        ...(reasoningConfig.effort !== undefined ? { effort: reasoningConfig.effort } : {}),
        ...(reasoningConfig.adaptiveThinking !== undefined
          ? { adaptiveThinking: reasoningConfig.adaptiveThinking }
          : {}),
        ...(reasoningConfig.maxThinkingTokens !== undefined
          ? { maxThinkingTokens: reasoningConfig.maxThinkingTokens }
          : {}),
      })
      // Per issue 1362 contract: creation is the explicit user action and never
      // auto-starts. We select the new (idle) conversation so the user sees
      // the dedicated chat surface, where the explicit Start affordance lives.
      handleSelectConversationId(created.id, created.commanderId)
      setRequestedNewChatCommanderId(null)
      return created
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to create chat'))
      return null
    }
  }, [createConversation, handleSelectConversationId])

  const handleRequestNewChatForCommander = useCallback((commanderId: string) => {
    // Per issue 1362 contract: + click does NOT auto-create. We keep the target
    // commander selected, clear the current chat selection, and let the shared
    // CreateConversationPanel collect the provider before any POST happens.
    setRequestedNewChatCommanderId(commanderId)
    setCommanderSelection(commanderId)
    setSelectedConversationId(null)
    setSelectedChatSessionId(null)

    const nextParams = new URLSearchParams(searchParamsString)
    nextParams.set(commandRoomLaunch.commanderParam, commanderId)
    nextParams.delete(commandRoomLaunch.conversationParam)
    nextParams.delete(globalCommanderRoute.panelParam)
    setSearchParams(nextParams, { replace: true })
  }, [
    commandRoomLaunch.commanderParam,
    commandRoomLaunch.conversationParam,
    globalCommanderRoute.panelParam,
    searchParamsString,
    setCommanderSelection,
    setSearchParams,
  ])

  const handleStartConversation = useCallback(async (conversationId: string) => {
    setSessionActionError(null)

    const conversation = conversations.find((entry) => entry.id === conversationId)
    const persistedAgentType = conversation?.agentType
    const targetAgentType = persistedAgentType ?? selectedCommander?.agentType

    try {
      const started = await startConversation.mutateAsync({
        conversationId,
        ...(targetAgentType ? { agentType: targetAgentType as AgentType } : {}),
        ...(typeof conversation?.model === 'string' ? { model: conversation.model } : {}),
      })
      handleSelectConversationId(started.id, started.commanderId)
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to start conversation'))
    }
  }, [conversations, handleSelectConversationId, selectedCommander?.agentType, startConversation])

  const handleStopConversation = useCallback(async (conversationId: string) => {
    setSessionActionError(null)

    try {
      await stopConversation.mutateAsync({ conversationId })
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to stop conversation'))
      throw error
    }
  }, [stopConversation])

  const handleRenameConversation = useCallback(async (conversationId: string, name: string) => {
    setSessionActionError(null)

    try {
      await updateConversation.mutateAsync({
        conversationId,
        name,
      })
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to rename conversation'))
      throw error
    }
  }, [updateConversation])

  const handleUpdateConversationRuntimeSettings = useCallback(async (
    conversationId: string,
    settings: ConversationRuntimeSettingsUpdate,
  ) => {
    setSessionActionError(null)

    try {
      const updated = await updateConversation.mutateAsync({
        conversationId,
        ...settings,
      })
      handleSelectConversationId(updated.id, updated.commanderId)
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to update conversation runtime settings'))
      throw error
    }
  }, [handleSelectConversationId, updateConversation])

  const handleArchiveConversation = useCallback(async (conversationId: string) => {
    setSessionActionError(null)

    try {
      await updateConversation.mutateAsync({
        conversationId,
        status: 'archived',
      })
      // Per issue 1362 contract: archive clears selection. The next render lets the
      // backend active-chat query pick the next active/idle chat (or return
      // null, which surfaces the Create Conversation panel). Re-selecting the
      // archived id here would render an archived chat shell.
      if (selectedConversationId === conversationId || normalizedConversationParam === conversationId) {
        handleClearConversationSelection()
      }
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to archive conversation'))
      throw error
    }
  }, [
    handleClearConversationSelection,
    normalizedConversationParam,
    selectedConversationId,
    updateConversation,
  ])

  const handleRemoveConversation = useCallback(async (conversationId: string) => {
    setSessionActionError(null)

    try {
      await deleteConversation.mutateAsync({
        conversationId,
        hard: true,
      })
      setSelectedChatSessionId((current) => current === conversationId ? null : current)
      if (selectedConversationId === conversationId || normalizedConversationParam === conversationId) {
        handleClearConversationSelection()
      } else {
        setSelectedConversationId((current) => current === conversationId ? null : current)
      }
    } catch (error) {
      setSessionActionError(formatError(error, 'Failed to remove conversation'))
      throw error
    }
  }, [
    deleteConversation,
    handleClearConversationSelection,
    normalizedConversationParam,
    selectedConversationId,
  ])

  const handleOpenCreateCommander = useCallback(() => {
    setShowCreateCommanderForm(true)
  }, [])

  const handleCloseAddWorker = useCallback(() => {
    setShowAddWorkerForm(false)
  }, [])

  const handleCloseCreateSession = useCallback(() => {
    setShowCreateSessionForm(false)
    setCreateSessionError(null)
  }, [])

  const handleCloseCreateCommander = useCallback(() => {
    setShowCreateCommanderForm(false)
  }, [])

  const handleCreateSession = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsCreatingSession(true)
    setCreateSessionError(null)

    try {
      if (!sessionProvider) {
        throw new Error('Select an available provider before creating a session.')
      }
      const created = await createSession({
        name: sessionName.trim(),
        cwd: sessionCwd.trim(),
        task: sessionTask.trim(),
        ...buildTouchedReasoningPayload(sessionProvider, {
          effort: sessionEffort,
          adaptiveThinking: sessionAdaptiveThinking,
          maxThinkingTokens: sessionMaxThinkingTokens,
        }, sessionReasoningTouched),
        agentType: sessionAgentType,
        transportType: sessionTransportType,
        machineId: sessionSelectedMachineId.trim() || undefined,
      })
      await queryClient.invalidateQueries({ queryKey: ['agents', 'sessions'] })
      handleSelectStandaloneChat(created.sessionName)
      setSessionName('')
      setSessionCwd('')
      setSessionTask('')
      const defaults = getProviderControlDefaults(sessionProvider)
      setSessionEffort(defaults.effort)
      setSessionAdaptiveThinking(defaults.adaptiveThinking)
      setSessionMaxThinkingTokens(defaults.maxThinkingTokens)
      setSessionReasoningTouched({})
      if (defaultSessionAgentType) {
        setSessionAgentType(defaultSessionAgentType)
      }
      setSessionTransportType(defaults.transportType)
      setSessionSelectedMachineId('')
      setShowCreateSessionForm(false)
    } catch (error) {
      setCreateSessionError(error instanceof Error ? error.message : 'Failed to create session.')
    } finally {
      setIsCreatingSession(false)
    }
  }, [
    handleSelectStandaloneChat,
    queryClient,
    sessionAdaptiveThinking,
    sessionAgentType,
    sessionCwd,
    sessionEffort,
    sessionMaxThinkingTokens,
    sessionName,
    sessionProvider,
    sessionReasoningTouched,
    sessionSelectedMachineId,
    sessionTask,
    sessionTransportType,
    defaultSessionAgentType,
  ])

  const handleCreateCommander = useCallback(async (
    input: Parameters<typeof commanderState.createCommander>[0],
  ) => {
    const createdCommander = await commanderState.createCommander(input)
    await handleSelectCommanderId(createdCommander.id)
  }, [commanderState, handleSelectCommanderId])

  const renderRightColumnContent = () => {
    if (activeTab === 'quests') {
      if (!selectedCommander || isGlobalScope) {
        return (
          <div
            data-testid="right-panel-empty-quests"
            data-test-id="right-panel-empty-quests"
            style={{ padding: 20, color: 'var(--hv-fg-subtle)', fontSize: 12, lineHeight: 1.5 }}
          >
            Select a commander to view quests.
          </div>
        )
      }

      return (
        <QuestBoard
          commanders={[{
            id: selectedCommander.id,
            host: selectedCommander.host,
          }]}
          selectedCommanderId={selectedCommander.id}
        />
      )
    }

    if (activeTab === 'automation') {
      return (
        <AutomationPanel
          presentation="single-pane"
          scope={
            !isGlobalScope && selectedCommander
              ? { kind: 'commander', commander: { id: selectedCommander.id } }
              : { kind: 'global' }
          }
        />
      )
    }

    if (activeTab === 'identity') {
      if (!selectedCommander || isGlobalScope) {
        return (
          <div
            data-testid="right-panel-empty-identity"
            data-test-id="right-panel-empty-identity"
            style={{ padding: 20, color: 'var(--hv-fg-subtle)', fontSize: 12, lineHeight: 1.5 }}
          >
            Select a commander to inspect identity.
          </div>
        )
      }

      return <CommanderIdentityTab commander={selectedCommander} />
    }

    if (workspaceOpen && workspaceSource) {
      return (
        <WorkspacePanel
          source={workspaceSource}
          position="side"
          variant="light"
          onClose={() => setWorkspaceOpenPreference(false)}
          onInsertPath={handleAddWorkspaceContextPath}
          onAddAnnotationContext={handleAddContextFileAnnotation}
          requestedPath={workspaceRequestedPath?.path ?? null}
          requestedPathToken={workspaceRequestedPath?.token ?? 0}
          onRequestedPathConsumed={handleWorkspaceRequestedPathConsumed}
          onRecoverStaleTarget={recoverStaleWorkspaceTarget}
        />
      )
    }

    if (workspaceSource) {
      return (
        <div
          data-testid="workspace-hidden-panel"
          data-test-id="workspace-hidden-panel"
          style={{
            padding: 20,
            color: 'var(--hv-fg-subtle)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <p style={{ margin: 0 }}>Workspace is hidden.</p>
          <button
            type="button"
            data-testid="workspace-hidden-open-button"
            data-test-id="workspace-hidden-open-button"
            className="btn-ghost"
            style={workspaceHiddenOpenButtonStyle()}
            onClick={() => setWorkspaceOpenPreference(true)}
          >
            Open workspace
          </button>
        </div>
      )
    }

    return (
      <div
        data-testid="workspace-empty-panel"
        data-test-id="workspace-empty-panel"
        style={{
          padding: 20,
          color: 'var(--hv-fg-subtle)',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        Select or start a conversation to inspect its workspace.
      </div>
    )
  }

  if (isMobile) {
    return (
      <MobileCommandRoom
        commanders={mobileCommanders}
        commanderIdentities={commanderIdentities}
        commanderSessions={commanderState.commanders}
        conversationResolutionPending={conversationResolutionPending}
        workers={workers}
        automationSessions={automationSessions}
        pendingApprovals={pendingApprovals}
        selectedCommanderId={selectedCommanderId || null}
        onSelectCommanderId={handleSelectCommanderId}
        selectedCommanderRunning={selectedCommanderRunning}
        selectedCommanderAgentType={selectedCommander?.agentType}
        transcript={chatTranscript}
        hasOlderMessages={hasOlderConversationMessages}
        loadingOlderMessages={loadingOlderConversationMessages}
        onLoadOlderMessages={handleLoadOlderConversationMessages}
        onAnswer={(toolId, answers) => {
          answerQuestion(toolId, answers)
        }}
        composerSessionName={composerSessionName}
        composerEnabled={composerEnabled}
        composerSendReady={composerSendReady}
        canQueueDraft={canQueueDraft}
        theme={theme}
        onSetTheme={setTheme}
        commandRoomRouteMetadata={commandRoomRouteMetadata}
        isStreaming={isStreaming}
        streamStatus={streamStatus}
        conversations={visibleConversations}
        selectedConversationId={selectedConversationId}
        onSelectConversationId={(conversationId) => {
          if (conversationId) {
            handleSelectConversationId(conversationId)
            return
          }
          handleClearConversationSelection()
        }}
        queueSnapshot={queueSnapshot}
        queueError={queueError}
        isQueueMutating={isQueueMutating}
        onClearQueue={() => { void handleClearQueue() }}
        onMoveQueuedMessage={(messageId, offset) => { void handleMoveQueuedMessage(messageId, offset) }}
        onRemoveQueuedMessage={(messageId) => { void handleRemoveQueuedMessage(messageId) }}
        onQueue={handleQueue}
        onSend={handleSend}
        contextFileAnnotations={contextFileAnnotations}
        onRemoveContextFileAnnotation={handleRemoveContextFileAnnotation}
        onClearContextFileAnnotations={handleClearContextFilePaths}
        onRestoreContextAttachments={handleRestoreContextAttachments}
        onOpenWorkspaceFile={handleOpenWorkspaceFilePath}
        workspaceRequestedPath={workspaceRequestedPath?.path ?? null}
        workspaceRequestedPathToken={workspaceRequestedPath?.token ?? 0}
        onWorkspaceRequestedPathConsumed={handleWorkspaceRequestedPathConsumed}
        onRecoverStaleWorkspaceTarget={recoverStaleWorkspaceTarget}
        workspaceSource={workspaceSource}
        onCreateChatForCommander={handleRequestNewChatForCommander}
        onCreateConversation={handleCreateChatForCommander}
        requestedNewChatCommanderId={requestedNewChatCommanderId}
        onStartConversation={(conversationId) => { void handleStartConversation(conversationId) }}
        onStopConversation={(conversationId) => { void handleStopConversation(conversationId) }}
        onRenameConversation={(conversationId, name) => { void handleRenameConversation(conversationId, name) }}
        onUpdateConversationRuntimeSettings={(conversationId, settings) => {
          void handleUpdateConversationRuntimeSettings(conversationId, settings)
        }}
        onArchiveConversation={(conversationId) => { void handleArchiveConversation(conversationId) }}
        onRemoveConversation={(conversationId) => { void handleRemoveConversation(conversationId) }}
        onStopCommander={showCommanderRuntimeControls ? () => { void handleStopCommander() } : undefined}
      />
    )
  }

  return (
    <div
      data-testid="command-room-shell"
      data-test-id="command-room-shell"
      style={shellStyle}
    >
      <div
        data-testid="command-room-grid"
        data-test-id="command-room-grid"
        style={gridStyle}
      >
        <SessionsColumn
          selectedCommanderId={selectedCommanderId}
          onSelectCommander={(id) => {
            void handleSelectCommanderId(id)
            if (id === GLOBAL_COMMANDER_ID) {
              handleActiveTabChange(globalCommanderRoute.defaultPanel)
            }
          }}
          onCreateCommander={handleOpenCreateCommander}
          onCreateWorker={handleOpenAddWorker}
          onCreateSession={handleOpenCreateSession}
          onCreateChatForCommander={handleRequestNewChatForCommander}
          selectedChatId={selectedStandaloneSession?.id ?? selectedConversation?.id ?? null}
          onSelectChat={handleSelectStandaloneChat}
          onSelectConversation={handleSelectConversationId}
          onStartConversation={handleStartConversation}
          onStopConversation={handleStopConversation}
          onRenameConversation={handleRenameConversation}
          onUpdateConversationRuntimeSettings={handleUpdateConversationRuntimeSettings}
          onArchiveConversation={handleArchiveConversation}
          onRemoveConversation={handleRemoveConversation}
          commanders={sessionCommanders}
          conversations={visibleConversations}
          workers={workers}
          approvals={approvals}
          workerSessions={workerSessions}
          automationSessions={automationSessions}
          onKillSession={handleKillSession}
          onResumeSession={handleResumeSession}
        />

        <CenterColumn
          commander={centerCommander}
          isGlobalScope={isGlobalScope}
          hasSelectedConversation={Boolean(selectedConversation)}
          streamStatus={selectedConversation ? streamStatus : null}
          conversationLoadError={conversationErrorMessage}
          onRetryConversations={handleRetryConversationLoad}
          activeChatSession={activeChatSession}
          activeConversationId={selectedConversation?.id ?? null}
          pendingApprovals={pendingApprovals}
          transcript={chatTranscript}
          hasOlderMessages={hasOlderConversationMessages}
          loadingOlderMessages={loadingOlderConversationMessages}
          onLoadOlderMessages={handleLoadOlderConversationMessages}
          workers={commanderWorkers.map((w) => ({
            id: w.id,
            name: w.name,
            kind: w.kind ?? 'worker',
            state: w.state || 'idle',
          }))}
          automationSessions={commanderAutomationSessions}
          activeTab={activeTab}
          setActiveTab={handleActiveTabChange}
          onCloseActiveChat={() => setSelectedChatSessionId(null)}
          onKillSession={(sessionName, agentType) =>
            handleKillSession(sessionName, agentType, activeChatSession?.transportType)
          }
          onOpenWorkspace={selectedConversationId || activeStandaloneSession || (!isGlobalScope && selectedCommanderId)
            ? () => {
                handleActiveTabChange('chat')
                setWorkspaceOpenPreference(true)
              }
            : undefined}
          globalAutomationPanel={isGlobalScope && activeTab === 'automation'
            ? (
                <AutomationPanel
                  scope={{ kind: 'global' }}
                />
              )
            : undefined}
          onCreateChat={!isGlobalScope && selectedCommanderId
            ? (
                agentType: AgentType,
                model: string | null,
                reasoningConfig: CreateConversationReasoningConfig,
                credentialPoolId?: string,
              ) => {
                void handleCreateChatForCommander(
                  selectedCommanderId,
                  agentType,
                  model,
                  reasoningConfig,
                  credentialPoolId,
                )
              }
            : undefined}
          createChatPending={createConversation.isPending}
          defaultCreateAgentType={selectedCommander?.agentType}
          onStopCommander={showCommanderRuntimeControls ? () => { void handleStopCommander() } : undefined}
          onAnswer={(toolId, answers) => {
            answerQuestion(toolId, answers)
          }}
          composerSessionName={composerSessionName}
          composerEnabled={composerEnabled}
          composerDisabledMessage={conversationComposerDisabledMessage}
          composerSendReady={composerSendReady}
          canQueueDraft={canQueueDraft}
          contextFilePaths={contextFilePaths}
          contextDirectoryPaths={contextDirectoryPaths}
          contextFileAnnotations={contextFileAnnotations}
          onRemoveContextFilePath={handleRemoveContextFilePath}
          onRemoveContextDirectoryPath={handleRemoveContextDirectoryPath}
          onRemoveContextFileAnnotation={handleRemoveContextFileAnnotation}
          onClearContextFilePaths={handleClearContextFilePaths}
          onRestoreContextAttachments={handleRestoreContextAttachments}
          onQueue={handleQueue}
          onSend={handleSend}
          onOpenWorkspaceFile={handleOpenWorkspaceFilePath}
          queueSnapshot={queueSnapshot}
          queueError={queueError}
          isQueueMutating={isQueueMutating}
          onClearQueue={() => { void handleClearQueue() }}
          onMoveQueuedMessage={(messageId, offset) => { void handleMoveQueuedMessage(messageId, offset) }}
          onRemoveQueuedMessage={(messageId) => { void handleRemoveQueuedMessage(messageId) }}
          theme={theme}
          onSetTheme={setTheme}
        />

        {!isGlobalScope && (
          <aside
            data-testid="workspace-right-column"
            data-test-id="workspace-right-column"
            style={{
              background: 'var(--hv-bg-raised)',
              borderLeft: '1px solid var(--hv-border-hair)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
              width: rightColumnWidth,
              transition: 'width 180ms var(--hv-ease-gentle)',
            }}
          >
            <div
              data-testid="right-panel-actions"
              data-test-id="right-panel-actions"
              style={rightPanelActionsStyle(workspaceOpen)}
            >
              {RIGHT_PANEL_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`right-panel-tab-${tab.id}`}
                  data-test-id={`right-panel-tab-${tab.id}`}
                  aria-pressed={activeTab === tab.id}
                  className="font-mono"
                  style={rightPanelButtonStyle(activeTab === tab.id, !workspaceOpen)}
                  onClick={() => {
                    handleActiveTabChange(tab.id)
                    if (tab.id === 'chat') {
                      setWorkspaceOpenPreference(true)
                    }
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'hidden',
                padding: '18px',
              }}
            >
              <div
                data-testid="right-panel-content"
                data-test-id="right-panel-content"
                style={{
                  height: '100%',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                {renderRightColumnContent()}
              </div>
            </div>
          </aside>
        )}
      </div>

      <ModalFormContainer
        open={showCreateSessionForm}
        title="New Session"
        onClose={handleCloseCreateSession}
      >
        <NewSessionForm
          name={sessionName}
          setName={setSessionName}
          cwd={sessionCwd}
          setCwd={setSessionCwd}
          task={sessionTask}
          setTask={setSessionTask}
          effort={sessionEffort}
          setEffort={(value) => {
            setSessionEffort(value)
            setSessionReasoningTouched((current) => ({ ...current, effort: true }))
          }}
          adaptiveThinking={sessionAdaptiveThinking}
          setAdaptiveThinking={(value) => {
            setSessionAdaptiveThinking(value)
            setSessionReasoningTouched((current) => ({ ...current, adaptiveThinking: true }))
          }}
          maxThinkingTokens={sessionMaxThinkingTokens}
          setMaxThinkingTokens={(value) => {
            setSessionMaxThinkingTokens(value)
            setSessionReasoningTouched((current) => ({ ...current, maxThinkingTokens: true }))
          }}
          agentType={sessionAgentType}
          setAgentType={setSessionAgentType}
          transportType={sessionTransportType}
          setTransportType={setSessionTransportType}
          machines={machineList}
          selectedMachineId={sessionSelectedMachineId}
          setSelectedMachineId={setSessionSelectedMachineId}
          isCreating={isCreatingSession}
          createError={createSessionError}
          onSubmit={handleCreateSession}
        />
      </ModalFormContainer>
      <ModalFormContainer
        open={showCreateCommanderForm}
        title="New Commander"
        onClose={handleCloseCreateCommander}
      >
        <CreateCommanderWizard
          onAdd={handleCreateCommander}
          isPending={commanderState.createCommanderPending}
          onClose={handleCloseCreateCommander}
          onWizardCreated={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['commanders', 'sessions'] }),
              queryClient.invalidateQueries({ queryKey: ['agents', 'sessions'] }),
            ])
          }}
        />
      </ModalFormContainer>
      <ModalFormContainer
        open={showAddWorkerForm}
        title="Add Machine"
        onClose={handleCloseAddWorker}
      >
        <AddWorkerWizard
          onCreated={async () => {
            handleCloseAddWorker()
          }}
        />
      </ModalFormContainer>
      <Toast open={Boolean(sessionActionError)} message={sessionActionError ?? ''} tone="error" />
    </div>
  )
}
