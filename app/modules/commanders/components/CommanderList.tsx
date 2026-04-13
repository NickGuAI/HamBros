import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock3, ExternalLink, MessageSquare, Plus, Square, Trash2, Triangle } from 'lucide-react'
import { cn, formatCost, timeAgo } from '@/lib/utils'
import { fetchJson } from '../../../src/lib/api'
import type {
  CommanderAgentType,
  CommanderCreateInput,
  CommanderSession,
} from '../hooks/useCommander'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import { CreateCommanderForm } from './CreateCommanderForm'

declare module '../hooks/useCommander' {
  interface CommanderSession {
    persona?: string
    channelMeta?: {
      provider: 'whatsapp' | 'telegram' | 'discord'
      displayName: string
      sessionKey?: string
      subject?: string
    }
  }
}

type CommanderSessionCard = CommanderSession & {
  remoteOrigin?: {
    machineId: string
    label: string
  }
}

const STATE_BADGE_CLASSES: Record<CommanderSession['state'], string> = {
  idle: 'badge-idle',
  running: 'badge-active',
  paused: 'badge-idle',
  stopped: 'badge-stale',
}

const CHANNEL_PROVIDER_LABELS: Record<'whatsapp' | 'telegram' | 'discord', string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
}

function resolveCommanderDisplayName(session: CommanderSessionCard): string {
  const channelMeta = session.channelMeta
  if (!channelMeta) {
    return session.displayName?.trim() || session.host
  }

  const providerLabel = CHANNEL_PROVIDER_LABELS[channelMeta.provider]
  const baseLabel = channelMeta.displayName.trim() || session.displayName?.trim() || session.host
  return `${providerLabel} • ${baseLabel}`
}

function currentTaskLabel(session: CommanderSession): string | null {
  if (!session.currentTask) {
    return null
  }

  const title = typeof session.currentTask.title === 'string' ? session.currentTask.title.trim() : ''
  if (title.length > 0) {
    return `#${session.currentTask.issueNumber} ${title}`
  }

  return `#${session.currentTask.issueNumber}`
}

interface ManualHeartbeatTriggerResponse {
  runId: string
  timestamp: string
  sessionName: string
  triggered: boolean
}

async function triggerManualHeartbeat(commanderId: string): Promise<ManualHeartbeatTriggerResponse> {
  return fetchJson<ManualHeartbeatTriggerResponse>(
    `/api/commanders/${encodeURIComponent(commanderId)}/heartbeat`,
    {
      method: 'POST',
    },
  )
}

function removeKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) {
    return record
  }
  const next = { ...record }
  delete next[key]
  return next
}

function resolveAgentType(agentType: CommanderSession['agentType']): CommanderAgentType {
  if (agentType === 'codex' || agentType === 'gemini') {
    return agentType
  }
  return 'claude'
}

export function CommanderList({
  commanders,
  selectedCommanderId,
  onSelect,
  loading,
  onAddCommander,
  isAddingCommander,
  onDeleteCommander,
  isDeletePending,
  onOpenChat,
  onStartCommander,
  onStopCommander,
  isStartPending,
  isStopPending,
}: {
  commanders: CommanderSessionCard[]
  selectedCommanderId: string | null
  onSelect: (commanderId: string) => void
  loading: boolean
  onAddCommander: (input: CommanderCreateInput) => Promise<void>
  isAddingCommander: boolean
  onDeleteCommander: (commanderId: string) => Promise<void>
  isDeletePending: boolean
  onOpenChat?: (commanderId: string, agentType: CommanderAgentType) => Promise<void>
  onStartCommander?: (commanderId: string, agentType: CommanderAgentType) => Promise<void>
  onStopCommander?: (commanderId: string) => Promise<void>
  isStartPending?: boolean
  isStopPending?: boolean
}) {
  const queryClient = useQueryClient()
  const [agentTypeByCommander, setAgentTypeByCommander] = useState<Record<string, CommanderAgentType>>({})
  const [manualHeartbeatRunIdByCommander, setManualHeartbeatRunIdByCommander] = useState<Record<string, string>>({})
  const [manualHeartbeatErrorByCommander, setManualHeartbeatErrorByCommander] = useState<Record<string, string>>({})
  const [manualHeartbeatToast, setManualHeartbeatToast] = useState<string | null>(null)
  const [showCreateCommanderForm, setShowCreateCommanderForm] = useState(false)
  const closeCreateCommanderForm = useCallback(() => setShowCreateCommanderForm(false), [])
  const manualHeartbeatToastTimer = useRef<number | null>(null)

  function showManualHeartbeatToast(message: string): void {
    if (manualHeartbeatToastTimer.current !== null) {
      window.clearTimeout(manualHeartbeatToastTimer.current)
    }
    setManualHeartbeatToast(message)
    manualHeartbeatToastTimer.current = window.setTimeout(() => {
      setManualHeartbeatToast(null)
      manualHeartbeatToastTimer.current = null
    }, 5000)
  }

  useEffect(() => {
    return () => {
      if (manualHeartbeatToastTimer.current !== null) {
        window.clearTimeout(manualHeartbeatToastTimer.current)
      }
    }
  }, [])

  const manualHeartbeatMutation = useMutation({
    mutationFn: triggerManualHeartbeat,
    onSuccess: async (payload, commanderId) => {
      setManualHeartbeatRunIdByCommander((current) => ({
        ...current,
        [commanderId]: payload.runId,
      }))
      setManualHeartbeatErrorByCommander((current) => removeKey(current, commanderId))
      showManualHeartbeatToast(`Heartbeat run queued: ${payload.runId}`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['commanders', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['commanders', 'heartbeat-log', commanderId] }),
      ])
    },
    onError: (error, commanderId) => {
      setManualHeartbeatErrorByCommander((current) => ({
        ...current,
        [commanderId]: error instanceof Error ? error.message : 'Failed to trigger heartbeat.',
      }))
    },
  })

  return (
    <section className="relative min-h-[16rem] xl:h-full card-sumi overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60 flex items-center justify-between gap-3">
        <h3 className="section-title">Commander List</h3>
        <button
          type="button"
          onClick={() => setShowCreateCommanderForm(true)}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex min-h-[44px] items-center gap-1.5"
        >
          <Plus size={12} />
          + New Commander
        </button>
      </header>

      {manualHeartbeatToast && (
        <div className="absolute right-3 top-3 z-10 max-w-[20rem] rounded-lg border border-ink-border bg-washi-white/95 px-2.5 py-1.5 text-whisper text-sumi-black shadow-ink-sm">
          {manualHeartbeatToast}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loading && commanders.length === 0 && (
          <div className="flex items-center justify-center h-40">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {!loading && commanders.length === 0 && (
          <p className="text-sm text-sumi-diluted px-1 py-2">No commander sessions found.</p>
        )}

        {commanders.map((session) => {
          const selected = selectedCommanderId === session.id
          const taskLabel = currentTaskLabel(session)
          const isRunning = session.state === 'running'
          const commanderDisplayName = resolveCommanderDisplayName(session)
          const selectedAgentType = agentTypeByCommander[session.id] ?? resolveAgentType(session.agentType)
          const isManualHeartbeatPending = manualHeartbeatMutation.isPending &&
            manualHeartbeatMutation.variables === session.id
          const manualHeartbeatRunId = manualHeartbeatRunIdByCommander[session.id]
          const manualHeartbeatError = manualHeartbeatErrorByCommander[session.id]

          return (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(session.id)
                }
              }}
              className={cn(
                'cursor-pointer rounded-lg border border-ink-border p-3 transition-all duration-300',
                selected ? 'bg-washi-aged/70 shadow-ink-sm ring-1 ring-sumi-black/10' : 'bg-washi-white hover:bg-washi-aged/40',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-sumi-black truncate">{commanderDisplayName}</p>
                  {session.channelMeta?.subject && (
                    <p className="mt-1 text-sumi-diluted text-xs truncate">{session.channelMeta.subject}</p>
                  )}
                  {session.persona && (
                    <p className="mt-1 text-sumi-diluted text-xs truncate">{session.persona}</p>
                  )}
                  <p className="mt-1 text-whisper text-sumi-mist truncate">{session.id}</p>
                  {session.remoteOrigin?.label && (
                    <p className="mt-1 text-whisper text-sumi-diluted truncate">
                      remote {session.remoteOrigin.label}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {session.channelMeta && (
                    <span className="badge-sumi badge-idle">
                      {CHANNEL_PROVIDER_LABELS[session.channelMeta.provider]}
                    </span>
                  )}
                  <span className={cn('badge-sumi', STATE_BADGE_CLASSES[session.state])}>
                    <span
                      className={cn(
                        'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                        isRunning ? 'bg-accent-moss animate-breathe' : 'bg-sumi-mist',
                      )}
                    />
                    {session.state}
                  </span>
                  {!isRunning && (
                    <button
                      type="button"
                      disabled={isDeletePending}
                      onClick={(e) => {
                        e.stopPropagation()
                        void onDeleteCommander(session.id)
                      }}
                      className="p-1 text-sumi-diluted hover:text-accent-vermillion transition-colors disabled:opacity-40"
                      title="Delete commander"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>

              {session.currentTask ? (
                <div className="mt-3 min-w-0">
                  <p className="text-whisper text-sumi-diluted uppercase">Current task</p>
                  <a
                    href={session.currentTask.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="mt-1 inline-flex max-w-full items-center gap-1 text-sm text-sumi-black hover:text-sumi-gray"
                  >
                    <span className="truncate">{taskLabel}</span>
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                  <p className="text-whisper text-sumi-mist mt-1">started {timeAgo(session.currentTask.startedAt)}</p>
                </div>
              ) : (
                <p className="mt-3 text-whisper text-sumi-mist">No task assigned</p>
              )}

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <label className="inline-flex items-center gap-1 rounded-lg border border-ink-border px-2 py-1 text-xs text-sumi-diluted">
                  <span>agentType</span>
                  <select
                    value={selectedAgentType}
                    onChange={(event) => {
                      event.stopPropagation()
                      const nextValue = event.target.value
                      const nextAgentType = nextValue === 'codex' || nextValue === 'gemini'
                        ? nextValue
                        : 'claude'
                      setAgentTypeByCommander((current) => ({
                        ...current,
                        [session.id]: nextAgentType,
                      }))
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="bg-transparent text-sumi-black focus:outline-none"
                  >
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="gemini">gemini</option>
                  </select>
                </label>
                {!isRunning && onStartCommander && (
                  <button
                    type="button"
                    disabled={isStartPending}
                    onClick={(event) => {
                      event.stopPropagation()
                      void onStartCommander(session.id, selectedAgentType)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent-moss/40 px-2.5 py-1 text-xs text-accent-moss hover:bg-accent-moss/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    <Triangle size={10} className="fill-current" />
                    Start
                  </button>
                )}
                {isRunning && onStopCommander && (
                  <button
                    type="button"
                    disabled={isStopPending}
                    onClick={(event) => {
                      event.stopPropagation()
                      void onStopCommander(session.id)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent-vermillion/40 px-2.5 py-1 text-xs text-accent-vermillion hover:bg-accent-vermillion/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    <Square size={10} className="fill-current" />
                    Stop
                  </button>
                )}
                {isRunning && (
                  <button
                    type="button"
                    disabled={isManualHeartbeatPending}
                    onClick={(event) => {
                      event.stopPropagation()
                      setManualHeartbeatErrorByCommander((current) => removeKey(current, session.id))
                      void manualHeartbeatMutation.mutateAsync(session.id)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {isManualHeartbeatPending ? 'Triggering...' : 'Trigger Heartbeat'}
                  </button>
                )}
                {onOpenChat && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void onOpenChat(session.id, selectedAgentType)
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash transition-colors"
                  >
                    <MessageSquare size={12} />
                    Open Chat
                  </button>
                )}
              </div>

              {isRunning && manualHeartbeatRunId && (
                <p
                  className="mt-2 text-whisper text-sumi-diluted truncate"
                  title={manualHeartbeatRunId}
                >
                  runId: {manualHeartbeatRunId}
                </p>
              )}
              {isRunning && manualHeartbeatError && (
                <p className="mt-2 text-whisper text-accent-vermillion">
                  {manualHeartbeatError}
                </p>
              )}

              <div className="mt-3 flex items-center justify-between gap-2 text-whisper text-sumi-diluted">
                <span className="flex items-center gap-1.5">
                  <Clock3 size={12} />
                  up {timeAgo(session.created)}
                </span>
                <span className="font-mono text-sumi-black">{formatCost(session.totalCostUsd)}</span>
              </div>
            </div>
          )
        })}
      </div>

      <ModalFormContainer
        open={showCreateCommanderForm}
        title="New Commander"
        onClose={closeCreateCommanderForm}
      >
        <CreateCommanderForm
          onAdd={onAddCommander}
          isPending={isAddingCommander}
          onClose={closeCreateCommanderForm}
        />
      </ModalFormContainer>
    </section>
  )
}
