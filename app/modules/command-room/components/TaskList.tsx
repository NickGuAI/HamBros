import { type FormEvent, useState } from 'react'
import { Clock3, Play, Plus, Power, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import type { AgentType, ClaudePermissionMode, SessionType } from '@/types'
import type {
  CommandRoomAgentType,
  CreateCronTaskInput,
  CronTask,
  WorkflowRunStatus,
} from '../hooks/useCommandRoom'
import { NewSessionForm } from '../../agents/components/NewSessionForm'

interface TaskListProps {
  tasks: CronTask[]
  selectedTaskId: string | null
  onSelect: (taskId: string) => void
  onCreate: (input: CreateCronTaskInput) => Promise<unknown>
  onToggle: (taskId: string, enabled: boolean) => Promise<unknown>
  onDelete: (taskId: string) => Promise<unknown>
  onRunNow: (taskId: string) => Promise<unknown>
  createPending: boolean
  updateTaskId: string | null
  deleteTaskId: string | null
  triggerTaskId: string | null
  loading: boolean
}

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

function detectBrowserTimezone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved && resolved.trim().length > 0 ? resolved : 'UTC'
}

function listIanaTimezones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supportedValuesOf !== 'function') {
    return []
  }

  try {
    return supportedValuesOf('timeZone')
  } catch {
    return []
  }
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

const TIMEZONE_OPTIONS = listIanaTimezones()

export function TaskList({
  tasks,
  selectedTaskId,
  onSelect,
  onCreate,
  onToggle,
  onDelete,
  onRunNow,
  createPending,
  updateTaskId,
  deleteTaskId,
  triggerTaskId,
  loading,
}: TaskListProps) {
  const { data: machines } = useMachines()
  const machineList = machines ?? []

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState<ClaudePermissionMode>('acceptEdits')
  const [task, setTask] = useState('')
  const [timezone, setTimezone] = useState(() => detectBrowserTimezone())
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [selectedHost, setSelectedHost] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateError(null)
    try {
      await onCreate({
        name: name.trim(),
        schedule: schedule.trim(),
        timezone: timezone.trim() || undefined,
        machine: selectedHost,
        workDir: cwd.trim(),
        agentType: agentType as CommandRoomAgentType,
        instruction: task.trim(),
        enabled: true,
        permissionMode: mode,
        sessionType,
      })
      setName('')
      setSchedule('')
      setTimezone(detectBrowserTimezone())
      setCwd('')
      setMode('acceptEdits')
      setTask('')
      setAgentType('claude')
      setSessionType('stream')
      setSelectedHost('')
      setShowForm(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create task')
    }
  }

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {showForm && (
        <section className="card-sumi p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider">New Cron Task</h3>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="p-1 rounded hover:bg-ink-wash transition-colors"
              aria-label="Close"
            >
              <X size={14} className="text-sumi-diluted" />
            </button>
          </div>
          <NewSessionForm
            name={name}
            setName={setName}
            cwd={cwd}
            setCwd={setCwd}
            mode={mode}
            setMode={setMode}
            task={task}
            setTask={setTask}
            agentType={agentType}
            setAgentType={setAgentType}
            sessionType={sessionType}
            setSessionType={setSessionType}
            machines={machineList}
            selectedHost={selectedHost}
            setSelectedHost={setSelectedHost}
            isCreating={createPending}
            createError={createError}
            onSubmit={(e) => void handleSubmit(e)}
            schedule={schedule}
            setSchedule={setSchedule}
            submitLabel="Create Task"
            nameLabel="Task Name"
            namePlaceholder="nightly-deploy"
            namePattern=""
            taskLabel="Instruction"
            taskPlaceholder="Run the nightly test suite and report results"
            taskRequired
          />
          <div className="mt-3">
            <label className="section-title block mb-2">Timezone</label>
            {TIMEZONE_OPTIONS.length > 0 ? (
              <select
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              >
                {!TIMEZONE_OPTIONS.includes(timezone) && timezone ? (
                  <option value={timezone}>{timezone}</option>
                ) : null}
                <option value="">Server default</option>
                {TIMEZONE_OPTIONS.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                placeholder="America/Los_Angeles"
              />
            )}
            <p className="mt-1 text-whisper text-sumi-mist">Defaults to your browser timezone</p>
          </div>
        </section>
      )}

      <section className="card-sumi flex-1 min-h-0 p-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider">Tasks</h3>
          <div className="flex items-center gap-2">
            {loading && <span className="text-whisper text-sumi-mist">Refreshing...</span>}
            {!showForm && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="btn-primary !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5"
              >
                <Plus size={12} />
                New Task
              </button>
            )}
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
                    <p className="font-medium text-sm text-sumi-black">{task.name}</p>
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
                  </div>
                </button>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash disabled:opacity-60"
                    disabled={isUpdating}
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
                    disabled={isTriggering}
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
                    disabled={isDeleting}
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
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
