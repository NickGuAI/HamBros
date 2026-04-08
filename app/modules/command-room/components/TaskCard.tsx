import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { FileText, Pencil, Play, Power, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import type { CronTask, WorkflowRun, WorkflowRunStatus } from '../hooks/useCommandRoom'
import { fetchRuns, RUNS_QUERY_KEY } from '../hooks/useCommandRoom'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import { EditTaskForm } from './EditTaskForm'

interface TaskCardProps {
  task: CronTask
  onToggle: (taskId: string, enabled: boolean) => Promise<unknown>
  onDelete: (taskId: string) => Promise<unknown>
  onRunNow: (taskId: string) => Promise<unknown>
  onUpdate: (input: { taskId: string; patch: Record<string, unknown> }) => Promise<unknown>
  updatePending: boolean
  deletePending: boolean
  triggerPending: boolean
}

function pad(value: string): string {
  return value.padStart(2, '0')
}

function describeSchedule(expression: string): string {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return expression
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return expression
  }
  const isWildcardDay = dayOfMonth === '*' && month === '*' && dayOfWeek === '*'
  if (minute === '*' && hour === '*' && isWildcardDay) {
    return 'Every minute'
  }
  if (/^\d+$/.test(minute) && hour === '*' && isWildcardDay) {
    return `Every hour at :${pad(minute)}`
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && isWildcardDay) {
    return `Every day at ${pad(hour)}:${pad(minute)}`
  }
  return expression
}

function formatNextRun(nextRun: string | null | undefined): string {
  if (!nextRun) {
    return 'pending'
  }
  const parsed = new Date(nextRun)
  if (Number.isNaN(parsed.getTime())) {
    return 'pending'
  }
  return parsed.toLocaleString()
}

function timeToNext(nextRun: string | null | undefined): string {
  if (!nextRun) {
    return ''
  }
  const parsed = new Date(nextRun)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }
  const diffMs = parsed.getTime() - Date.now()
  if (diffMs <= 0) {
    return 'now'
  }
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) {
    return `in ${mins}m`
  }
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    const remainMins = mins % 60
    return remainMins > 0 ? `in ${hours}h ${remainMins}m` : `in ${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return '-'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString()
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`
}

const STATUS_BADGE: Record<string, string> = {
  running: 'badge-idle',
  complete: 'badge-active',
  failed: 'badge-stale',
  timeout: 'badge-stale',
}

function statusBadgeClass(status: WorkflowRunStatus | null): string {
  if (!status) {
    return 'badge-completed'
  }
  return STATUS_BADGE[status] ?? 'badge-completed'
}

function statusLabel(status: WorkflowRunStatus | null): string {
  if (!status) {
    return 'never ran'
  }
  return status
}

function statusDot(status: WorkflowRunStatus): string {
  if (status === 'complete') {
    return 'bg-accent-moss'
  }
  if (status === 'failed' || status === 'timeout') {
    return 'bg-accent-vermillion'
  }
  if (status === 'running') {
    return 'bg-sumi-mist animate-breathe'
  }
  return 'bg-sumi-mist'
}

interface RunsPopupProps {
  task: CronTask
  runs: WorkflowRun[]
  loading: boolean
  onClose: () => void
}

function RunsPopup({ task, runs, loading, onClose }: RunsPopupProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  return createPortal(
    <div className="fixed inset-0 z-[10000]">
      <div className="absolute inset-0 bg-sumi-black/30" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-5">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Run history for ${task.name}`}
          className="pointer-events-auto flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-ink-border bg-washi-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-ink-border px-4 py-3">
            <div>
              <p className="font-mono text-sm text-sumi-black">{task.name}</p>
              <p className="text-whisper text-sumi-diluted">{describeSchedule(task.schedule)} — Run History</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-sumi-diluted hover:bg-ink-wash transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
            {loading && <p className="text-whisper text-sumi-mist">Loading runs...</p>}
            {!loading && runs.length === 0 && (
              <p className="text-sm text-sumi-mist py-8 text-center">No runs recorded.</p>
            )}
            {runs.map((run) => {
              const isExpanded = expandedRunId === run.id
              return (
                <div key={run.id} className="rounded-lg border border-ink-border bg-washi-white px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 text-sm">
                      <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', statusDot(run.status))} />
                      <span className="text-sumi-black">{formatTimestamp(run.startedAt)}</span>
                      <span className={cn('badge-sumi', statusBadgeClass(run.status))}>{run.status}</span>
                      <span className="font-mono text-sumi-diluted">{formatCost(run.costUsd)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                      className="inline-flex items-center gap-1 text-xs text-sumi-diluted hover:text-sumi-black shrink-0"
                    >
                      <FileText size={12} />
                      {isExpanded ? 'Hide' : 'Report'}
                    </button>
                  </div>
                  {isExpanded && (
                    <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed bg-washi-aged/30 border border-ink-border rounded-lg p-3 text-sumi-gray max-h-72 overflow-y-auto">
                      {run.report || 'No report available.'}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function TaskCard({
  task,
  onToggle,
  onDelete,
  onRunNow,
  onUpdate,
  updatePending,
  deletePending,
  triggerPending,
}: TaskCardProps) {
  const [editing, setEditing] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const { data: machines } = useMachines()
  const machineList = machines ?? []

  // Each card fetches its own runs for stats (cached by react-query, refetch every 30s)
  const runsQuery = useQuery({
    queryKey: RUNS_QUERY_KEY(task.id),
    queryFn: () => fetchRuns(task.id),
    refetchInterval: 30_000,
  })
  const runs = runsQuery.data ?? []

  const totalRuns = runs.length
  const passCount = runs.filter((r) => r.status === 'complete').length
  const passRate = totalRuns > 0 ? Math.round((passCount / totalRuns) * 100) : 0
  const recentRuns = runs.slice(0, 10)

  const avgDurationMs = (() => {
    const durations: number[] = []
    for (const r of runs) {
      if (r.completedAt && r.startedAt) {
        const d = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()
        if (d > 0 && Number.isFinite(d)) {
          durations.push(d)
        }
      }
    }
    return durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
  })()

  const avgDurationLabel = (() => {
    if (avgDurationMs <= 0) {
      return null
    }
    const mins = Math.round(avgDurationMs / 60_000)
    if (mins < 1) {
      return '<1m'
    }
    if (mins < 60) {
      return `${mins}m`
    }
    const hrs = Math.floor(mins / 60)
    const rem = mins % 60
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
  })()

  const accentBorder =
    task.lastRunStatus === 'failed' || task.lastRunStatus === 'timeout'
      ? 'border-accent-vermillion/40'
      : task.lastRunStatus === 'running'
        ? 'border-accent-moss/40'
        : 'border-ink-border'

  return (
    <div className={cn('card-sumi p-4', accentBorder)}>
      {/* Header: name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-sumi-black truncate">{task.name}</p>
          {(task as CronTask & { description?: string }).description && (
            <p className="text-whisper text-sumi-diluted truncate mt-0.5">
              {(task as CronTask & { description?: string }).description}
            </p>
          )}
        </div>
        <span className={cn('badge-sumi shrink-0', statusBadgeClass(task.lastRunStatus))}>
          {statusLabel(task.lastRunStatus)}
        </span>
      </div>

      {/* Schedule */}
      <p className="mt-2 text-xs text-sumi-diluted">
        {describeSchedule(task.schedule)}
        {task.timezone ? ` (${task.timezone})` : ''}
      </p>

      {/* Last run + next run */}
      <div className="mt-2 text-xs text-sumi-diluted space-y-0.5">
        {task.lastRunAt && (
          <p>
            Last: {formatTimestamp(task.lastRunAt)}
            {task.lastRunStatus === 'complete' ? ' \u2713' : task.lastRunStatus === 'failed' ? ' \u2717' : ''}
          </p>
        )}
        <p>
          Next: {task.enabled ? formatNextRun(task.nextRun) : 'disabled'}
          {task.enabled && task.nextRun && (
            <span className="ml-2 text-sumi-mist">({timeToNext(task.nextRun)})</span>
          )}
        </p>
      </div>

      {/* Stats: total runs, pass rate, recent status dots */}
      {totalRuns > 0 && (
        <div className="mt-2 flex items-center gap-3 text-xs text-sumi-diluted">
          <span>{totalRuns} runs</span>
          <span>{passRate}% pass</span>
          {avgDurationLabel && <span>avg {avgDurationLabel}</span>}
          <span className="flex items-center gap-0.5">
            {recentRuns.map((r) => (
              <span
                key={r.id}
                className={cn('inline-block h-1.5 w-1.5 rounded-full', statusDot(r.status))}
                title={`${formatTimestamp(r.startedAt)} — ${r.status}`}
              />
            ))}
          </span>
        </div>
      )}

      {/* Actions — compact, one line */}
      <div className="mt-3 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="rounded border border-ink-border px-2 py-1 text-xs text-sumi-diluted hover:bg-ink-wash transition-colors"
        >
          <Pencil size={10} className="inline mr-1" />
          Edit
        </button>
        <button
          type="button"
          disabled={updatePending}
          onClick={() => void onToggle(task.id, task.enabled)}
          className="rounded border border-ink-border px-2 py-1 text-xs text-sumi-diluted hover:bg-ink-wash transition-colors disabled:opacity-60"
        >
          <Power size={10} className="inline mr-1" />
          {task.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          disabled={triggerPending}
          onClick={() => void onRunNow(task.id)}
          className="rounded border border-ink-border px-2 py-1 text-xs text-sumi-diluted hover:bg-ink-wash transition-colors disabled:opacity-60"
        >
          <Play size={10} className="inline mr-1 fill-current" />
          Run
        </button>
        <button
          type="button"
          disabled={deletePending}
          onClick={() => void onDelete(task.id)}
          className="rounded border border-ink-border px-2 py-1 text-xs text-accent-vermillion hover:bg-accent-vermillion/10 transition-colors disabled:opacity-60"
        >
          <Trash2 size={10} className="inline mr-1" />
          Del
        </button>
        <button
          type="button"
          onClick={() => setShowRuns(true)}
          className="rounded border border-ink-border px-2 py-1 text-xs text-sumi-diluted hover:bg-ink-wash transition-colors"
        >
          Runs
        </button>
      </div>

      {/* Edit form popup */}
      <ModalFormContainer
        open={editing}
        title={`Edit — ${task.name}`}
        onClose={() => setEditing(false)}
      >
        <EditTaskForm
          task={task}
          machines={machineList}
          onUpdate={async (patch) => {
            await onUpdate({ taskId: task.id, patch })
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
          saving={updatePending}
        />
      </ModalFormContainer>

      {/* Runs popup overlay */}
      {showRuns && (
        <RunsPopup
          task={task}
          runs={runs}
          loading={runsQuery.isLoading}
          onClose={() => setShowRuns(false)}
        />
      )}
    </div>
  )
}
