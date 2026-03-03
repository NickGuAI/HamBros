import { Clock3, ExternalLink, Trash2 } from 'lucide-react'
import { cn, formatCost, timeAgo } from '@/lib/utils'
import type { CommanderCreateInput, CommanderSession } from '../hooks/useCommander'
import { CreateCommanderForm } from './CreateCommanderForm'

const STATE_BADGE_CLASSES: Record<CommanderSession['state'], string> = {
  idle: 'badge-idle',
  running: 'badge-active',
  paused: 'badge-idle',
  stopped: 'badge-stale',
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

export function CommanderList({
  commanders,
  selectedCommanderId,
  onSelect,
  loading,
  onAddCommander,
  isAddingCommander,
  onDeleteCommander,
  isDeletePending,
}: {
  commanders: CommanderSession[]
  selectedCommanderId: string | null
  onSelect: (commanderId: string) => void
  loading: boolean
  onAddCommander: (input: CommanderCreateInput) => Promise<void>
  isAddingCommander: boolean
  onDeleteCommander: (commanderId: string) => Promise<void>
  isDeletePending: boolean
}) {
  return (
    <section className="h-full card-sumi overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60">
        <h3 className="section-title">Commander List</h3>
      </header>

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
                  <p className="font-mono text-sm text-sumi-black truncate">{session.host}</p>
                  <p className="mt-1 text-whisper text-sumi-mist truncate">{session.id}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
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

      <div className="p-3 border-t border-ink-border">
        <CreateCommanderForm onAdd={onAddCommander} isPending={isAddingCommander} />
      </div>
    </section>
  )
}
