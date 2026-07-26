import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useApprovalDecision, type PendingApproval } from '@/hooks/use-approvals'
import { cn } from '@/lib/utils'
import type { AgentType, SessionQueueSnapshot } from '@/types'
import {
  getWorkspaceSourceKey,
  type WorkspacePendingFileAnnotation,
  type WorkspaceSource,
  type WorkspaceSourceRecovery,
} from '@modules/workspace/use-workspace'
import type { WorkspaceTreeNode } from '@modules/workspace/types'
import type {
  SessionComposerContextAttachments,
  SessionComposerSubmitPayload,
} from '@modules/agents/components/SessionComposer'
import type { MsgItem } from '@modules/agents/messages/model'
import {
  GLOBAL_COMMANDER_ID,
  isGlobalCommanderId,
  type CommanderAgentType,
  type CommanderSession,
} from '@modules/commanders/hooks/useCommander'
import {
  normalizeCommandRoomGlobalSearchParams,
  normalizeCommandRoomRouteMetadata,
  type CommandRoomRouteMetadata,
} from '@modules/command-room/route-metadata'
import type {
  ConversationRecord,
  ConversationRuntimeSettingsUpdate,
} from '@modules/conversation/hooks/use-conversations'
import type { CreateConversationReasoningConfig } from '@modules/conversation/components/CreateConversationPanel'
import type { ChatSession } from '@modules/command-room/components/desktop/SessionsColumn'
import type { Commander, Worker } from '@modules/command-room/components/desktop/SessionRow'
import { MobileApprovalSheet } from '@modules/approvals/MobileApprovalSheet'
import { MobileChatView } from './MobileChatView'
import { MobileInbox } from '@modules/approvals/MobileInbox'
import { MobileSessionsList } from './MobileSessionsList'
import { MobileSettings } from '@modules/settings/MobileSettings'
import { MobileTeamSheet } from './MobileTeamSheet'
import { MobileWorkspaceSheet } from './MobileWorkspaceSheet'
import { orderMobileConversations } from './orderMobileConversations'

type SheetKind = 'team' | 'approval' | 'workspace' | null
type MobileTab = 'sessions' | 'inbox' | 'settings'

function approvalMatchesCommander(approval: PendingApproval, commander: Commander): boolean {
  return approval.commanderId === commander.id || approval.commanderName === commander.name
}

function approvalMatchesCommanderConversation(
  approval: PendingApproval,
  conversationIds: ReadonlySet<string>,
): boolean {
  return Boolean(approval.conversationId && conversationIds.has(approval.conversationId))
}

function resolveMobileTab(pathname: string, metadata: CommandRoomRouteMetadata): MobileTab {
  const inboxMode = metadata.mobile.modes.find((mode) => mode.id === 'inbox')
  if (inboxMode && pathname.startsWith(inboxMode.path)) {
    return inboxMode.id
  }

  const settingsMode = metadata.mobile.modes.find((mode) => mode.id === 'settings')
  if (settingsMode && pathname.startsWith(settingsMode.path)) {
    return settingsMode.id
  }

  return 'sessions'
}

export interface MobileCommandRoomProps {
  /** Active commanders shown in mobile navigation. */
  commanders: Commander[]
  /** All known identities, including archived commanders addressable by URL. */
  commanderIdentities?: Commander[]
  commanderSessions: CommanderSession[]
  /**
   * Per issue 1878: true while the client is still resolving commander/
   * conversation knowledge for the commander in the URL (cold caches). The
   * chat shell then mounts keyed on the URL param with a transcript skeleton
   * instead of waiting for the commanders query — never a blank section.
   */
  conversationResolutionPending?: boolean
  workers: Worker[]
  automationSessions?: ChatSession[]
  pendingApprovals: PendingApproval[]
  selectedCommanderId: string | null
  onSelectCommanderId: (id: string) => void
  selectedCommanderRunning: boolean
  selectedCommanderAgentType?: CommanderAgentType
  transcript: MsgItem[]
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void
  onAnswer: (toolId: string, answers: Record<string, string[]>) => void
  composerSessionName: string
  composerEnabled: boolean
  composerSendReady: boolean
  canQueueDraft: boolean
  theme: 'light' | 'dark'
  onSetTheme: (theme: 'light' | 'dark') => void
  conversations?: ConversationRecord[]
  selectedConversationId?: string | null
  onSelectConversationId?: (conversationId: string | null) => void
  isStreaming?: boolean
  streamStatus?: 'connecting' | 'connected' | 'disconnected' | 'closed' | null
  queueSnapshot: SessionQueueSnapshot
  queueError?: string | null
  isQueueMutating: boolean
  onClearQueue: () => void
  onMoveQueuedMessage: (id: string, offset: number) => void
  onRemoveQueuedMessage: (id: string) => void
  onSend?: (payload: SessionComposerSubmitPayload) => boolean | void | Promise<boolean | void>
  onQueue?: (
    payload: SessionComposerSubmitPayload,
  ) => boolean | void | Promise<boolean | void>
  contextFileAnnotations?: WorkspacePendingFileAnnotation[]
  onRemoveContextFileAnnotation?: (commentId: string) => void
  onClearContextFileAnnotations?: () => void
  onRestoreContextAttachments?: (context: SessionComposerContextAttachments) => void
  workspaceSource: WorkspaceSource | null
  onOpenWorkspaceFile?: (path: string) => void
  workspaceRequestedPath?: string | null
  workspaceRequestedPathToken?: number
  onWorkspaceRequestedPathConsumed?: (token: number) => void
  onRecoverStaleWorkspaceTarget?: WorkspaceSourceRecovery
  onStopCommander?: () => void
  onCreateChatForCommander?: (commanderId: string) => void | Promise<void>
  onCreateConversation?: (
    commanderId: string,
    agentType: AgentType,
    model: string | null,
    reasoningConfig: CreateConversationReasoningConfig,
    credentialPoolId?: string,
  ) => Promise<ConversationRecord | null> | ConversationRecord | null
  requestedNewChatCommanderId?: string | null
  onStartConversation?: (conversationId: string) => void | Promise<void>
  onStopConversation?: (conversationId: string) => void | Promise<void>
  onRenameConversation?: (conversationId: string, name: string) => void | Promise<void>
  onUpdateConversationRuntimeSettings?: (
    conversationId: string,
    settings: ConversationRuntimeSettingsUpdate,
  ) => void | Promise<void>
  onArchiveConversation?: (conversationId: string) => void | Promise<void>
  onRemoveConversation?: (conversationId: string) => void | Promise<void>
  commandRoomRouteMetadata?: CommandRoomRouteMetadata
}

export function MobileCommandRoom({
  commanders,
  commanderIdentities = commanders,
  commanderSessions,
  conversationResolutionPending = false,
  workers,
  automationSessions = [],
  pendingApprovals,
  selectedCommanderId,
  onSelectCommanderId,
  selectedCommanderRunning,
  selectedCommanderAgentType,
  transcript,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  onAnswer,
  composerSessionName,
  composerEnabled,
  composerSendReady,
  canQueueDraft,
  theme,
  onSetTheme,
  conversations,
  selectedConversationId = null,
  onSelectConversationId = () => {},
  isStreaming = false,
  streamStatus,
  queueSnapshot,
  queueError,
  isQueueMutating,
  onClearQueue,
  onMoveQueuedMessage,
  onRemoveQueuedMessage,
  onSend,
  onQueue,
  contextFileAnnotations = [],
  onRemoveContextFileAnnotation,
  onClearContextFileAnnotations,
  onRestoreContextAttachments,
  workspaceSource,
  onOpenWorkspaceFile,
  workspaceRequestedPath,
  workspaceRequestedPathToken = 0,
  onWorkspaceRequestedPathConsumed,
  onRecoverStaleWorkspaceTarget,
  onStopCommander,
  onCreateChatForCommander,
  onCreateConversation,
  requestedNewChatCommanderId = null,
  onStartConversation,
  onStopConversation,
  onRenameConversation,
  onUpdateConversationRuntimeSettings,
  onArchiveConversation,
  onRemoveConversation,
  commandRoomRouteMetadata,
}: MobileCommandRoomProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const routeMetadata = useMemo(
    () => normalizeCommandRoomRouteMetadata(commandRoomRouteMetadata),
    [commandRoomRouteMetadata],
  )
  const { launch: commandRoomLaunch, globalCommander: globalCommanderRoute, mobile: mobileRoute } = routeMetadata
  const commanderParam = searchParams.get(commandRoomLaunch.commanderParam)?.trim() || null
  const commanderId = commanderParam === globalCommanderRoute.commanderValue ? GLOBAL_COMMANDER_ID : commanderParam
  const tab = resolveMobileTab(location.pathname, routeMetadata)
  const inChat = tab === 'sessions' && commanderId !== null && !isGlobalCommanderId(commanderId)
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null)
  const [contextFilePaths, setContextFilePaths] = useState<string[]>([])
  const [contextDirectoryPaths, setContextDirectoryPaths] = useState<string[]>([])
  const approvalDecision = useApprovalDecision()
  const surface = searchParams.get(mobileRoute.surfaceParam)
  const surfaceSearch = surface ? `${mobileRoute.surfaceParam}=${encodeURIComponent(surface)}` : ''
  const workspaceSelectionKey = useMemo(
    () => workspaceSource ? getWorkspaceSourceKey(workspaceSource) : `none:${composerSessionName}`,
    [composerSessionName, workspaceSource],
  )

  useEffect(() => {
    if (
      !mobileRoute.normalizeGlobalRoute
      || location.pathname !== commandRoomLaunch.path
      || commanderId !== GLOBAL_COMMANDER_ID
    ) {
      return
    }

    const nextParams = normalizeCommandRoomGlobalSearchParams(
      new URLSearchParams(location.search),
      routeMetadata,
    )
    const nextSearch = nextParams.toString()
    const currentSearch = location.search.startsWith('?')
      ? location.search.slice(1)
      : location.search
    if (location.pathname === commandRoomLaunch.path && currentSearch === nextSearch) {
      return
    }

    navigate(`${commandRoomLaunch.path}?${nextSearch}`, { replace: true })
  }, [
    commandRoomLaunch.path,
    commanderId,
    location.pathname,
    location.search,
    mobileRoute.normalizeGlobalRoute,
    navigate,
    routeMetadata,
  ])

  useEffect(() => {
    if (!selectedApprovalId) {
      return
    }
    const stillExists = pendingApprovals.some((approval) => approval.id === selectedApprovalId)
    if (!stillExists) {
      setSelectedApprovalId(null)
      setSheet((current) => (current === 'approval' ? null : current))
    }
  }, [pendingApprovals, selectedApprovalId])

  useEffect(() => {
    setContextFilePaths([])
    setContextDirectoryPaths([])
  }, [workspaceSelectionKey])

  const selectedCommander = commanderIdentities.find((commander) => commander.id === selectedCommanderId)
    ?? commanders[0]
    ?? null
  const activeCommanderId = commanderId ?? selectedCommander?.id ?? null
  const activeCommander = commanderIdentities.find((commander) => commander.id === activeCommanderId)
    ?? selectedCommander
  // Per issue 1878: the chat shell mounts keyed on the commander URL param.
  // While the shared commanders cache is still resolving (cold arrival), a
  // minimal identity built from the URL param keeps the shell painting in the
  // same frame; the cached identity takes over once the list hydrates.
  const chatCommander: Commander | null = activeCommander ?? (
    inChat && commanderId && conversationResolutionPending
      ? { id: commanderId, name: '', status: 'unknown' }
      : null
  )
  const activeCommanderConversationIds = useMemo(
    () => new Set((conversations ?? [])
      .filter((conversation) => conversation.commanderId === activeCommander?.id)
      .map((conversation) => conversation.id)),
    [activeCommander?.id, conversations],
  )
  const activeCommanderApprovals = useMemo(
    () => activeCommander
      ? pendingApprovals.filter((approval) => (
        approvalMatchesCommander(approval, activeCommander)
        || approvalMatchesCommanderConversation(approval, activeCommanderConversationIds)
      ))
      : [],
    [activeCommander, activeCommanderConversationIds, pendingApprovals],
  )
  const hasConversationMode = Array.isArray(conversations)
  const activeCommanderWorkers = useMemo(
    () => activeCommander
      ? workers.filter((worker) => worker.commanderId === activeCommander.id)
      : [],
    [activeCommander, workers],
  )
  const activeCommanderAutomationSessions = useMemo(
    () => activeCommander
      ? automationSessions.filter((session) => session.parentCommanderId === activeCommander.id)
      : [],
    [activeCommander, automationSessions],
  )
  const activeCommanderSession = useMemo(
    () => activeCommander
      ? commanderSessions.find((session) => session.id === activeCommander.id) ?? null
      : null,
    [activeCommander, commanderSessions],
  )
  const visibleConversations = useMemo(
    () => orderMobileConversations(
      (conversations ?? []).filter((conversation) => (
        conversation.commanderId === activeCommander?.id
        && conversation.displayState?.isVisible !== false
        && conversation.status !== 'archived'
      )),
    ),
    [activeCommander?.id, conversations],
  )
  const [durationSec, setDurationSec] = useState<number | undefined>(undefined)
  const selectedApproval = pendingApprovals.find((approval) => approval.id === selectedApprovalId) ?? null

  useEffect(() => {
    const createdAt = activeCommanderSession?.created
    if (!createdAt) {
      setDurationSec(undefined)
      return
    }

    const createdMs = Date.parse(createdAt)
    if (!Number.isFinite(createdMs)) {
      setDurationSec(undefined)
      return
    }

    const updateDuration = () => {
      setDurationSec(Math.max(0, Math.floor((Date.now() - createdMs) / 1000)))
    }

    updateDuration()
    const interval = window.setInterval(updateDuration, 1000)
    return () => window.clearInterval(interval)
  }, [activeCommanderSession?.created])

  function closeSheets() {
    setSheet(null)
    setSelectedApprovalId(null)
  }

  const handleSelectConversationId = useCallback((conversationId: string | null) => {
    onSelectConversationId(conversationId)
  }, [onSelectConversationId])

  useEffect(() => {
    if (!inChat || activeCommander || commanders.length === 0) {
      return
    }
    navigate(
      `${commandRoomLaunch.path}${surfaceSearch ? `?${surfaceSearch}` : ''}`,
      { replace: true },
    )
  }, [activeCommander, commandRoomLaunch.path, commanders, inChat, navigate, surfaceSearch])

  function openApproval(approvalId: string | null) {
    setSelectedApprovalId(approvalId ?? null)
    setSheet('approval')
  }

  function handleSelectCommander(id: string) {
    onSelectCommanderId(id)
  }

  function handleAddWorkspaceContextPath(contextPath: string, type: WorkspaceTreeNode['type'] = 'file') {
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
  }

  function handleRemoveContextFilePath(filePath: string) {
    setContextFilePaths((current) => current.filter((entry) => entry !== filePath))
  }

  function handleRemoveContextDirectoryPath(directoryPath: string) {
    setContextDirectoryPaths((current) => current.filter((entry) => entry !== directoryPath))
  }

  function handleRestoreContextAttachments(context: SessionComposerContextAttachments) {
    setContextFilePaths(context.filePaths)
    setContextDirectoryPaths(context.directoryPaths)
    onRestoreContextAttachments?.(context)
  }

  const handleOpenWorkspaceFileFromChat = useCallback((filePath: string) => {
    void onOpenWorkspaceFile?.(filePath)
    setSheet('workspace')
  }, [onOpenWorkspaceFile])

  return (
    <section
      className={cn(
        // Viewport containment lives at Shell (overflow-x on <main>); this
        // component is a normal flex-fill route body, not a viewport overlay.
        // overflow-x-hidden kept here as defence-in-depth. See issue 1107.
        'flex min-h-0 flex-1 w-full flex-col overflow-x-hidden',
        'bg-[var(--hv-bg-raised)]',
      )}
      data-testid="mobile-command-room"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'sessions' && inChat && chatCommander ? (
          <MobileChatView
            commander={chatCommander}
            conversationResolutionPending={conversationResolutionPending}
            workers={activeCommanderWorkers}
            transcript={transcript}
            hasOlderMessages={hasOlderMessages}
            loadingOlderMessages={loadingOlderMessages}
            onLoadOlderMessages={onLoadOlderMessages}
            approvals={activeCommanderApprovals}
            sessionName={composerSessionName}
            composerEnabled={composerEnabled}
            composerSendReady={composerSendReady}
            canQueueDraft={canQueueDraft}
            conversations={hasConversationMode ? visibleConversations : undefined}
            selectedConversationId={hasConversationMode ? selectedConversationId : undefined}
            isStreaming={isStreaming}
            agentType={activeCommanderSession?.agentType ?? selectedCommanderAgentType}
            wsStatus={streamStatus}
            costUsd={activeCommanderSession?.totalCostUsd}
            durationSec={durationSec}
            theme={theme}
            onSetTheme={onSetTheme}
            queueSnapshot={queueSnapshot}
            queueError={queueError}
            isQueueMutating={isQueueMutating}
            onBack={() => navigate('/org')}
            onOpenTeam={() => setSheet('team')}
            onOpenWorkspace={() => setSheet('workspace')}
            onOpenWorkspaceFile={handleOpenWorkspaceFileFromChat}
            onSelectConversationId={handleSelectConversationId}
            onCreateConversation={onCreateConversation
              ? (agentType, model, reasoningConfig, credentialPoolId) =>
                  onCreateConversation(
                    chatCommander.id,
                    agentType,
                    model,
                    reasoningConfig,
                    credentialPoolId,
                  ) ?? null
              : undefined}
            onRequestCreateConversation={onCreateChatForCommander
              ? () => onCreateChatForCommander(chatCommander.id)
              : undefined}
            onStartConversation={onStartConversation}
            onStopConversation={onStopConversation}
            onRenameConversation={onRenameConversation}
            onUpdateConversationRuntimeSettings={onUpdateConversationRuntimeSettings}
            onArchiveConversation={onArchiveConversation}
            onRemoveConversation={onRemoveConversation}
            onStopCommander={selectedCommanderRunning ? onStopCommander : undefined}
            showCreateConversationPanel={requestedNewChatCommanderId === chatCommander.id}
            onAnswer={onAnswer}
            onApproveApproval={async (approval) => {
              await approvalDecision.mutateAsync({ approval, decision: 'approve' })
            }}
            onDenyApproval={async (approval) => {
              await approvalDecision.mutateAsync({ approval, decision: 'reject' })
            }}
            onClearQueue={onClearQueue}
            onMoveQueuedMessage={onMoveQueuedMessage}
            onRemoveQueuedMessage={onRemoveQueuedMessage}
            contextFilePaths={contextFilePaths}
            contextDirectoryPaths={contextDirectoryPaths}
            contextFileAnnotations={contextFileAnnotations}
            onRemoveContextFilePath={handleRemoveContextFilePath}
            onRemoveContextDirectoryPath={handleRemoveContextDirectoryPath}
            onRemoveContextFileAnnotation={onRemoveContextFileAnnotation}
            onClearContextFilePaths={() => {
              setContextFilePaths([])
              setContextDirectoryPaths([])
              onClearContextFileAnnotations?.()
            }}
            onRestoreContextAttachments={handleRestoreContextAttachments}
            onSend={onSend}
            onQueue={onQueue}
          />
        ) : null}

        {tab === 'sessions' && !inChat ? (
          <MobileSessionsList
            commanders={commanders}
            selectedCommanderId={selectedCommanderId}
            workers={workers}
            approvals={pendingApprovals}
            onSelectCommander={handleSelectCommander}
          />
        ) : null}

        {tab === 'inbox' ? (
          <MobileInbox onOpenApproval={(approvalId) => openApproval(approvalId)} />
        ) : null}

        {tab === 'settings' ? <MobileSettings /> : null}
      </div>

      {/*
        Canonical mobile navigation chrome is owned by the viewport shell so
        every mobile route in the app receives the same IA. The shell chrome
        hides on immersive chat routes via the `?commander=` query param.
      */}

      <MobileTeamSheet
        open={sheet === 'team'}
        commander={activeCommander}
        workers={workers}
        automationSessions={activeCommanderAutomationSessions}
        approvals={pendingApprovals}
        onOpenApproval={openApproval}
        onClose={closeSheets}
      />

      <MobileApprovalSheet
        approval={selectedApproval}
        onClose={closeSheets}
        onApprove={selectedApproval
          ? async () => {
              await approvalDecision.mutateAsync({ approval: selectedApproval, decision: 'approve' })
            }
          : undefined}
        onDeny={selectedApproval
          ? async () => {
              await approvalDecision.mutateAsync({ approval: selectedApproval, decision: 'reject' })
            }
          : undefined}
      />

      <MobileWorkspaceSheet
        open={sheet === 'workspace'}
        source={workspaceSource}
        onSelectFile={handleAddWorkspaceContextPath}
        onClose={closeSheets}
        requestedPath={workspaceRequestedPath}
        requestedPathToken={workspaceRequestedPathToken}
        onRequestedPathConsumed={onWorkspaceRequestedPathConsumed}
        onRecoverStaleTarget={onRecoverStaleWorkspaceTarget}
      />
    </section>
  )
}
