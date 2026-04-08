import { type FormEvent, useState } from 'react'
import { fetchJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { AgentType, ClaudePermissionMode, Machine, SessionType } from '@/types'
import type { CommandRoomAgentType, CronTask } from '../hooks/useCommandRoom'
import { CLAUDE_MODE_OPTIONS, CODEX_MODE_OPTIONS } from '../../agents/components/NewSessionForm'

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

const TIMEZONE_OPTIONS = listIanaTimezones()
const MODEL_OPTIONS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-3-5',
] as const

type CronTaskWithDescription = CronTask & { description?: string }

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

interface EditableTaskState {
  enabled: boolean
  name: string
  schedule: string
  timezone: string
  description: string
  instruction: string
  model: string
  machine: string
  workDir: string
  agentType: AgentType
  permissionMode: ClaudePermissionMode
  sessionType: SessionType
}

interface EditTaskFormProps {
  task: CronTask
  machines: Machine[]
  onSaved: (taskId: string, enabled: boolean) => void
  onCancel: () => void
}

export function EditTaskForm({ task, machines, onSaved, onCancel }: EditTaskFormProps) {
  const remoteMachines = machines.filter((machine) => machine.host)

  const [editState, setEditState] = useState<EditableTaskState>(() => ({
    enabled: task.enabled,
    name: task.name,
    schedule: task.schedule,
    timezone: task.timezone ?? '',
    description: readDescription(task),
    instruction: task.instruction,
    model: task.model ?? '',
    machine: task.machine,
    workDir: task.workDir,
    agentType: task.agentType,
    permissionMode: coercePermissionMode(task.permissionMode),
    sessionType: coerceSessionType(task.sessionType),
  }))
  const [editPending, setEditPending] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  function update(patch: Partial<EditableTaskState>) {
    setEditState((current) => ({ ...current, ...patch }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = editState.name.trim()
    if (!trimmedName) {
      setEditError('Task name is required')
      return
    }
    const trimmedSchedule = editState.schedule.trim()
    if (!trimmedSchedule) {
      setEditError('Schedule is required')
      return
    }
    const trimmedInstruction = editState.instruction.trim()
    if (!trimmedInstruction) {
      setEditError('Instruction is required')
      return
    }
    const trimmedWorkDir = editState.workDir.trim()
    if (trimmedWorkDir && !trimmedWorkDir.startsWith('/')) {
      setEditError('Working directory must be an absolute path when provided')
      return
    }

    setEditError(null)
    setEditPending(true)
    const trimmedTimezone = editState.timezone.trim()
    const trimmedDescription = editState.description.trim()
    const trimmedMachine = editState.machine.trim()
    const trimmedModel = editState.model.trim()
    const patchPayload: Record<string, unknown> = {
      name: trimmedName,
      schedule: trimmedSchedule,
      description: trimmedDescription,
      instruction: trimmedInstruction,
      model: trimmedModel.length > 0 ? trimmedModel : null,
      agentType: editState.agentType as CommandRoomAgentType,
      permissionMode: editState.permissionMode,
      sessionType: editState.sessionType,
      ...(trimmedTimezone ? { timezone: trimmedTimezone } : {}),
      ...(trimmedMachine ? { machine: trimmedMachine } : {}),
      ...(trimmedWorkDir ? { workDir: trimmedWorkDir } : {}),
    }

    try {
      await fetchJson<CronTask>(`/api/command-room/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patchPayload),
      })
      onSaved(task.id, editState.enabled)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update task')
    } finally {
      setEditPending(false)
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-3 space-y-3 border-t border-ink-border pt-3">
      <div>
        <label className="section-title block mb-2">Task Name</label>
        <input
          value={editState.name}
          onChange={(event) => update({ name: event.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          required
        />
      </div>
      <div>
        <label className="section-title block mb-2">Schedule</label>
        <input
          value={editState.schedule}
          onChange={(event) => update({ schedule: event.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="0 2 * * *"
          required
        />
      </div>
      <div>
        <label className="section-title block mb-2">Timezone</label>
        {TIMEZONE_OPTIONS.length > 0 ? (
          <select
            value={editState.timezone}
            onChange={(event) => update({ timezone: event.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          >
            {!TIMEZONE_OPTIONS.includes(editState.timezone) && editState.timezone ? (
              <option value={editState.timezone}>{editState.timezone}</option>
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
            value={editState.timezone}
            onChange={(event) => update({ timezone: event.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            placeholder="America/Los_Angeles"
          />
        )}
      </div>
      <div>
        <label className="section-title block mb-2">Description (Optional)</label>
        <textarea
          value={editState.description}
          onChange={(event) => update({ description: event.target.value })}
          className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="Explain what this cron task is for"
        />
      </div>
      <div>
        <label className="section-title block mb-2">Instruction</label>
        <textarea
          value={editState.instruction}
          onChange={(event) => update({ instruction: event.target.value })}
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
              onClick={() => update({ agentType: type })}
              className={cn(
                'flex-1 text-center rounded-lg border px-3 py-2 transition-colors min-h-[44px] font-mono text-sm',
                editState.agentType === type
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
        <label className="section-title block mb-2">Model</label>
        <select
          value={editState.model}
          onChange={(event) => update({ model: event.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
        >
          <option value="">— Default —</option>
          {MODEL_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
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
              onClick={() => update({ sessionType: option.value })}
              className={cn(
                'flex-1 text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                editState.sessionType === option.value
                  ? 'border-sumi-black bg-sumi-black text-washi-aged'
                  : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
              )}
            >
              <div className="font-mono text-xs">{option.label}</div>
              <div
                className={cn(
                  'text-whisper mt-1',
                  editState.sessionType === option.value
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
          value={editState.machine}
          onChange={(event) => update({ machine: event.target.value })}
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
          value={editState.workDir}
          onChange={(event) => update({ workDir: event.target.value })}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder="/tmp/project"
        />
      </div>
      <div>
        <label className="section-title block mb-2">Permission Mode</label>
        <div className="grid gap-2">
          {(editState.agentType === 'codex' ? CODEX_MODE_OPTIONS : CLAUDE_MODE_OPTIONS).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => update({ permissionMode: option.value })}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                editState.permissionMode === option.value
                  ? 'border-sumi-black bg-sumi-black text-washi-aged'
                  : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
              )}
            >
              <div className="font-mono text-xs">{option.label}</div>
              <div
                className={cn(
                  'text-whisper mt-1',
                  editState.permissionMode === option.value
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
          disabled={editPending}
          className="btn-primary !px-3 !py-1.5 text-xs disabled:opacity-60"
        >
          {editPending ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="px-2.5 py-1.5 rounded-md border border-ink-border text-xs hover:bg-ink-wash"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
