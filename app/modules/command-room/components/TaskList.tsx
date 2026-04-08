import { useState } from 'react'
import { Clock3, Pencil, Play, Plus, Power, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import type {
  CronTask,
  WorkflowRunStatus,
} from '../hooks/useCommandRoom'
import { EditTaskForm } from './EditTaskForm'

interface TaskListProps {
  tasks: CronTask[]
  selectedTaskId: string | null
  onSelect: (taskId: string) => void
  onNewTask: () => void
  onToggle: (taskId: string, enabled: boolean) => Promise<unknown>
  onDelete: (taskId: string) => Promise<unknown>
  onRunNow: (taskId: string) => Promise<unknown>
  updateTaskId: string | null
  deleteTaskId: string | null
  triggerTaskId: string | null
  loading: boolean
}

type CronTaskWithDescription = CronTask & { description?: string }

function toRunBadgeClass(status: WorkflowRunStatus | null): string {
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

function toRunBadgeLabel(status: WorkflowRunStatus | null): string {
  if (!status) {
    return 'never ran'
  }
  if (status === 'running') {
    return 'running'
  }
  if (status === 'complete') {
    return 'complete'
  }
  if (status === 'failed') {
    return 'failed'
  }
  return 'timeout'
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

function formatNextRun(nextRun: string | null | undefined, timezone?: string): string {
  if (!nextRun) {
    return 'pending'
  }

  const parsed = new Date(nextRun)
  if (Number.isNaN(parsed.getTime())) {
    return 'pending'
  }

  try {
    return parsed.toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined)
  } catch {
    return parsed.toLocaleString()
  }
}

function readDescription(task: CronTask): string {
  const description = (task as CronTaskWithDescription).description
  return typeof description === 'string' ? description : ''
}

export function TaskList({
  tasks,
  selectedTaskId,
  onSelect,
  onNewTask,
  onToggle,
  onDelete,
  onRunNow,
  updateTaskId,
  deleteTaskId,
  triggerTaskId,
  loading,
}: TaskListProps) {
  const { data: machines } = useMachines()
  const machineList = machines ?? []

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      <section className="card-sumi flex-1 min-h-0 p-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider">Tasks</h3>
          <div className="flex items-center gap-2">
            {loading && <span className="text-whisper text-sumi-mist">Refreshing...</span>}
            <button
              type="button"
              onClick={onNewTask}
              className="btn-primary !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5"
            >
              <Plus size={12} />
              New Task
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-2 overflow-y-auto h-[calc(100%-1.5rem)] pr-1">
          {tasks.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-sumi-mist">
              No cron tasks created yet.
            </div>
          )}
          {tasks.map((task) => {
            const isSelected = task.id === selectedTaskId
            const isUpdating = updateTaskId === task.id
            const isDeleting = deleteTaskId === task.id
            const isTriggering = triggerTaskId === task.id
            const taskDescription = readDescription(task)
            const isEditing = editingTaskId === task.id
            const isEditPending = false // managed inside EditTaskForm now

            return (
              <div
                key={task.id}
                className={cn(
                  'border rounded-xl p-3 transition-colors',
                  isSelected
                    ? 'border-sumi-black/20 bg-washi-aged/40'
                    : 'border-ink-border bg-washi-white',
                )}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onSelect(task.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-sumi-black">{task.name}</p>
                      {taskDescription ? (
                        <p className="mt-1 text-whisper text-sumi-mist line-clamp-2">{taskDescription}</p>
                      ) : null}
                    </div>
                    <span className={cn('badge-sumi shrink-0', toRunBadgeClass(task.lastRunStatus))}>
                      {toRunBadgeLabel(task.lastRunStatus)}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-whisper text-sumi-gray">
                    <p className="inline-flex items-center gap-1">
                      <Clock3 size={12} />
                      {describeSchedule(task.schedule)}
                    </p>
                    <p className="font-mono truncate">{task.timezone || 'Server timezone'}</p>
                    <p className="text-whisper text-sumi-mist">
                      next run: {task.enabled ? formatNextRun(task.nextRun, task.timezone) : 'paused'}
                    </p>
                    <p className="font-mono truncate">{task.machine || 'local'}</p>
                    <p className="font-mono truncate">{task.workDir || '~'}</p>
                    <p className="font-mono truncate">{task.model || 'default model'}</p>
                  </div>
                </button>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash disabled:opacity-60"
                    disabled={isEditPending}
                    onClick={() => {
                      if (isEditing) {
                        setEditingTaskId(null)
                        return
                      }
                      setEditingTaskId(task.id)
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Pencil size={12} />
                      {isEditing ? 'Cancel Edit' : 'Edit'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash disabled:opacity-60"
                    disabled={isUpdating || isEditPending}
                    onClick={async () => {
                      await onToggle(task.id, !task.enabled)
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Power size={12} />
                      {task.enabled ? 'Disable' : 'Enable'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash disabled:opacity-60"
                    disabled={isTriggering || isEditPending}
                    onClick={async () => {
                      await onRunNow(task.id)
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Play size={12} />
                      {isTriggering ? 'Running...' : 'Run Now'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs text-accent-vermillion hover:bg-ink-wash disabled:opacity-60"
                    disabled={isDeleting || isEditPending}
                    onClick={async () => {
                      await onDelete(task.id)
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Trash2 size={12} />
                      Delete
                    </span>
                  </button>
                </div>
                {isEditing ? (
                  <EditTaskForm
                    task={task}
                    machines={machineList}
                    onSaved={(taskId, enabled) => {
                      setEditingTaskId(null)
                      void onToggle(taskId, enabled)
                    }}
                    onCancel={() => setEditingTaskId(null)}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
