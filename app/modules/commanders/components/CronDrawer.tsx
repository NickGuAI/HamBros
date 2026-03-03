import { type FormEvent, useMemo, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMachines } from '@/hooks/use-agents'
import type { AgentType, ClaudePermissionMode, SessionType } from '@/types'
import type { CommanderCronTask, CommanderSession } from '../hooks/useCommander'
import { DirectoryPicker } from '../../agents/components/DirectoryPicker'

const WEEKDAYS: Record<string, string> = {
  '0': 'Sunday',
  '1': 'Monday',
  '2': 'Tuesday',
  '3': 'Wednesday',
  '4': 'Thursday',
  '5': 'Friday',
  '6': 'Saturday',
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
}

function formatTwoDigit(value: string): string {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? String(parsed).padStart(2, '0') : value
}

function cronPreview(expression: string): string {
  const trimmed = expression.trim()
  if (trimmed.length === 0) {
    return 'Enter a cron expression'
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return 'Invalid: expected 5 fields'
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = minute.slice(2)
    if (isIntegerInRange(interval, 1, 59)) {
      return `every ${interval} minutes`
    }
  }

  if (isIntegerInRange(minute, 0, 59) && isIntegerInRange(hour, 0, 23)) {
    if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      return `every day at ${formatTwoDigit(hour)}:${formatTwoDigit(minute)}`
    }

    if (dayOfMonth === '*' && month === '*' && dayOfWeek in WEEKDAYS) {
      return `every ${WEEKDAYS[dayOfWeek]} at ${formatTwoDigit(hour)}:${formatTwoDigit(minute)}`
    }
  }

  return 'custom schedule'
}

function nextRunLabel(nextRun: string | null, enabled: boolean): string {
  if (!enabled) {
    return 'paused'
  }
  if (!nextRun) {
    return 'pending'
  }
  const parsed = new Date(nextRun)
  if (Number.isNaN(parsed.getTime())) {
    return 'pending'
  }
  return parsed.toLocaleString()
}

const CLAUDE_MODE_OPTIONS: Array<{ value: ClaudePermissionMode; label: string; description: string }> = [
  { value: 'default', label: 'default', description: 'claude' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'claude --acceptEdits' },
  { value: 'dangerouslySkipPermissions', label: 'dangerouslySkipPermissions', description: 'claude --dangerously-skip-permissions' },
]

const CODEX_MODE_OPTIONS: Array<{ value: ClaudePermissionMode; label: string; description: string }> = [
  { value: 'default', label: 'default', description: 'codex' },
  { value: 'acceptEdits', label: '--full-auto', description: 'codex --full-auto' },
  { value: 'dangerouslySkipPermissions', label: '--dangerously-bypass-approvals-and-sandbox', description: 'codex --dangerously-bypass-approvals-and-sandbox' },
]

export function CronDrawer({
  commander,
  crons,
  loading,
  error,
  onAddCron,
  onDeleteCron,
  onToggleCron,
  addCronPending,
  toggleCronPending,
  deleteCronPending,
}: {
  commander: CommanderSession | null
  crons: CommanderCronTask[]
  loading: boolean
  error: string | null
  onAddCron: (input: {
    commanderId: string
    schedule: string
    instruction: string
    enabled?: boolean
    agentType?: AgentType
    sessionType?: SessionType
    permissionMode?: string
    workDir?: string
    machine?: string
  }) => Promise<void>
  onDeleteCron: (input: { commanderId: string; cronId: string }) => Promise<void>
  onToggleCron: (input: { commanderId: string; cronId: string; enabled: boolean }) => Promise<void>
  addCronPending: boolean
  toggleCronPending: boolean
  deleteCronPending: boolean
}) {
  const { data: machines } = useMachines()
  const machineList = machines ?? []
  const remoteMachines = machineList.filter((m) => m.host)

  const [scheduleInput, setScheduleInput] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [enabledInput, setEnabledInput] = useState(true)
  const [agentType, setAgentType] = useState<AgentType>('claude')
  const [sessionType, setSessionType] = useState<SessionType>('stream')
  const [workDir, setWorkDir] = useState('')
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>('default')
  const [selectedHost, setSelectedHost] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const preview = useMemo(() => cronPreview(scheduleInput), [scheduleInput])

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!commander) {
      return
    }

    const schedule = scheduleInput.trim()
    const instruction = taskInput.trim()
    if (!schedule || !instruction) {
      setActionError('Schedule and task are required.')
      return
    }

    setActionError(null)
    try {
      await onAddCron({
        commanderId: commander.id,
        schedule,
        instruction,
        enabled: enabledInput,
        agentType,
        sessionType,
        permissionMode,
        workDir: workDir.trim() || undefined,
        machine: selectedHost || undefined,
      })
      setScheduleInput('')
      setTaskInput('')
      setEnabledInput(true)
      setAgentType('claude')
      setSessionType('stream')
      setWorkDir('')
      setPermissionMode('default')
      setSelectedHost('')
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to add schedule')
    }
  }

  async function handleToggle(cron: CommanderCronTask): Promise<void> {
    if (!commander) {
      return
    }

    setActionError(null)
    try {
      await onToggleCron({
        commanderId: commander.id,
        cronId: cron.id,
        enabled: !cron.enabled,
      })
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to update schedule')
    }
  }

  async function handleDelete(cron: CommanderCronTask): Promise<void> {
    if (!commander) {
      return
    }

    setActionError(null)
    try {
      await onDeleteCron({
        commanderId: commander.id,
        cronId: cron.id,
      })
    } catch (caughtError) {
      setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to delete schedule')
    }
  }

  const modeOptions = agentType === 'codex' ? CODEX_MODE_OPTIONS : CLAUDE_MODE_OPTIONS

  return (
    <section className="card-sumi h-full overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60">
        <h3 className="section-title">Cron Schedule</h3>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {!commander && (
          <p className="text-sm text-sumi-diluted">Select a commander to manage schedules.</p>
        )}

        {commander && loading && crons.length === 0 && (
          <div className="flex items-center justify-center h-20">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commander && crons.map((cron) => (
          <div key={cron.id} className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-sumi-black truncate">{cron.schedule}</p>
                <p className="text-whisper text-sumi-diluted mt-1">{cronPreview(cron.schedule)}</p>
                {(cron.agentType || cron.permissionMode) && (
                  <p className="text-whisper text-sumi-mist mt-1">
                    {[cron.agentType, cron.permissionMode].filter(Boolean).join(' · ')}
                  </p>
                )}
                <p className="text-sm text-sumi-gray mt-2 line-clamp-2">{cron.instruction}</p>
                <p className="text-whisper text-sumi-mist mt-1">next run: {nextRunLabel(cron.nextRun, cron.enabled)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleToggle(cron)}
                  disabled={toggleCronPending}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
                    cron.enabled
                      ? 'border-accent-moss/40 text-accent-moss hover:bg-accent-moss/10'
                      : 'border-ink-border text-sumi-diluted hover:bg-ink-wash',
                  )}
                >
                  {cron.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(cron)}
                  disabled={deleteCronPending}
                  className="rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {commander && (
          <form onSubmit={(event) => void handleSubmit(event)} className="rounded-lg border border-dashed border-ink-border p-3 space-y-3">
            <p className="text-sm text-sumi-gray">Add schedule</p>

            <div>
              <label className="section-title block mb-2">Agent</label>
              <div className="flex gap-2">
                {(['claude', 'codex'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setAgentType(type)
                      setPermissionMode('default')
                    }}
                    className={cn(
                      'flex-1 text-center rounded-lg border px-3 py-2 transition-colors min-h-[44px] font-mono text-sm',
                      agentType === type
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
                    onClick={() => setSessionType(option.value)}
                    className={cn(
                      'flex-1 text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                      sessionType === option.value
                        ? 'border-sumi-black bg-sumi-black text-washi-aged'
                        : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                    )}
                  >
                    <div className="font-mono text-xs">{option.label}</div>
                    <div className={cn('text-whisper mt-1', sessionType === option.value ? 'text-washi-aged/80' : 'text-sumi-diluted')}>
                      {option.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {remoteMachines.length > 0 && (
              <div>
                <label className="section-title block mb-2">Machine</label>
                <select
                  value={selectedHost}
                  onChange={(event) => setSelectedHost(event.target.value)}
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
            )}

            <div>
              <label className="section-title block mb-2">Working Directory</label>
              <DirectoryPicker value={workDir} onChange={setWorkDir} host={selectedHost || undefined} />
            </div>

            <div>
              <label className="section-title block mb-2">Permission Mode</label>
              <div className="grid gap-2">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPermissionMode(option.value)}
                    className={cn(
                      'w-full text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                      permissionMode === option.value
                        ? 'border-sumi-black bg-sumi-black text-washi-aged'
                        : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                    )}
                  >
                    <div className="font-mono text-xs">{option.label}</div>
                    <div className={cn('text-whisper mt-1', permissionMode === option.value ? 'text-washi-aged/80' : 'text-sumi-diluted')}>
                      {option.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="section-title block mb-2">Schedule</label>
              <input
                value={scheduleInput}
                onChange={(event) => setScheduleInput(event.target.value)}
                placeholder="0 2 * * *"
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
              <p className="mt-1 text-whisper text-sumi-mist">{preview}</p>
            </div>

            <div>
              <label className="section-title block mb-2">Task</label>
              <textarea
                value={taskInput}
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Run nightly tests"
                className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-sumi-diluted">
              <input
                type="checkbox"
                checked={enabledInput}
                onChange={(event) => setEnabledInput(event.target.checked)}
              />
              enabled
            </label>

            {actionError && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={addCronPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <Plus size={14} />
              {addCronPending ? 'Adding...' : 'Add Schedule'}
            </button>
          </form>
        )}
      </div>

      {error && (
        <p className="border-t border-ink-border px-4 py-2 text-sm text-accent-vermillion">
          {error}
        </p>
      )}
    </section>
  )
}
