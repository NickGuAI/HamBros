/**
 * SessionRow — individual commander session row for the Sessions column.
 *
 * Visual spec:
 *  - 7px status dot (color from STATE_COLOR)
 *  - 44px commander avatar
 *  - Commander name in JetBrains Mono 13px, name-only row
 *  - Pending count badge when pendingCount > 0
 *  - Selected state: ink-wash-02 bg + 2px solid foreground left border
 *  - Active state: full strength; inactive state: dimmed
 */
import type { SessionCreator } from '@/types'
import { AgentAvatar, Icon, STATE_COLOR } from '@modules/components/hervald'
import type { ConversationCredentialSelectionModes } from '@modules/commanders/conversation-credential-selection.js'

const ACTIVE_STATES = new Set(['active', 'connected', 'running'])

export interface Commander {
  id: string
  name: string
  /** Kept for identity lookup; archived commanders stay out of navigation. */
  archived?: boolean
  // Used by AgentAvatar for the initial-letter fallback when no avatar image
  // is set. Hosts from `useCommander` supply this as their real host name
  // (e.g. the machine nickname); display pages pass it through so the letter
  // matches what the user sees in the row title.
  displayName?: string
  host?: string
  credentialSelectionModes?: ConversationCredentialSelectionModes
  status: string
  description?: string
  iconName?: string
  isVirtual?: boolean
  // Threaded through from `CommanderSession` so surfaces can render a proper
  // commander avatar via `<AgentAvatar />`. `avatarUrl` points at the backend
  // avatar asset route when the operator has uploaded an image.
  avatarUrl?: string | null
  ui?: unknown
}

export interface Worker {
  id: string
  name: string
  label?: string
  kind?: string
  state?: string
  creator?: SessionCreator
  commanderId?: string
  processAlive?: boolean
  resumeAvailable?: boolean
}

export interface Approval {
  id: string
  commanderId?: string
  conversationId?: string | null
  sessionName?: string | null
  workerId?: string
  action?: string
}

interface SessionRowProps {
  commander: Commander
  selected: boolean
  onClick: () => void
  approvals?: Approval[]
}

export function SessionRow({
  commander,
  selected,
  onClick,
  approvals = [],
}: SessionRowProps) {
  const pendingCount = approvals.length
  const isActive = ACTIVE_STATES.has(commander.status)

  return (
    <div data-testid="commander-row" data-commander-id={commander.id}>
      <button
        data-testid="commander-row-button"
        onClick={onClick}
        style={{
          width: '100%',
          padding: '10px 16px 10px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: selected ? 'var(--hv-ink-wash-02)' : 'transparent',
          borderLeft: selected
            ? '2px solid var(--hv-fg)'
            : '2px solid transparent',
          borderTop: 'none',
          borderRight: 'none',
          borderBottom: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          opacity: isActive ? 1 : 0.58,
          transition: 'background 0.15s var(--hv-ease-gentle), opacity 0.15s var(--hv-ease-gentle)',
        }}
      >
        {commander.iconName ? (
          <Icon
            name={commander.iconName}
            size={14}
            style={{
              color: 'var(--hv-fg-subtle)',
              marginTop: 5,
            }}
          />
        ) : (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <AgentAvatar
              commander={commander}
              size={44}
              shape="square"
              active={isActive}
            />
            <span
              aria-hidden
              style={{
                position: 'absolute',
                right: -3,
                bottom: -3,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: STATE_COLOR[commander.status] ?? STATE_COLOR.idle,
                border: '2px solid var(--hv-bg)',
              }}
            />
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span
              className="font-mono"
              style={{
                minWidth: 0,
                fontSize: 13,
                color: 'var(--hv-fg)',
                letterSpacing: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {commander.name}
            </span>

            {pendingCount > 0 && (
              <span
                className="font-body"
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  background: 'var(--hv-accent-danger-wash)',
                  color: 'var(--hv-accent-danger)',
                  borderRadius: '2px 6px 2px 6px',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  flexShrink: 0,
                  marginLeft: 6,
                }}
              >
                {pendingCount} PEND
              </span>
            )}
          </div>
        </div>
      </button>
    </div>
  )
}
