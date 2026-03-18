import { type FormEvent, useState } from 'react'
import { Clock3, Pencil, Play, Plus, Power, Trash2, X } from 'lucide-react'
import { fetchJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import { useSkills } from '@/hooks/use-skills'
import type { AgentType, ClaudePermissionMode, SessionType } from '@/types'
import type {
  CommandRoomAgentType,
  CreateCronTaskInput,
  CronTask,
  WorkflowRunStatus,
} from '../hooks/useCommandRoom'
import { CLAUDE_MODE_OPTIONS, CODEX_MODE_OPTIONS, NewSessionForm } from '../../agents/components/NewSessionForm'

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

type CronTaskWithDescription = CronTask & { description?: string }

interface EditableTaskState {
  taskId: string
  enabled: boolean
  name: string
  schedule: string
  timezone: string
  description: string
  instruction: string
  machine: string
  workDir: string
  agentType: AgentType
  permissionMode: ClaudePermissionMode
  sessionType: SessionType
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

function prependSkillInvocation(instruction: string, skillName: string): string {
  const command = `/${skillName}`
  const trimmed = instruction.trim()
  if (trimmed === command || trimmed.startsWith(`${command} `)) {
    return trimmed
  }
  if (trimmed.length === 0) {
    return `${command} `
  }
  return `${command} ${trimmed}`
}

function readDescription(task: CronTask): string {
  const description = (task as CronTaskWithDescription).description
  return typeof description === 'string' ? description : ''
}

function coercePermissionMode(mode: string | undefined): ClaudePermissionMode {
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'dangerouslySkipPermissions') {
    return mode
  }
  return 'acceptEdits'
}

function coerceSessionType(sessionType: string | undefined): SessionType {
  return sessionType === 'pty' ? 'pty' : 'stream'
}

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
  const { data: skills, isLoading: skillsLoading } = useSkills()
  const machineList = machines ?? []
  const skillList = skills ?? []

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [schedule, setSchedule] = useState('')
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState<ClaudePermissionMode>('acceptEdits')
  const [task, setTask] = useState('')
  const [timezone, setTimezone] = useState(() => detectBrowserTimezone())
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [selectedHost, setSelectedHost] = useState('')
  const [selectedSkill, setSelectedSkill] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [editingTask, setEditingTask] = useState<EditableTaskState | null>(null)
  const [editPendingTaskId, setEditPendingTaskId] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const remoteMachines = machineList.filter((machine) => machine.host)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateError(null)
    try {
      const createInput: CreateCronTaskInput & { description?: string } = {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        schedule: schedule.trim(),
        timezone: timezone.trim() || undefined,
        machine: selectedHost,
        workDir: cwd.trim(),
        agentType: agentType as CommandRoomAgentType,
        instruction: task.trim(),
        enabled: true,
        permissionMode: mode,
        sessionType,
      }
      await onCreate(createInput)
      setName('')
      setDescription('')
      setSchedule('')
      setTimezone(detectBrowserTimezone())
      setCwd('')
      setMode('acceptEdits')
      setTask('')
      setAgentType('claude')
      setSessionType('stream')
      setSelectedHost('')
      setSelectedSkill('')
      setShowForm(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create task')
    }
  }

  function beginEdit(task: CronTask) {
    setEditError(null)
    setEditingTask({
      taskId: task.id,
      enabled: task.enabled,
      name: task.name,
      schedule: task.schedule,
      timezone: task.timezone ?? '',
      description: readDescription(task),
      instruction: task.instruction,
      machine: task.machine,
      workDir: task.workDir,
      agentType: task.agentType,
      permissionMode: coercePermissionMode(task.permissionMode),
      sessionType: coerceSessionType(task.sessionType),
    })
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingTask) {
      return
    }

    const trimmedName = editingTask.name.trim()
    if (!trimmedName) {
      setEditError('Task name is required')
      return
    }
    const trimmedSchedule = editingTask.schedule.trim()
    if (!trimmedSchedule) {
      setEditError('Schedule is required')
      return
    }
    const trimmedInstruction = editingTask.instruction.trim()
    if (!trimmedInstruction) {
      setEditError('Instruction is required')
      return
    }
    const trimmedWorkDir = editingTask.workDir.trim()
    if (trimmedWorkDir && !trimmedWorkDir.startsWith('/')) {
      setEditError('Working directory must be an absolute path when provided')
      return
    }

    setEditError(null)
    setEditPendingTaskId(editingTask.taskId)
    const trimmedTimezone = editingTask.timezone.trim()
    const trimmedDescription = editingTask.description.trim()
    const trimmedMachine = editingTask.machine.trim()
    const patchPayload: Record<string, unknown> = {
      name: trimmedName,
      schedule: trimmedSchedule,
      description: trimmedDescription,
      instruction: trimmedInstruction,
      agentType: editingTask.agentType as CommandRoomAgentType,
      permissionMode: editingTask.permissionMode,
      sessionType: editingTask.sessionType,
      ...(trimmedTimezone ? { timezone: trimmedTimezone } : {}),
      ...(trimmedMachine ? { machine: trimmedMachine } : {}),
      ...(trimmedWorkDir ? { workDir: trimmedWorkDir } : {}),
    }

    try {
      await fetchJson<CronTask>(`/api/command-room/tasks/${encodeURIComponent(editingTask.taskId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patchPayload),
      })
      setEditingTask(null)
      void onToggle(editingTask.taskId, editingTask.enabled)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update task')
    } finally {
      setEditPendingTaskId(null)
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
            beforeTaskField={
              <div className="space-y-3">
                <div>
                  <label className="section-title block mb-2">Description (Optional)</label>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                    placeholder="Explain what this cron task is for"
                  />
                </div>
                {agentType === 'claude' ? (
                  <div>
                    <label className="section-title block mb-2">Skill (Optional)</label>
                    <select
                      value={selectedSkill}
                      onChange={(event) => {
                        const skillName = event.target.value
                        setSelectedSkill(skillName)
                        if (!skillName) {
                          return
                        }
                        setTask((current) => prependSkillInvocation(current, skillName))
                        setSelectedSkill('')
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                    >
                      <option value="">
                        {skillsLoading
                          ? 'Loading skills...'
                          : skillList.length > 0
                            ? 'Select a skill to prepend'
                            : 'No user-invocable skills installed'}
                      </option>
                      {skillList.map((skill) => (
                        <option key={skill.name} value={skill.name}>
                          /{skill.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-whisper text-sumi-mist">
                      Selecting a skill prepends <span className="font-mono">/skill-name</span> to instruction.
                    </p>
                  </div>
                ) : null}
              </div>
            }
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
            const taskDescription = readDescription(task)
            const isEditing = editingTask?.taskId === task.id
            const isEditPending = editPendingTaskId === task.id

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
                  </div>
                </button>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash disabled:opacity-60"
                    disabled={isEditPending}
                    onClick={() => {
                      if (isEditing) {
                        setEditingTask(null)
                        setEditError(null)
                        return
                      }
                      beginEdit(task)
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
                {isEditing && editingTask ? (
                  <form onSubmit={(event) => void handleEditSubmit(event)} className="mt-3 space-y-3 border-t border-ink-border pt-3">
                    <div>
                      <label className="section-title block mb-2">Task Name</label>
                      <input
                        value={editingTask.name}
                        onChange={(event) =>
                          setEditingTask((current) => (current ? { ...current, name: event.target.value } : current))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        required
                      />
                    </div>
                    <div>
                      <label className="section-title block mb-2">Schedule</label>
                      <input
                        value={editingTask.schedule}
                        onChange={(event) =>
                          setEditingTask((current) => (current ? { ...current, schedule: event.target.value } : current))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        placeholder="0 2 * * *"
                        required
                      />
                    </div>
                    <div>
                      <label className="section-title block mb-2">Timezone</label>
                      {TIMEZONE_OPTIONS.length > 0 ? (
                        <select
                          value={editingTask.timezone}
                          onChange={(event) =>
                            setEditingTask((current) => (current ? { ...current, timezone: event.target.value } : current))
                          }
                          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        >
                          {!TIMEZONE_OPTIONS.includes(editingTask.timezone) && editingTask.timezone ? (
                            <option value={editingTask.timezone}>{editingTask.timezone}</option>
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
                          value={editingTask.timezone}
                          onChange={(event) =>
                            setEditingTask((current) => (current ? { ...current, timezone: event.target.value } : current))
                          }
                          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                          placeholder="America/Los_Angeles"
                        />
                      )}
                    </div>
                    <div>
                      <label className="section-title block mb-2">Description (Optional)</label>
                      <textarea
                        value={editingTask.description}
                        onChange={(event) =>
                          setEditingTask((current) => (current ? { ...current, description: event.target.value } : current))
                        }
                        className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        placeholder="Explain what this cron task is for"
                      />
                    </div>
                    <div>
                      <label className="section-title block mb-2">Instruction</label>
                      <textarea
                        value={editingTask.instruction}
                        onChange={(event) =>
                          setEditingTask((current) =>
                            current ? { ...current, instruction: event.target.value } : current
                          )
                        }
                        className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        required
                      />
                    </div>
                    <div>
                      <label className="section-title block mb-2">Agent</label>
                      <div className="flex gap-2">
                        {(['claude', 'codex'] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() =>
                              setEditingTask((current) => (current ? { ...current, agentType: type } : current))
                            }
                            className={cn(
                              'flex-1 text-center rounded-lg border px-3 py-2 transition-colors min-h-[44px] font-mono text-sm',
                              editingTask.agentType === type
                                ? 'border-sumi-black bg-sumi-black text-washi-aged'
                                : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                            )}
                          >
                            {type}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="section-title block mb-2">Session Type</label>
                      <div className="flex gap-2">
                        {([
                          { value: 'stream', label: 'Stream', description: 'Chat UI, supports resume' },
                          { value: 'pty', label: 'PTY', description: 'Terminal UI, no resume' },
                        ] as const).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() =>
                              setEditingTask((current) =>
                                current ? { ...current, sessionType: option.value } : current
                              )
                            }
                            className={cn(
                              'flex-1 text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                              editingTask.sessionType === option.value
                                ? 'border-sumi-black bg-sumi-black text-washi-aged'
                                : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                            )}
                          >
                            <div className="font-mono text-xs">{option.label}</div>
                            <div
                              className={cn(
                                'text-whisper mt-1',
                                editingTask.sessionType === option.value
                                  ? 'text-washi-aged/80'
                                  : 'text-sumi-diluted',
                              )}
                            >
                              {option.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="section-title block mb-2">Machine</label>
                      <select
                        value={editingTask.machine}
                        onChange={(event) =>
                          setEditingTask((current) => (current ? { ...current, machine: event.target.value } : current))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                      >
                        <option value="">Local (this server)</option>
                        {remoteMachines.map((machine) => (
                          <option key={machine.id} value={machine.id}>
                            {machine.label} ({machine.user ? `${machine.user}@` : ''}{machine.host})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="section-title block mb-2">Working Directory</label>
                      <input
                        value={editingTask.workDir}
                        onChange={(event) =>
                          setEditingTask((current) => (current ? { ...current, workDir: event.target.value } : current))
                        }
                        className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                        placeholder="/tmp/project"
                      />
                    </div>
                    <div>
                      <label className="section-title block mb-2">Permission Mode</label>
                      <div className="grid gap-2">
                        {(editingTask.agentType === 'codex' ? CODEX_MODE_OPTIONS : CLAUDE_MODE_OPTIONS).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() =>
                              setEditingTask((current) =>
                                current ? { ...current, permissionMode: option.value } : current
                              )
                            }
                            className={cn(
                              'w-full text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                              editingTask.permissionMode === option.value
                                ? 'border-sumi-black bg-sumi-black text-washi-aged'
                                : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                            )}
                          >
                            <div className="font-mono text-xs">{option.label}</div>
                            <div
                              className={cn(
                                'text-whisper mt-1',
                                editingTask.permissionMode === option.value
                                  ? 'text-washi-aged/80'
                                  : 'text-sumi-diluted',
                              )}
                            >
                              {option.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                    {editError && (
                      <p className="text-sm text-accent-vermillion">{editError}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={isEditPending}
                        className="btn-primary !px-3 !py-1.5 text-xs disabled:opacity-60"
                      >
                        {isEditPending ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash"
                        onClick={() => {
                          setEditingTask(null)
                          setEditError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
