import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommanderSession, CommanderTask } from '../hooks/useCommander'

type TaskDisplayState = 'open' | 'in-progress' | 'done'

const TASK_STATE_BADGE_CLASS: Record<TaskDisplayState, string> = {
  open: 'badge-idle',
  'in-progress': 'badge-active',
  done: 'badge-completed',
}

function deriveTaskState(task: CommanderTask): TaskDisplayState {
  const normalizedLabels = task.labels.map((label) => label.toLowerCase())
  if (task.state === 'closed' || normalizedLabels.some((label) => label.includes('done') || label.includes('complete'))) {
    return 'done'
  }
  if (normalizedLabels.some((label) => label.includes('progress') || label.includes('doing'))) {
    return 'in-progress'
  }
  return 'open'
}

export function TaskDrawer({
  commander,
  tasks,
  loading,
  error,
  onAssignTask,
  assignTaskPending,
}: {
  commander: CommanderSession | null
  tasks: CommanderTask[]
  loading: boolean
  error: string | null
  onAssignTask: (input: { commanderId: string; issueNumber: number }) => Promise<void>
  assignTaskPending: boolean
}) {
  const [pendingIssueNumber, setPendingIssueNumber] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleAssign(issueNumber: number): Promise<void> {
    if (!commander) {
      return
    }

    setActionError(null)
    setPendingIssueNumber(issueNumber)
    try {
      await onAssignTask({
        commanderId: commander.id,
        issueNumber,
      })
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to assign task')
    } finally {
      setPendingIssueNumber(null)
    }
  }

  return (
    <section className="card-sumi h-full overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60">
        <h3 className="section-title">Tasks (GitHub Issues)</h3>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {!commander && (
          <p className="text-sm text-sumi-diluted">Select a commander to view tasks.</p>
        )}

        {commander && loading && tasks.length === 0 && (
          <div className="flex items-center justify-center h-28">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commander && !loading && tasks.length === 0 && !error && (
          <p className="text-sm text-sumi-diluted">No tasks found for this commander label.</p>
        )}

        {commander && tasks.map((task) => {
          const displayState = deriveTaskState(task)
          const isCurrentTask = commander.currentTask?.issueNumber === task.number
          const assigning = assignTaskPending && pendingIssueNumber === task.number

          return (
            <div
              key={task.number}
              className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a
                    href={task.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-sm text-sumi-black hover:text-sumi-gray"
                  >
                    <span className="truncate">#{task.number} {task.title}</span>
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                </div>
                <span className={cn('badge-sumi shrink-0', TASK_STATE_BADGE_CLASS[displayState])}>
                  {displayState}
                </span>
              </div>

              <div className="mt-2 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => void handleAssign(task.number)}
                  disabled={isCurrentTask || assigning}
                  className="rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {isCurrentTask ? 'Assigned' : assigning ? 'Assigning...' : 'Assign'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {(error || actionError) && (
        <p className="border-t border-ink-border px-4 py-2 text-sm text-accent-vermillion">
          {actionError ?? error}
        </p>
      )}
    </section>
  )
}
