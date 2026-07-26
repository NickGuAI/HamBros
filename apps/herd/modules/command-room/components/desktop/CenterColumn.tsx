/**
 * Herd — CenterColumn
 *
 * Fluid main content area for the Command Room:
 *   - Delegated sub-agent strip
 *   - Compact ChatPane
 *   - Sumi-e composer box pinned at bottom
 *
 * Approval integration uses usePendingApprovals + useApprovalDecision
 * from the existing hooks — no new endpoints created.
 */
import type { ReactNode } from 'react'
import { useProviderRegistry } from '@/hooks/use-providers'
import { useApprovalDecision, type PendingApproval } from '@/hooks/use-approvals'
import type { AgentType, ProviderRegistryEntry, SessionQueueSnapshot } from '@/types'
import {
  SessionComposer,
  type SessionComposerContextAttachments,
  type SessionComposerSubmitPayload,
} from '@modules/agents/components/SessionComposer'
import { TerminalView } from '@modules/agents/page-shell/TerminalView'
import type { MsgItem } from '@modules/agents/messages/model'
import type {
  CommanderCronCreateInput,
  CommanderCronTask,
  CommanderSession,
} from '@modules/commanders/hooks/useCommander'
import {
  CreateConversationPanel,
  type CreateConversationReasoningConfig,
} from '@modules/conversation/components/CreateConversationPanel'
import { ChatPane } from './ChatPane'
import type { ChatSession } from './SessionsColumn'
import { SubAgentChip, type Worker } from './SubAgentChip'
import type { WorkspacePendingFileAnnotation } from '@modules/workspace/use-workspace'
import { STATE_COLOR } from '@modules/components/hervald'

/* ---- local types ---- */

type CommandRoomStreamStatus = 'connecting' | 'connected' | 'disconnected' | 'closed' | null

export interface HervaldCommander extends Partial<CommanderSession> {
  id: string
  name: string
  status: string
  description?: string
  cost?: number
  uptime?: string
  contextConfig?: {
    fatPinInterval: number
  }
  runtime?: {
    heartbeatCount: number
  }
}

export interface CenterColumnProps {
  commander: HervaldCommander
  isGlobalScope?: boolean
  hasSelectedConversation?: boolean
  streamStatus?: CommandRoomStreamStatus
  conversationLoadError?: string | null
  onRetryConversations?: () => void
  activeChatSession?: ChatSession | null
  activeConversationId?: string | null
  pendingApprovals?: PendingApproval[]
  transcript?: MsgItem[]
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void
  workers?: Worker[]
  automationSessions?: ChatSession[]
  activeTab: string
  setActiveTab: (tab: string) => void
  crons?: CommanderCronTask[]
  cronsLoading?: boolean
  cronsError?: string | null
  addCron?: (input: CommanderCronCreateInput) => Promise<void>
  addCronPending?: boolean
  toggleCron?: (input: { commanderId?: string; cronId: string; enabled: boolean }) => Promise<void>
  toggleCronPending?: boolean
  toggleCronId?: string | null
  updateCron?: (input: {
    commanderId?: string
    cronId: string
    name?: string
    description?: string
    schedule?: string
    timezone?: string
    machine?: string
    workDir?: string
    agentType?: AgentType
    instruction?: string
    model?: string
    enabled?: boolean
    permissionMode?: string
    sessionType?: 'stream' | 'pty'
  }) => Promise<void>
  updateCronPending?: boolean
  updateCronId?: string | null
  triggerCron?: (cronId: string) => Promise<void>
  triggerCronPending?: boolean
  triggerCronId?: string | null
  deleteCron?: (input: { commanderId?: string; cronId: string }) => Promise<void>
  deleteCronPending?: boolean
  deleteCronId?: string | null
  onOpenWorkspace?: () => void
  onOpenWorkspaceFile?: (path: string) => void
  globalAutomationPanel?: ReactNode
  onCreateChat?: (
    agentType: AgentType,
    model: string | null,
    reasoningConfig: CreateConversationReasoningConfig,
    credentialPoolId?: string,
  ) => void | Promise<void>
  createChatPending?: boolean
  defaultCreateAgentType?: AgentType
  availableAgentTypes?: AgentType[]
  onStopCommander?: () => void
  onCloseActiveChat?: () => void
  onKillSession?: (sessionName: string, agentType?: ChatSession['agentType']) => Promise<void>
  onSend?: (payload: SessionComposerSubmitPayload) => boolean | void | Promise<boolean | void>
  onQueue?: (
    payload: SessionComposerSubmitPayload,
  ) => boolean | void | Promise<boolean | void>
  contextFilePaths?: string[]
  contextDirectoryPaths?: string[]
  contextFileAnnotations?: WorkspacePendingFileAnnotation[]
  onRemoveContextFilePath?: (filePath: string) => void
  onRemoveContextDirectoryPath?: (directoryPath: string) => void
  onRemoveContextFileAnnotation?: (commentId: string) => void
  onClearContextFilePaths?: () => void
  onRestoreContextAttachments?: (context: SessionComposerContextAttachments) => void
  onAnswer: (toolId: string, answers: Record<string, string[]>) => void
  composerSessionName: string
  composerEnabled: boolean
  composerDisabledMessage?: string
  composerSendReady: boolean
  canQueueDraft: boolean
  queueSnapshot: SessionQueueSnapshot
  queueError?: string | null
  isQueueMutating?: boolean
  onClearQueue: () => void
  onMoveQueuedMessage: (messageId: string, offset: number) => void
  onRemoveQueuedMessage: (messageId: string) => void
  theme: 'light' | 'dark'
  onSetTheme: (theme: 'light' | 'dark') => void
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '60px 40px',
        textAlign: 'center',
        color: 'var(--hv-fg-faint)',
        fontSize: 13,
        fontStyle: 'italic',
      }}
    >
      {message}
    </div>
  )
}

function ConversationErrorPanel({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex h-full items-center justify-center px-8 py-12">
      <div className="max-w-md rounded-lg border border-[color:var(--hv-accent-danger)] bg-[var(--hv-accent-danger-wash)] px-4 py-3 text-sm text-[color:var(--hv-accent-danger)]">
        <p>{message}</p>
        {onRetry ? (
          <button
            type="button"
            className="mt-2 font-mono text-xs underline"
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ConversationStreamStatusNotice({ status }: { status: Exclude<CommandRoomStreamStatus, null | 'connected'> }) {
  const message = status === 'connecting'
    ? 'Conversation stream reconnecting...'
    : 'Conversation stream unavailable. Reconnecting to the live session.'

  return (
    <div
      className="font-mono"
      data-testid="conversation-stream-status"
      role="status"
      style={{
        marginBottom: 8,
        border: '1px solid var(--hv-border-soft)',
        borderRadius: 4,
        background: 'var(--hv-bg-raised)',
        color: 'var(--hv-fg-muted)',
        fontSize: 11,
        lineHeight: 1.5,
        padding: '6px 10px',
      }}
    >
      {message}
    </div>
  )
}

/* ---- main export ---- */

export function CenterColumn({
  commander,
  isGlobalScope = false,
  hasSelectedConversation = false,
  streamStatus = null,
  conversationLoadError = null,
  onRetryConversations,
  activeChatSession = null,
  activeConversationId = null,
  pendingApprovals = [],
  transcript = [],
  hasOlderMessages = false,
  loadingOlderMessages = false,
  onLoadOlderMessages,
  workers = [],
  automationSessions = [],
  crons = [],
  cronsLoading = false,
  cronsError = null,
  addCron,
  addCronPending = false,
  toggleCron,
  toggleCronPending = false,
  toggleCronId = null,
  updateCron,
  updateCronPending = false,
  updateCronId = null,
  triggerCron,
  triggerCronPending = false,
  triggerCronId = null,
  deleteCron,
  deleteCronPending = false,
  deleteCronId = null,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  globalAutomationPanel,
  onCreateChat,
  createChatPending = false,
  defaultCreateAgentType,
  availableAgentTypes,
  onCloseActiveChat,
  onKillSession,
  onSend,
  onQueue,
  contextFilePaths,
  contextDirectoryPaths,
  contextFileAnnotations,
  onRemoveContextFilePath,
  onRemoveContextDirectoryPath,
  onRemoveContextFileAnnotation,
  onClearContextFilePaths,
  onRestoreContextAttachments,
  onAnswer,
  activeTab,
  composerSessionName,
  composerEnabled,
  composerDisabledMessage,
  composerSendReady,
  queueSnapshot,
  queueError = null,
  isQueueMutating = false,
  onClearQueue,
  onMoveQueuedMessage,
  onRemoveQueuedMessage,
  theme,
}: CenterColumnProps) {
  const { data: providers = [] } = useProviderRegistry()
  const providerOptions: ProviderRegistryEntry[] = availableAgentTypes?.length
    ? providers.filter((provider) => availableAgentTypes.includes(provider.id))
    : providers

  const decisionMutation = useApprovalDecision()

  const activeApprovals = pendingApprovals.filter((approval) => {
    if (activeConversationId && approval.conversationId) {
      return approval.conversationId === activeConversationId
    }
    if (approval.conversationId) {
      return false
    }
    if (activeChatSession?.id && approval.sessionName) {
      return approval.sessionName === activeChatSession.id
    }
    return false
  })

  const subAgents = workers.filter((w) => w.kind === 'worker' || w.kind === 'tool')
  const automationChips = automationSessions.map((session) => ({
    id: session.id,
    name: session.label ?? session.name,
    state: session.status ?? 'idle',
  }))
  const hasCommander = !isGlobalScope && commander.id.trim().length > 0
  const hasConversation = isGlobalScope
    ? false
    : Boolean(activeChatSession) || hasSelectedConversation
  const needsConversation = !isGlobalScope
    && hasCommander
    && !activeChatSession
    && !hasSelectedConversation
  const activeChatIsPty = activeChatSession?.transportType === 'pty'
    || (activeChatSession?.sessionType as string | undefined) === 'pty'
  const showTerminalSession = activeChatIsPty
  const showGlobalAutomationPanel = isGlobalScope && activeTab === 'automation' && Boolean(globalAutomationPanel)
  const showConversationStreamStatus = Boolean(
    hasSelectedConversation
    && !activeChatSession
    && streamStatus
    && streamStatus !== 'connected',
  )

  async function handleApprove(approval: PendingApproval): Promise<void> {
    try {
      await decisionMutation.mutateAsync({ approval, decision: 'approve' })
    } catch {
      // error is surfaced via decisionMutation.error if needed
    }
  }

  async function handleDeny(approval: PendingApproval): Promise<void> {
    try {
      await decisionMutation.mutateAsync({ approval, decision: 'reject' })
    } catch {
      // error is surfaced via decisionMutation.error if needed
    }
  }

  function renderChatContent() {
    if (showGlobalAutomationPanel) {
      return (
        <div
          data-testid="global-automation-center-panel"
          data-test-id="global-automation-center-panel"
          style={{
            height: '100%',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          {globalAutomationPanel}
        </div>
      )
    }

    if (isGlobalScope) {
      return <EmptyPanel message="Global scope does not support chat." />
    }

    if (conversationLoadError) {
      return (
        <ConversationErrorPanel
          message={conversationLoadError}
          onRetry={onRetryConversations}
        />
      )
    }

    if (needsConversation) {
      return (
        <CreateConversationPanel
          commanderName={commander.name}
          credentialSelectionModes={commander.credentialSelectionModes}
          onCreateChat={onCreateChat}
          createChatPending={createChatPending}
          defaultAgentType={defaultCreateAgentType ?? commander.agentType}
          providerOptions={providerOptions}
        />
      )
    }

    if (showTerminalSession && activeChatSession && onKillSession) {
      return (
        <TerminalView
          sessionName={activeChatSession.id}
          sessionLabel={activeChatSession.label ?? activeChatSession.name}
          agentType={activeChatSession.agentType}
          onClose={onCloseActiveChat ?? (() => undefined)}
          onKill={onKillSession}
          isMobileOverlay={false}
        />
      )
    }

    return (
      <ChatPane
        messages={transcript}
        approvals={activeApprovals}
        onApprove={(approval) => { void handleApprove(approval) }}
        onDeny={(approval) => { void handleDeny(approval) }}
        onAnswer={onAnswer}
        agentAvatarUrl={commander.avatarUrl}
        sessionId={composerSessionName}
        sessionHost={activeChatSession?.host ?? commander.host}
        hasOlderMessages={hasOlderMessages}
        loadingOlderMessages={loadingOlderMessages}
        onLoadOlderMessages={onLoadOlderMessages}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    )
  }

  return (
    <section
      data-testid="command-room-center-column"
      data-test-id="command-room-center-column"
      data-composer-resize-root="desktop-chat-pane"
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--hv-bg)',
        borderRight: '1px solid var(--hv-border-hair)',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {/* ---- scrollable content ---- */}
      <div
        data-testid="command-room-center-scroll"
        data-test-id="command-room-center-scroll"
        className="hv-scroll"
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {/* delegated sub-agents strip */}
        {(subAgents.length > 0 || automationChips.length > 0) && (
          <div
            data-testid="delegated-subagents-strip"
            data-test-id="delegated-subagents-strip"
            style={{
              padding: '22px 32px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
            }}
          >
            <span
              className="font-body"
              style={{
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--hv-fg-faint)',
              }}
            >
              Delegated · {subAgents.length} sub-agents · {automationChips.length} automations
            </span>
            {subAgents.slice(0, 5).map((w) => (
              <SubAgentChip key={w.id} worker={w} />
            ))}
            {automationChips.slice(0, 5).map((automation) => (
              <span
                key={automation.id}
                className="font-mono"
                data-testid="commander-center-automation-chip"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 10px',
                  border: '1px solid var(--hv-border-soft)',
                  borderRadius: '2px 8px 2px 8px',
                  fontSize: 11.5,
                  color: 'var(--hv-fg-muted)',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: STATE_COLOR[automation.state] ?? STATE_COLOR.idle,
                    flexShrink: 0,
                  }}
                />
                {automation.name}
              </span>
            ))}
          </div>
        )}

        {/* tab content */}
        {renderChatContent()}
      </div>

      {!showTerminalSession && !showGlobalAutomationPanel && (
        <div
          style={{
            flexShrink: 0,
            padding: '12px 16px 16px',
            background: 'var(--hv-bg)',
          }}
        >
          {showConversationStreamStatus && streamStatus && streamStatus !== 'connected' && (
            <ConversationStreamStatusNotice status={streamStatus} />
          )}
          <div
            data-testid="compact-chat-composer"
            data-test-id="compact-chat-composer"
            style={{
              overflow: 'hidden',
              border: '1px solid var(--hv-border-soft)',
              borderRadius: '4px 20px 4px 20px',
              background: 'var(--hv-surface-card)',
              boxShadow: 'var(--hv-shadow-block)',
            }}
          >
            <SessionComposer
              sessionName={composerSessionName}
              agentType={commander.agentType}
              theme={theme}
              disabled={!composerEnabled}
              disabledMessage={composerDisabledMessage
                ?? (isGlobalScope
                  ? 'Chat is not available for Global scope.'
                  : needsConversation
                    ? `Create a chat to message ${commander.name}.`
                    : !hasConversation
                      ? 'Select a commander or worker to start chatting.'
                      : undefined)}
              sendReady={composerSendReady}
              contextFilePaths={contextFilePaths}
              contextDirectoryPaths={contextDirectoryPaths}
              contextFileAnnotations={contextFileAnnotations}
              onRemoveContextFilePath={onRemoveContextFilePath}
              onRemoveContextDirectoryPath={onRemoveContextDirectoryPath}
              onRemoveContextFileAnnotation={onRemoveContextFileAnnotation}
              onClearContextFilePaths={onClearContextFilePaths}
              onRestoreContextAttachments={onRestoreContextAttachments}
              onQueue={onQueue}
              onSend={onSend ?? (() => undefined)}
              queueSnapshot={queueSnapshot}
              queueError={queueError}
              isQueueMutating={isQueueMutating}
              onClearQueue={onClearQueue}
              onMoveQueuedMessage={onMoveQueuedMessage}
              onRemoveQueuedMessage={onRemoveQueuedMessage}
              onOpenWorkspace={onOpenWorkspace}
              showWorkspaceShortcut={Boolean(onOpenWorkspace)}
              placeholder={isGlobalScope
                ? 'Global scope does not support chat.'
                : `Send a message to ${commander.name}…`}
            />
          </div>
        </div>
      )}
    </section>
  )
}
