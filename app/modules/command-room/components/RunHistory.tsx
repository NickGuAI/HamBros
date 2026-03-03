import { useState } from 'react'
import { ChevronDown, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CronTask, WorkflowRun, WorkflowRunStatus } from '../hooks/useCommandRoom'

interface RunHistoryProps {
  task: CronTask | null
  runs: WorkflowRun[]
  loading: boolean
}

function toBadgeClass(status: WorkflowRunStatus): string {
  if (status === 'running') {
    return 'badge-idle'
  }
  if (status === 'complete') {
    return 'badge-active'
  }
  if (status === 'failed' || status === 'timeout') {
    return 'badge-stale'
  }
  return 'badge-completed'
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
  return `$${costUsd.toFixed(4)}`
}

export function RunHistory({ task, runs, loading }: RunHistoryProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  if (!task) {
    return (
      <div className="card-sumi h-full flex items-center justify-center p-6 text-sumi-mist text-sm">
        Select a task to view run history.
      </div>
    )
  }

  return (
    <div className="card-sumi h-full p-4 flex flex-col min-h-0">
      <div>
        <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider">Run History</h3>
        <p className="mt-1 text-whisper text-sumi-gray">
          {task.name} • {task.schedule}
        </p>
      </div>

      <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
        {loading && <p className="text-whisper text-sumi-mist">Loading run history...</p>}
        {!loading && runs.length === 0 && (
          <div className="py-8 text-center text-sm text-sumi-mist">
            No runs recorded for this task.
          </div>
        )}
        {runs.map((run) => {
          const expanded = expandedRunId === run.id
          return (
            <div key={run.id} className="border border-ink-border rounded-xl p-3 bg-washi-white">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-sumi-black">
                    {formatTimestamp(run.startedAt)}
                  </p>
                  <p className="text-whisper text-sumi-gray mt-1">
                    Ended: {formatTimestamp(run.completedAt)}
                  </p>
                </div>
                <span className={cn('badge-sumi shrink-0', toBadgeClass(run.status))}>
                  {run.status}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-whisper text-sumi-gray">
                <p className="font-mono truncate">Session: {run.sessionId || '-'}</p>
                <p>Cost: {formatCost(run.costUsd)}</p>
                <p>Run ID: {run.id}</p>
              </div>

              <button
                type="button"
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-sumi-gray hover:text-sumi-black"
                onClick={() => {
                  setExpandedRunId(expanded ? null : run.id)
                }}
              >
                <ChevronDown
                  size={14}
                  className={cn('transition-transform', expanded && 'rotate-180')}
                />
                <FileText size={14} />
                {expanded ? 'Hide report' : 'Show report'}
              </button>

              {expanded && (
                <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed bg-washi-aged/30 border border-ink-border rounded-lg p-3 text-sumi-gray max-h-72 overflow-y-auto">
                  {run.report || 'No report available.'}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
