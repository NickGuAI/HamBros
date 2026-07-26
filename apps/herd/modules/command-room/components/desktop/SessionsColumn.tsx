/**
 * SessionsColumn — 232px left panel for the Herd Command Room.
 *
 * Layout:
 *   ┌─────────────────────────────┐
 *   │  COMMANDERS · {count}    [+]│  ← ColumnHeader
 *   ├─────────────────────────────┤
 *   │  [●] hera          2 PEND │  ← Commander SessionRows (always shown)
 *   │  [●] jake                   │
 *   │ ▾ WORKERS · {n}         [⌁] │  ← expanded by default
 *   │   pn-920              2d    │
 *   │   srswworker          1d    │
 *   │ ▸ AUTOMATIONS · {n}         │  ← collapsed by default
 *   ├─────────────────────────────┤
 *   │ live · auto-refresh   A− A+ │  ← font-size control
 *   └─────────────────────────────┘
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Play, Square } from 'lucide-react'
import { useFontScale } from '@/hooks/use-font-scale'
import { getProviderLabel, getProviderModelLabel, useProviderRegistry } from '@/hooks/use-providers'
import { Icon, STATE_COLOR } from '@modules/components/hervald'
import type { AgentSession, AgentType, ProviderRegistryEntry } from '@/types'
import type { AgentEffortLevel } from '@modules/agents/effort.js'
import { SessionCard } from '@modules/agents/page-shell/SessionCard'
import { ModalFormContainer } from '@modules/components/ModalFormContainer'
import type { ClaudeAdaptiveThinkingMode } from '@modules/claude-adaptive-thinking.js'
import { useConversationRuntimeSettings } from '@modules/conversation/hooks/use-conversation-runtime-settings'
import { CredentialPoolSelect } from '@modules/conversation/components/CredentialPoolSelect'
import type {
  ConversationRecord,
  ConversationRuntimeSettingsUpdate,
} from '@modules/conversation/hooks/use-conversations'
import { ColumnHeader } from './ColumnHeader'
import { SessionRow } from './SessionRow'
import type { Commander, Worker, Approval } from './SessionRow'

/** A standalone chat session (non-commander). */
export interface ChatSession extends AgentSession {
  id: string
  /** Human-readable age string, e.g. "2d", "3h". */
  age?: string
  lastActivityAt?: string
  parentCommanderId?: string | null
}

interface SessionsColumnProps {
  selectedCommanderId: string
  onSelectCommander: (id: string) => void
  onCreateCommander: () => void
  onCreateWorker: () => void
  onCreateSession: () => void
  /** Request the provider picker for this commander. Does NOT create a chat. */
  onCreateChatForCommander?: (commanderId: string) => void | Promise<void>
  selectedChatId?: string | null
  onSelectChat: (id: string) => void
  onSelectConversation?: (id: string) => void
  onStartConversation?: (id: string) => void
  onStopConversation?: (id: string) => void | Promise<void>
  onRenameConversation?: (id: string, name: string) => void | Promise<void>
  onUpdateConversationRuntimeSettings?: (
    id: string,
    settings: ConversationRuntimeSettingsUpdate,
  ) => void | Promise<void>
  onArchiveConversation?: (id: string) => void | Promise<void>
  onRemoveConversation?: (id: string) => void | Promise<void>
  commanders: Commander[]
  conversations?: ConversationRecord[]
  workers: Worker[]
  /** Pending approval items. */
  approvals?: Approval[]
  workerSessions?: ChatSession[]
  automationSessions?: ChatSession[]
  cronSessions?: ChatSession[]
  sentinelSessions?: ChatSession[]
  onKillSession?: (sessionId: string, agentType?: AgentType) => Promise<void>
  onResumeSession?: (sessionId: string) => Promise<void>
}

const tinyIconBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--hv-fg-subtle)',
  cursor: 'pointer',
  padding: 2,
  display: 'flex',
  alignItems: 'center',
}

const menuItemStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--hv-fg)',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: '12px',
}

const modalLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 13,
  color: 'var(--hv-fg)',
}

const modalInputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid var(--hv-border-hair)',
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--hv-fg)',
  background: 'var(--hv-bg-raised)',
}

const SUMI_BUTTON_RADIUS = '2px 12px 2px 12px'

const modalActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
}

const modalSecondaryButtonStyle: React.CSSProperties = {
  borderRadius: 999,
  border: '1px solid var(--hv-border-hair)',
  padding: '8px 14px',
  background: 'transparent',
  color: 'var(--hv-fg-subtle)',
  cursor: 'pointer',
  fontSize: 12,
}

const modalPrimaryButtonStyle: React.CSSProperties = {
  borderRadius: 999,
  border: '1px solid transparent',
  padding: '8px 14px',
  background: 'var(--sumi-black)',
  color: 'var(--washi-white)',
  cursor: 'pointer',
  fontSize: 12,
}

type SectionKey = 'workers' | 'automation'
type ConversationProviderOption = ProviderRegistryEntry

const chatSettingsLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  color: 'var(--hv-fg-subtle)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const chatSettingsSelectStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  border: '1px solid var(--hv-border-hair)',
  borderRadius: 8,
  background: 'var(--hv-bg)',
  color: 'var(--hv-fg)',
  fontSize: 12,
  padding: '7px 8px',
}

const chatLifecycleButtonStyle: React.CSSProperties = {
  background: 'var(--hv-bg)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--hv-border-firm)',
  borderRadius: SUMI_BUTTON_RADIUS,
  boxShadow: '2px 2px 0 var(--hv-ink-wash-03)',
  color: 'var(--hv-fg)',
  cursor: 'pointer',
  padding: '4px 9px',
  fontSize: 'calc(10.5px * var(--hv-font-scale, 1))',
  letterSpacing: '0.04em',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 160ms var(--hv-ease-gentle), box-shadow 160ms var(--hv-ease-gentle)',
}
const COLLAPSE_STORAGE_KEY = 'hervald-sessions-collapsed'
const SHOW_EXITED_STORAGE_KEY = 'hervald-sessions-show-exited'
const DEFAULT_COLLAPSED: Record<SectionKey, boolean> = {
  workers: false,
  automation: true,
}
const DEFAULT_SHOW_EXITED: Record<SectionKey, boolean> = {
  workers: false,
  automation: false,
}
const EXITED_SESSION_STATUSES = new Set(['exited', 'completed'])

function isVisibleChatSession(session: ChatSession): boolean {
  if (session.state) {
    return session.state !== 'archived'
  }
  return !EXITED_SESSION_STATUSES.has(session.status ?? '')
}

function readCollapsedState(): Record<SectionKey, boolean> {
  if (typeof window === 'undefined') return { ...DEFAULT_COLLAPSED }
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_COLLAPSED }
    const parsed = JSON.parse(raw) as Partial<Record<SectionKey, unknown>>
    return {
      workers: typeof parsed.workers === 'boolean' ? parsed.workers : DEFAULT_COLLAPSED.workers,
      automation:
        typeof parsed.automation === 'boolean'
          ? parsed.automation
          : typeof (parsed as Record<string, unknown>).cron === 'boolean'
            ? Boolean((parsed as Record<string, unknown>).cron)
            : typeof (parsed as Record<string, unknown>).sentinel === 'boolean'
              ? Boolean((parsed as Record<string, unknown>).sentinel)
              : DEFAULT_COLLAPSED.automation,
    }
  } catch {
    return { ...DEFAULT_COLLAPSED }
  }
}

function readShowExitedState(): Record<SectionKey, boolean> {
  if (typeof window === 'undefined') return { ...DEFAULT_SHOW_EXITED }
  try {
    const raw = window.localStorage.getItem(SHOW_EXITED_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SHOW_EXITED }
    const parsed = JSON.parse(raw) as Partial<Record<SectionKey, unknown>>
    return {
      workers: typeof parsed.workers === 'boolean' ? parsed.workers : DEFAULT_SHOW_EXITED.workers,
      automation:
        typeof parsed.automation === 'boolean'
          ? parsed.automation
          : typeof (parsed as Record<string, unknown>).cron === 'boolean'
            ? Boolean((parsed as Record<string, unknown>).cron)
            : typeof (parsed as Record<string, unknown>).sentinel === 'boolean'
              ? Boolean((parsed as Record<string, unknown>).sentinel)
              : DEFAULT_SHOW_EXITED.automation,
    }
  } catch {
    return { ...DEFAULT_SHOW_EXITED }
  }
}

interface SessionListSectionProps {
  label: string
  sessions: ChatSession[]
  collapsed: boolean
  onToggle: () => void
  headerAction?: ReactNode
  showExited: boolean
  onToggleShowExited: () => void
  selectedChatId: string | null
  onSelectChat: (id: string) => void
  variant?: 'button' | 'session-card'
  sessionCardVariant?: 'card' | 'row'
  onKillSession?: (sessionId: string, agentType?: AgentType) => Promise<void>
  onResumeSession?: (sessionId: string) => Promise<void>
}

function SessionListSection({
  label,
  sessions,
  collapsed,
  onToggle,
  headerAction,
  showExited,
  onToggleShowExited,
  selectedChatId,
  onSelectChat,
  variant = 'button',
  sessionCardVariant = 'card',
  onKillSession,
  onResumeSession,
}: SessionListSectionProps) {
  if (sessions.length === 0 && !headerAction) return null
  const visibleSessions = showExited
    ? sessions
    : sessions.filter(isVisibleChatSession)

  return (
    <>
      <div
        style={{
          width: '100%',
          padding: '22px 20px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button
          className="font-body"
          type="button"
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            color: 'var(--hv-fg-faint)',
            fontSize: 'calc(10.5px * var(--hv-font-scale, 1))',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            textAlign: 'left',
            padding: 0,
          }}
        >
          <span style={{ fontSize: 10, width: 8 }}>{collapsed ? '▸' : '▾'}</span>
          <span>{label}</span>
          <span>· {visibleSessions.length}</span>
        </button>
        {headerAction}
        {sessions.length > 0 && (
          <button
            className="font-body"
            type="button"
            onClick={onToggleShowExited}
            aria-pressed={showExited}
            aria-label={`${showExited ? 'Hide' : 'Show'} exited ${label.toLowerCase()} sessions`}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--hv-fg-subtle)',
              fontSize: 'calc(10px * var(--hv-font-scale, 1))',
              letterSpacing: '0.02em',
              cursor: 'pointer',
              padding: 0,
              textTransform: 'none',
              flexShrink: 0,
            }}
          >
            {showExited ? 'hide exited' : 'show exited'}
          </button>
        )}
      </div>

      {!collapsed &&
        visibleSessions.map((s) => (
          variant === 'session-card' && onKillSession && onResumeSession ? (
            <div
              key={s.id}
              style={{
                padding: '8px 16px 0',
              }}
            >
              <SessionCard
                session={s}
                selected={selectedChatId === s.id}
                variant={sessionCardVariant}
                onSelect={() => onSelectChat(s.id)}
                onKill={() => onKillSession(s.id, s.agentType)}
                onResume={() => onResumeSession(s.id)}
                onNavigateToSession={onSelectChat}
              />
            </div>
          ) : (
            <button
              className="font-mono"
              key={s.id}
              type="button"
              onClick={() => onSelectChat(s.id)}
              style={{
                width: '100%',
                padding: '6px 20px 6px 34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background:
                  selectedChatId === s.id ? 'var(--hv-ink-wash-02)' : 'transparent',
                borderLeft:
                  selectedChatId === s.id
                    ? '2px solid var(--sumi-black)'
                    : '2px solid transparent',
                borderTop: 'none',
                borderRight: 'none',
                borderBottom: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 'calc(12px * var(--hv-font-scale, 1))',
                color:
                  selectedChatId === s.id ? 'var(--hv-fg)' : 'var(--hv-fg-faint)',
                gap: 8,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: STATE_COLOR[s.status ?? 'idle'] ?? STATE_COLOR.idle,
                    marginRight: 8,
                    flexShrink: 0,
                  }}
                  aria-hidden
                />
                <span
                  title={s.label ?? s.name}
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {s.label ?? s.name}
                </span>
              </span>
              {s.age && (
                <span
                  style={{
                    fontSize: 'calc(10.5px * var(--hv-font-scale, 1))',
                    letterSpacing: '0.02em',
                    marginLeft: 8,
                    flexShrink: 0,
                  }}
                >
                  {s.age}
                </span>
              )}
            </button>
          )
        ))}
    </>
  )
}

function formatConversationLabel(conversation: ConversationRecord): string {
  const name = typeof conversation.name === 'string' ? conversation.name.trim() : ''
  return name || `chat ${conversation.id.slice(0, 8)}`
}

function formatConversationMeta(
  conversation: ConversationRecord,
  providerOptions: ReadonlyArray<ConversationProviderOption>,
): string {
  const provider = conversation.liveSession?.agentType ?? conversation.agentType ?? null
  const providerEntry = providerOptions.find((option) => option.id === provider) ?? null
  const model = conversation.liveSession
    ? conversation.liveSession.model
      ?? providerEntry?.defaults?.model
      ?? providerEntry?.availableModels?.find((option) => option.default)?.id
    : conversation.model
  const providerLabel = provider ? getProviderLabel(providerOptions, provider) : 'Unassigned'
  const modelLabel = getProviderModelLabel(providerOptions, provider, model)
  const providerMeta = modelLabel ? `${modelLabel} · ${providerLabel}` : providerLabel
  const taskTitle = conversation.currentTask?.title?.trim()
  if (taskTitle) {
    return `${providerMeta} · ${taskTitle}`
  }
  return `${providerMeta} · ${conversation.surface} · ${conversation.id.slice(0, 8)}`
}

function hasConversationAction(
  conversation: ConversationRecord,
  action: keyof NonNullable<ConversationRecord['allowedActions']>,
): boolean {
  return conversation.allowedActions?.[action] === true
}

function conversationHasStoppableRuntime(conversation: ConversationRecord): boolean {
  const runtimeState = conversation.displayState?.runtimeState ?? conversation.runtimeState
  const hasLiveSession = conversation.displayState
    ? conversation.displayState.hasLiveSession
    : Boolean(conversation.liveSession) || conversation.status === 'active'
  return runtimeState === 'starting' || (conversation.status === 'active' && hasLiveSession)
}

function resolveConversationLifecycleAction(conversation: ConversationRecord): 'start' | 'stop' | null {
  const canStop = hasConversationAction(conversation, 'pause') && conversationHasStoppableRuntime(conversation)
  if (canStop) {
    return 'stop'
  }

  if (hasConversationAction(conversation, 'resume') || hasConversationAction(conversation, 'start')) {
    return 'start'
  }

  return null
}

interface ConversationChatRowProps {
  conversation: ConversationRecord
  selected: boolean
  approvalCount?: number
  onSelect?: (id: string) => void
  onStart?: (id: string) => void
  onStop?: (id: string) => void | Promise<void>
  onRename?: (id: string, name: string) => void | Promise<void>
  onUpdateRuntimeSettings?: (
    id: string,
    settings: ConversationRuntimeSettingsUpdate,
  ) => void | Promise<void>
  onRefreshModels?: (providerId: AgentType, credentialPoolId?: string) => void | Promise<void>
  refreshingProviderId?: AgentType | null
  onArchive?: (id: string) => void | Promise<void>
  onRemove?: (id: string) => void | Promise<void>
  providerOptions?: ReadonlyArray<ConversationProviderOption>
}

function approvalMatchesConversationRow(approval: Approval, conversation: ConversationRecord): boolean {
  const approvalConversationId = approval.conversationId?.trim()
  if (approvalConversationId) {
    return approvalConversationId === conversation.id
  }

  const approvalSessionName = approval.sessionName?.trim()
  if (!approvalSessionName) {
    return false
  }

  return approvalSessionName === conversation.sendTarget?.sessionName
    || approvalSessionName === conversation.liveSession?.name
}

function CommanderNewChatRow({
  commander,
  onCreateChat,
}: {
  commander: Commander
  onCreateChat: () => void | Promise<void>
}) {
  return (
    <div
      data-testid="commander-new-chat-row"
      data-commander-id={commander.id}
      style={{
        width: '100%',
        padding: '6px 20px 6px 34px',
      }}
    >
      <button
        className="font-body"
        type="button"
        data-testid="commander-new-chat-button"
        data-test-id="commander-new-chat-button"
        onClick={() => {
          void onCreateChat()
        }}
        aria-label={`New chat for ${commander.name}`}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 8,
          background: 'var(--hv-surface-card)',
          borderWidth: 2,
          borderStyle: 'solid',
          borderColor: 'var(--hv-fg)',
          borderRadius: 'var(--hv-radius-sharp)',
          color: 'var(--hv-fg)',
          boxShadow: '2px 2px 0 var(--hv-ink-wash-03)',
          cursor: 'pointer',
          padding: '8px 10px',
          fontSize: 'calc(12px * var(--hv-font-scale, 1))',
          fontWeight: 400,
          letterSpacing: 0,
          textTransform: 'none',
        }}
      >
        <Icon name="plus" size={12} />
        <span>New Chat</span>
      </button>
    </div>
  )
}

function CommanderTeamDropdown({
  commander,
  workers,
  automationSessions,
  approvals,
  onSelectChat,
}: {
  commander: Commander
  workers: Worker[]
  automationSessions: ChatSession[]
  approvals: Approval[]
  onSelectChat?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const teamMembers = workers.filter((worker) => (
    (worker.kind === 'worker' || worker.kind === 'tool')
    && worker.creator?.kind === 'commander'
    && worker.creator.id === commander.id
  ))
  const commanderAutomationSessions = automationSessions.filter(
    (session) => session.parentCommanderId === commander.id,
  )
  const totalMembers = teamMembers.length + commanderAutomationSessions.length

  if (commander.isVirtual) {
    return null
  }

  return (
    <div data-testid="commander-team-dropdown" data-commander-id={commander.id}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 20px 7px 34px',
          border: 'none',
          background: 'transparent',
          color: 'var(--hv-fg-subtle)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 'calc(10.5px * var(--hv-font-scale, 1))',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ fontSize: 10, width: 8 }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>Team</span>
        <span>· {totalMembers}</span>
        {approvals.length > 0 && (
          <span style={{ color: 'var(--vermillion-seal)' }}>{approvals.length}</span>
        )}
      </button>
      {open && (
        <div style={{ padding: '0 20px 6px 48px' }}>
          <div
            className="font-body"
            style={{
              padding: '4px 0',
              color: 'var(--hv-fg-subtle)',
              fontSize: 'calc(10px * var(--hv-font-scale, 1))',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Workers
          </div>
          {teamMembers.length > 0 ? teamMembers.map((worker) => (
            <div
              key={worker.id}
              className="font-mono"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '5px 0',
                color: 'var(--hv-fg-faint)',
                fontSize: 'calc(11px * var(--hv-font-scale, 1))',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {worker.label ?? worker.name}
              </span>
              <span style={{ flexShrink: 0 }}>{worker.state}</span>
            </div>
          )) : (
            <div
              style={{
                padding: '4px 0 8px',
                color: 'var(--hv-fg-faint)',
                fontSize: 'calc(11px * var(--hv-font-scale, 1))',
              }}
            >
              No delegated workers.
            </div>
          )}

          <div
            className="font-body"
            style={{
              padding: '10px 0 4px',
              color: 'var(--hv-fg-subtle)',
              fontSize: 'calc(10px * var(--hv-font-scale, 1))',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Automations
          </div>
          {commanderAutomationSessions.length > 0 ? commanderAutomationSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="font-mono"
              data-testid="commander-team-automation-row"
              onClick={() => onSelectChat?.(session.id)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '5px 0',
                border: 'none',
                background: 'transparent',
                color: 'var(--hv-fg-faint)',
                cursor: onSelectChat ? 'pointer' : 'default',
                textAlign: 'left',
                fontSize: 'calc(11px * var(--hv-font-scale, 1))',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.label ?? session.name}
              </span>
              <span style={{ flexShrink: 0 }}>{session.status ?? 'idle'}</span>
            </button>
          )) : (
            <div
              style={{
                padding: '4px 0 8px',
                color: 'var(--hv-fg-faint)',
                fontSize: 'calc(11px * var(--hv-font-scale, 1))',
              }}
            >
              No commander-local automations.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Per-commander chat row rendered nested inside a `commander-block`. The
 * Start button does a one-click resume — it does NOT open a wizard.
 */
function ConversationChatRow({
  conversation,
  selected,
  approvalCount = 0,
  onSelect,
  onStart,
  onStop,
  onRename,
  onUpdateRuntimeSettings,
  onRefreshModels,
  refreshingProviderId = null,
  onArchive,
  onRemove,
  providerOptions = [],
}: ConversationChatRowProps) {
  const lifecycleAction = resolveConversationLifecycleAction(conversation)
  const hasPendingApproval = approvalCount > 0
  const displayStatus = conversation.displayState?.status ?? conversation.status
  const disabledLifecycleAction = lifecycleAction === null
    ? displayStatus === 'active'
      ? 'stop'
      : displayStatus === 'idle'
        ? 'start'
        : null
    : null
  const runtimeSettings = useConversationRuntimeSettings(
    conversation,
    providerOptions,
  )
  const canShowRuntimeSettings = Boolean(conversation.runtimeSettings && onUpdateRuntimeSettings)
  const conversationName = typeof conversation.name === 'string' ? conversation.name : ''
  const conversationLabel = formatConversationLabel(conversation)
  const [menuOpen, setMenuOpen] = useState(false)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState(conversationName)
  const [renameBusy, setRenameBusy] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeBusy, setRemoveBusy] = useState(false)

  useEffect(() => {
    setRenameDraft(conversationName)
  }, [conversationName])

  const canArchive = hasConversationAction(conversation, 'archive')
  const canRemove = hasConversationAction(conversation, 'delete')
  const hasActions = Boolean(onRename || canShowRuntimeSettings || (canArchive && onArchive) || (canRemove && onRemove))
  const conversationMeta = formatConversationMeta(conversation, providerOptions)

  async function handleRenameSubmit(): Promise<void> {
    if (!onRename) {
      return
    }
    setRenameBusy(true)
    try {
      await onRename(conversation.id, renameDraft)
      setRenameOpen(false)
      setMenuOpen(false)
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleSaveRuntimeSettings(): Promise<void> {
    if (!onUpdateRuntimeSettings || !runtimeSettings.payload || !runtimeSettings.canSave) {
      return
    }
    setProviderBusy(true)
    try {
      await onUpdateRuntimeSettings(conversation.id, runtimeSettings.payload)
      setProviderMenuOpen(false)
      setMenuOpen(false)
    } finally {
      setProviderBusy(false)
    }
  }

  async function handleArchive(): Promise<void> {
    if (!onArchive) {
      return
    }
    await onArchive(conversation.id)
    setMenuOpen(false)
  }

  async function handleRemoveSubmit(): Promise<void> {
    if (!onRemove) {
      return
    }
    setRemoveBusy(true)
    try {
      await onRemove(conversation.id)
      setRemoveOpen(false)
      setMenuOpen(false)
    } finally {
      setRemoveBusy(false)
    }
  }

  return (
    <>
      <div
        data-testid="commander-chat-row"
        data-conversation-id={conversation.id}
        data-conversation-status={conversation.status}
        data-has-pending-approval={hasPendingApproval ? 'true' : 'false'}
        data-approval-count={approvalCount}
        style={{
          position: 'relative',
          width: '100%',
          padding: '6px 20px 6px 34px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: hasPendingApproval
            ? 'var(--hv-accent-danger-wash)'
            : selected
              ? 'var(--hv-ink-wash-02)'
              : 'transparent',
          borderLeft: hasPendingApproval
            ? '2px solid var(--hv-accent-danger)'
            : selected
              ? '2px solid var(--sumi-black)'
              : '2px solid transparent',
          boxShadow: hasPendingApproval
            ? 'inset 0 0 0 1px var(--hv-accent-danger)'
            : 'none',
        }}
      >
        <button
          type="button"
          data-testid="commander-chat-row-button"
          onClick={() => onSelect?.(conversation.id)}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            border: 'none',
            cursor: onSelect ? 'pointer' : 'default',
            padding: 0,
            textAlign: 'left',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: STATE_COLOR[conversation.status] ?? STATE_COLOR.idle,
              flexShrink: 0,
            }}
          />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span
              className="font-mono"
              data-testid="commander-chat-row-label"
              style={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 'calc(11.5px * var(--hv-font-scale, 1))',
                color: selected ? 'var(--hv-fg)' : 'var(--hv-fg-faint)',
              }}
            >
              {conversationLabel}
            </span>
            <span
              className="font-body"
              data-testid="commander-chat-row-meta"
              title={conversationMeta}
              style={{
                display: 'block',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 'calc(10px * var(--hv-font-scale, 1))',
                color: 'var(--hv-fg-subtle)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              {conversationMeta}
            </span>
          </span>
        </button>

        {hasPendingApproval && (
          <span
            className="font-body"
            data-testid="commander-chat-approval-count"
            style={{
              flexShrink: 0,
              borderRadius: '2px 6px 2px 6px',
              background: 'var(--hv-bg)',
              border: '1px solid var(--hv-accent-danger)',
              color: 'var(--hv-accent-danger)',
              fontSize: 'calc(9px * var(--hv-font-scale, 1))',
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '1px 5px',
              textTransform: 'uppercase',
            }}
          >
            {approvalCount}
          </span>
        )}

        {lifecycleAction === 'start' && onStart && (
          <button
            className="font-mono"
            type="button"
            data-testid="commander-chat-start-button"
            aria-label="Start chat"
            onClick={(event) => {
              event.stopPropagation()
              onStart(conversation.id)
            }}
            style={{
              ...chatLifecycleButtonStyle,
            }}
          >
            <Play size={14} aria-hidden="true" />
          </button>
        )}

        {lifecycleAction === 'stop' && onStop && (
          <button
            className="font-mono"
            type="button"
            data-testid="commander-chat-stop-button"
            aria-label="Stop chat"
            onClick={(event) => {
              event.stopPropagation()
              void onStop(conversation.id)
            }}
            style={{
              ...chatLifecycleButtonStyle,
            }}
          >
            <Square size={14} aria-hidden="true" />
          </button>
        )}

        {disabledLifecycleAction && (
          <button
            className="font-mono"
            type="button"
            data-testid="commander-chat-disabled-lifecycle-button"
            aria-label={disabledLifecycleAction === 'stop' ? 'Stop chat unavailable' : 'Start chat unavailable'}
            disabled
            style={{
              ...chatLifecycleButtonStyle,
              cursor: 'not-allowed',
              opacity: 0.38,
            }}
          >
            {disabledLifecycleAction === 'stop'
              ? <Square size={14} aria-hidden="true" />
              : <Play size={14} aria-hidden="true" />}
          </button>
        )}

        {hasActions && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              data-testid="commander-chat-actions-button"
              aria-label={`Actions for ${conversationLabel}`}
              onClick={(event) => {
                event.stopPropagation()
                setMenuOpen((current) => !current)
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: SUMI_BUTTON_RADIUS,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--hv-border-firm)',
                background: 'var(--hv-bg)',
                color: 'var(--hv-fg)',
                boxShadow: '2px 2px 0 var(--hv-ink-wash-03)',
                cursor: 'pointer',
                transition: 'background 160ms var(--hv-ease-gentle), box-shadow 160ms var(--hv-ease-gentle)',
              }}
            >
              <Icon name="more" size={12} />
            </button>

            {menuOpen && (
              <>
                <button
                  type="button"
                  aria-label={`Close actions for ${conversationLabel}`}
                  onClick={() => {
                    setMenuOpen(false)
                    setProviderMenuOpen(false)
                  }}
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    zIndex: 20,
                  }}
                />
                <div
                  data-testid="commander-chat-actions-menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    zIndex: 21,
                    minWidth: 188,
                    padding: 6,
                    borderRadius: 12,
                    border: '1px solid var(--hv-border-hair)',
                    background: 'var(--hv-bg-raised)',
                    boxShadow: 'var(--hv-shadow-float)',
                  }}
                >
                  {onRename && (
                    <button
                      type="button"
                      data-testid="commander-chat-rename-button"
                      onClick={() => {
                        setRenameDraft(conversationName)
                        setRenameOpen(true)
                        setProviderMenuOpen(false)
                      }}
                      style={menuItemStyle}
                    >
                      Rename
                    </button>
                  )}

                  {canShowRuntimeSettings && (
                    <>
                      <button
                        type="button"
                        data-testid="commander-chat-provider-menu-button"
                        onClick={() => setProviderMenuOpen((current) => !current)}
                        style={menuItemStyle}
                      >
                        <span>Runtime settings</span>
                        <span style={{ marginLeft: 'auto' }}>{providerMenuOpen ? '▾' : '▸'}</span>
                      </button>
                      {providerMenuOpen && (
                        <div
                          data-testid="commander-chat-provider-menu"
                          style={{
                            display: 'grid',
                            gap: 8,
                            marginTop: 4,
                            padding: '8px 0 2px 10px',
                            borderTop: '1px solid var(--hv-border-hair)',
                          }}
                        >
                          <label style={chatSettingsLabelStyle}>
                            <span>Provider</span>
                            <select
                              data-testid="commander-chat-provider-select"
                              value={runtimeSettings.draft?.agentType ?? ''}
                              onChange={(event) => runtimeSettings.setAgentType(event.target.value as AgentType)}
                              disabled={providerBusy || !runtimeSettings.settings?.allowed}
                              style={chatSettingsSelectStyle}
                            >
                              {runtimeSettings.providerOptions.map((provider) => (
                                <option key={provider.id} value={provider.id}>{provider.label}</option>
                              ))}
                            </select>
                          </label>
                          {runtimeSettings.credentialSelectionMode === 'per-conversation' ? (
                            <label style={chatSettingsLabelStyle}>
                              <span>Credential</span>
                              <CredentialPoolSelect
                                provider={runtimeSettings.draft?.agentType}
                                credentialSelectionMode={runtimeSettings.credentialSelectionMode}
                                value={runtimeSettings.selectedCredentialPoolId}
                                currentCredentialPoolId={runtimeSettings.currentCredentialPoolId}
                                onChange={runtimeSettings.setCredentialPoolId}
                                disabled={providerBusy || !runtimeSettings.settings?.allowed}
                                dataTestId="commander-chat-credential-select"
                                style={chatSettingsSelectStyle}
                              />
                            </label>
                          ) : null}
                          <label style={chatSettingsLabelStyle}>
                            <span>Model</span>
                            <select
                              data-testid="commander-chat-model-select"
                              value={runtimeSettings.selectedModelValue}
                              onChange={(event) => runtimeSettings.setModel(event.target.value || null)}
                              disabled={providerBusy || !runtimeSettings.settings?.allowed}
                              style={chatSettingsSelectStyle}
                            >
                              <option value="">Adapter default</option>
                              {runtimeSettings.modelOptions.map((option) => (
                                <option key={option.id} value={option.id}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                          {runtimeSettings.supportsEffort && (
                            <label style={chatSettingsLabelStyle}>
                              <span>Effort</span>
                              <select
                                data-testid="commander-chat-effort-select"
                                value={runtimeSettings.draft?.effort ?? ''}
                                onChange={(event) => runtimeSettings.setEffort(
                                  event.target.value as AgentEffortLevel,
                                )}
                                disabled={providerBusy || !runtimeSettings.settings?.allowed}
                                style={chatSettingsSelectStyle}
                              >
                                {runtimeSettings.draft?.effort === null
                                  ? <option value="">Provider default</option>
                                  : null}
                                {runtimeSettings.effortOptions.map((effort) => (
                                  <option key={effort} value={effort}>{effort}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {runtimeSettings.supportsAdaptiveThinking && (
                            <label style={chatSettingsLabelStyle}>
                              <span>Adaptive thinking</span>
                              <select
                                data-testid="commander-chat-adaptive-thinking-select"
                                value={runtimeSettings.draft?.adaptiveThinking ?? ''}
                                onChange={(event) => runtimeSettings.setAdaptiveThinking(
                                  event.target.value as ClaudeAdaptiveThinkingMode,
                                )}
                                disabled={providerBusy || !runtimeSettings.settings?.allowed}
                                style={chatSettingsSelectStyle}
                              >
                                {runtimeSettings.adaptiveThinkingOptions.map((mode) => (
                                  <option key={mode} value={mode}>{mode}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          {runtimeSettings.supportsMaxThinkingTokens && runtimeSettings.maxThinkingTokensRange && (
                            <label style={chatSettingsLabelStyle}>
                              <span>Max thinking tokens</span>
                              <input
                                type="number"
                                data-testid="commander-chat-max-thinking-tokens-input"
                                min={runtimeSettings.maxThinkingTokensRange.min}
                                max={runtimeSettings.maxThinkingTokensRange.max}
                                value={runtimeSettings.draft?.maxThinkingTokens ?? ''}
                                onChange={(event) => runtimeSettings.setMaxThinkingTokens(event.currentTarget.valueAsNumber)}
                                disabled={providerBusy || !runtimeSettings.settings?.allowed}
                                style={chatSettingsSelectStyle}
                              />
                            </label>
                          )}
                          {runtimeSettings.modelDiscovery && (
                            <div
                              data-testid="commander-chat-model-discovery-state"
                              style={{ color: 'var(--hv-fg-subtle)', fontSize: 10 }}
                            >
                              Models: {runtimeSettings.modelDiscovery.freshness}
                              {runtimeSettings.modelDiscovery.error
                                ? ` · ${runtimeSettings.modelDiscovery.error}`
                                : ''}
                            </div>
                          )}
                          {runtimeSettings.settings?.disabledReason && (
                            <div
                              data-testid="commander-chat-runtime-settings-disabled-reason"
                              style={{ color: 'var(--hv-accent-warning)', fontSize: 10 }}
                            >
                              {runtimeSettings.settings.disabledReason}
                            </div>
                          )}
                          {onRefreshModels && runtimeSettings.draft && (
                            <button
                              type="button"
                              data-testid="commander-chat-model-refresh-button"
                              onClick={() => {
                                void onRefreshModels(
                                  runtimeSettings.draft!.agentType,
                                  runtimeSettings.modelCredentialPoolId,
                                )
                              }}
                              disabled={providerBusy || refreshingProviderId === runtimeSettings.draft.agentType}
                              style={{ ...menuItemStyle, justifyContent: 'center' }}
                            >
                              {refreshingProviderId === runtimeSettings.draft.agentType ? 'Refreshing…' : 'Refresh models'}
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="commander-chat-provider-save-button"
                            onClick={() => {
                              void handleSaveRuntimeSettings()
                            }}
                            disabled={providerBusy || !runtimeSettings.canSave}
                            style={{
                              ...menuItemStyle,
                              justifyContent: 'center',
                              border: '1px solid var(--hv-border-hair)',
                              background: 'var(--sumi-black)',
                              color: 'var(--washi-white)',
                              cursor: providerBusy || !runtimeSettings.canSave ? 'not-allowed' : 'pointer',
                              opacity: providerBusy || !runtimeSettings.canSave ? 0.5 : 1,
                            }}
                          >
                            {providerBusy ? 'Saving' : 'Save'}
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {canArchive && onArchive && (
                    <button
                      type="button"
                      data-testid="commander-chat-archive-button"
                      onClick={() => {
                        void handleArchive()
                      }}
                      style={menuItemStyle}
                    >
                      Archive
                    </button>
                  )}

                  {canRemove && onRemove && (
                    <button
                      type="button"
                      data-testid="commander-chat-remove-button"
                      onClick={() => {
                        setRemoveOpen(true)
                        setProviderMenuOpen(false)
                      }}
                      style={{
                        ...menuItemStyle,
                        color: 'var(--vermillion-seal)',
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <ModalFormContainer
        open={renameOpen}
        title="Rename chat"
        onClose={() => {
          if (renameBusy) {
            return
          }
          setRenameOpen(false)
        }}
        contentClassName="max-w-md"
      >
        <div data-testid="commander-chat-rename-modal" style={{ display: 'grid', gap: 12 }}>
          <label style={modalLabelStyle}>
            <span>Name</span>
            <input
              data-testid="commander-chat-rename-input"
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              style={modalInputStyle}
            />
          </label>
          <div style={modalActionsStyle}>
            <button
              type="button"
              data-testid="commander-chat-rename-cancel-button"
              onClick={() => setRenameOpen(false)}
              style={modalSecondaryButtonStyle}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="commander-chat-rename-submit-button"
              onClick={() => {
                void handleRenameSubmit()
              }}
              disabled={renameBusy || renameDraft.trim().length === 0}
              style={modalPrimaryButtonStyle}
            >
              Save
            </button>
          </div>
        </div>
      </ModalFormContainer>

      <ModalFormContainer
        open={removeOpen}
        title="Remove chat"
        onClose={() => {
          if (removeBusy) {
            return
          }
          setRemoveOpen(false)
        }}
        contentClassName="max-w-md"
      >
        <div data-testid="commander-chat-remove-modal" style={{ display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, color: 'var(--hv-fg-subtle)', lineHeight: 1.5 }}>
            Remove <strong>{conversationLabel}</strong> and its transcript files?
          </p>
          <p style={{ margin: 0, color: 'var(--hv-fg-subtle)', lineHeight: 1.5 }}>
            This permanently deletes the chat and cannot be undone.
          </p>
          <div style={modalActionsStyle}>
            <button
              type="button"
              data-testid="commander-chat-remove-cancel-button"
              onClick={() => setRemoveOpen(false)}
              style={modalSecondaryButtonStyle}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="commander-chat-remove-submit-button"
              onClick={() => {
                void handleRemoveSubmit()
              }}
              disabled={removeBusy}
              style={{
                ...modalPrimaryButtonStyle,
                background: 'var(--vermillion-seal)',
              }}
            >
              {removeBusy ? 'Removing...' : 'Remove forever'}
            </button>
          </div>
        </div>
      </ModalFormContainer>
    </>
  )
}

export function SessionsColumn({
  selectedCommanderId,
  onSelectCommander,
  onCreateCommander,
  onCreateWorker,
  onCreateSession,
  onCreateChatForCommander,
  selectedChatId = null,
  onSelectChat,
  onSelectConversation,
  onStartConversation,
  onStopConversation,
  onRenameConversation,
  onUpdateConversationRuntimeSettings,
  onArchiveConversation,
  onRemoveConversation,
  commanders,
  conversations = [],
  workers,
  approvals = [],
  workerSessions = [],
  automationSessions = [],
  cronSessions = [],
  sentinelSessions = [],
  onKillSession,
  onResumeSession,
}: SessionsColumnProps) {
  const {
    data: providers = [],
    refreshModels,
    refreshingProviderId,
  } = useProviderRegistry()
  const providerOptions = providers
  const commanderCount = commanders.filter((commander) => !commander.isVirtual).length

  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(readCollapsedState)
  const [showExited, setShowExited] = useState<Record<SectionKey, boolean>>(readShowExitedState)
  const {
    fontScale,
    adjustFontScale,
    minFontScale,
    maxFontScale,
    fontScaleStep,
    isSaving: isFontScaleSaving,
  } = useFontScale()
  const globalAutomationSessions = automationSessions.filter(
    (session) => session.creator?.kind === 'automation'
      ? session.parentCommanderId === null
      : session.parentCommanderId == null,
  )
  const mergedAutomationSessions = automationSessions.length > 0
    ? globalAutomationSessions
    : [...cronSessions, ...sentinelSessions]

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapsed))
    } catch {
      // ignore
    }
  }, [collapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem(SHOW_EXITED_STORAGE_KEY, JSON.stringify(showExited))
    } catch {
      // ignore
    }
  }, [showExited])

  const toggle = useCallback((key: SectionKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const toggleShowExited = useCallback((key: SectionKey) => {
    setShowExited((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const canDecreaseFontScale = fontScale > minFontScale + 1e-6
  const canIncreaseFontScale = fontScale < maxFontScale - 1e-6

  return (
    <aside
      data-testid="sessions-column"
      data-test-id="sessions-column"
      style={
        {
          width: 232,
          background: 'var(--hv-bg-raised)',
          borderRight: '1px solid var(--hv-border-hair)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        } as React.CSSProperties
      }
    >
      {/* Header */}
      <ColumnHeader
        label={
          <>
            COMMANDERS
            <span style={{ color: 'var(--hv-fg-faint)', marginLeft: 6 }}>
              · {commanderCount}
            </span>
          </>
        }
        right={
          <button
            style={tinyIconBtn}
            type="button"
            aria-label="New commander"
            onClick={onCreateCommander}
          >
            <Icon name="plus" size={13} />
          </button>
        }
      />

      {/* Scrollable session list */}
      <div
        data-testid="sessions-scroll"
        data-test-id="sessions-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0 20px',
        }}
      >
        {/* Section 1 — Commanders (always visible). Each commander's chats are
            rendered nested under that commander when the commander is selected. */}
        <div data-testid="commanders-list" data-test-id="commanders-list">
          {commanders.map((c) => {
            const isSelected = selectedCommanderId === c.id
            const canCreateChat = isSelected && !c.isVirtual && Boolean(onCreateChatForCommander)
            const commanderConversations = isSelected
              ? conversations.filter((conv) => (
                conv.commanderId === c.id
                && conv.isDefaultConversation !== true
              ))
              : []

            return (
              <div
                key={c.id}
                data-testid="commander-block"
                data-test-id="commander-block"
                data-commander-id={c.id}
              >
                <SessionRow
                  commander={c}
                  selected={isSelected}
                  onClick={() => onSelectCommander(c.id)}
                  approvals={approvals.filter((a) => a.commanderId === c.id)}
                />

                {isSelected && (
                  <CommanderTeamDropdown
                    commander={c}
                    workers={workers}
                    automationSessions={automationSessions}
                    approvals={approvals.filter((a) => a.commanderId === c.id)}
                    onSelectChat={onSelectChat}
                  />
                )}

                {isSelected && commanderConversations.length > 0 && (
                  <div
                    data-testid="commander-chat-list"
                    data-test-id="commander-chat-list"
                    data-commander-id={c.id}
                    style={{ paddingBottom: 6 }}
                  >
                    {commanderConversations.map((conversation) => (
                      <ConversationChatRow
                        key={conversation.id}
                        conversation={conversation}
                        selected={selectedChatId === conversation.id}
                        approvalCount={
                          approvals.filter((approval) => approvalMatchesConversationRow(approval, conversation)).length
                        }
                        onSelect={onSelectConversation}
                        onStart={onStartConversation}
                        onStop={onStopConversation}
                        onRename={onRenameConversation}
                        onUpdateRuntimeSettings={onUpdateConversationRuntimeSettings}
                        onRefreshModels={(providerId, credentialPoolId) => refreshModels({
                          providerId,
                          ...(credentialPoolId ? { credentialPoolId } : {}),
                        })}
                        refreshingProviderId={refreshingProviderId}
                        onArchive={onArchiveConversation}
                        onRemove={onRemoveConversation}
                        providerOptions={providerOptions}
                      />
                    ))}
                  </div>
                )}

                {canCreateChat && onCreateChatForCommander ? (
                  <CommanderNewChatRow
                    commander={c}
                    onCreateChat={() => onCreateChatForCommander(c.id)}
                  />
                ) : null}
              </div>
            )
          })}
        </div>

        <div data-testid="workers-section" data-test-id="workers-section">
          <SessionListSection
            label="Workers"
            sessions={workerSessions}
            collapsed={collapsed.workers}
            onToggle={() => toggle('workers')}
            headerAction={(
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button
                  style={tinyIconBtn}
                  type="button"
                  aria-label="New session"
                  onClick={onCreateSession}
                >
                  <Icon name="sessions" size={13} />
                </button>
                <button
                  style={tinyIconBtn}
                  type="button"
                  aria-label="Add machine"
                  onClick={onCreateWorker}
                >
                  <Icon name="terminal" size={13} />
                </button>
              </div>
            )}
            showExited={showExited.workers}
            onToggleShowExited={() => toggleShowExited('workers')}
            selectedChatId={selectedChatId}
            onSelectChat={onSelectChat}
            variant="session-card"
            sessionCardVariant="row"
            onKillSession={onKillSession}
            onResumeSession={onResumeSession}
          />
        </div>

        <div data-testid="automations-section" data-test-id="automations-section">
          <SessionListSection
            label="Automations"
            sessions={mergedAutomationSessions}
            collapsed={collapsed.automation}
            onToggle={() => toggle('automation')}
            showExited={showExited.automation}
            onToggleShowExited={() => toggleShowExited('automation')}
            selectedChatId={selectedChatId}
            onSelectChat={onSelectChat}
          />
        </div>
      </div>

      {/* Footer */}
      <div
        className="font-body"
        data-testid="sessions-footer"
        data-test-id="sessions-footer"
        style={{
          padding: '10px 12px 12px 20px',
          borderTop: '1px solid var(--hv-border-hair)',
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--hv-fg-faint)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span>live · auto-refresh</span>
        <span
          role="group"
          aria-label="Text size"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <button
            className="font-body"
            type="button"
            aria-label="Decrease text size"
            onClick={() => adjustFontScale(-fontScaleStep)}
            disabled={!canDecreaseFontScale || isFontScaleSaving}
            style={{
              background: 'transparent',
              border: '1px solid var(--hv-border-hair)',
              color: 'var(--hv-fg-subtle)',
              padding: '1px 6px',
              fontSize: 10,
              letterSpacing: '0.02em',
              cursor: !canDecreaseFontScale || isFontScaleSaving ? 'not-allowed' : 'pointer',
              opacity: !canDecreaseFontScale || isFontScaleSaving ? 0.4 : 1,
              borderRadius: 2,
            }}
          >
            A−
          </button>
          <button
            className="font-body"
            type="button"
            aria-label="Increase text size"
            onClick={() => adjustFontScale(fontScaleStep)}
            disabled={!canIncreaseFontScale || isFontScaleSaving}
            style={{
              background: 'transparent',
              border: '1px solid var(--hv-border-hair)',
              color: 'var(--hv-fg-subtle)',
              padding: '1px 6px',
              fontSize: 12,
              letterSpacing: '0.02em',
              cursor: !canIncreaseFontScale || isFontScaleSaving ? 'not-allowed' : 'pointer',
              opacity: !canIncreaseFontScale || isFontScaleSaving ? 0.4 : 1,
              borderRadius: 2,
            }}
          >
            A+
          </button>
        </span>
      </div>
    </aside>
  )
}
