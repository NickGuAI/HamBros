import { type FormEvent } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentType, ClaudePermissionMode, Machine, SessionType } from '@/types'
import { DirectoryPicker } from './DirectoryPicker'

export const CLAUDE_MODE_OPTIONS: Array<{
  value: ClaudePermissionMode
  label: string
  description: string
}> = [
  { value: 'default', label: 'default', description: 'claude' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'claude --acceptEdits' },
  {
    value: 'dangerouslySkipPermissions',
    label: 'dangerouslySkipPermissions',
    description: 'claude --dangerously-skip-permissions',
  },
]

export const CODEX_MODE_OPTIONS: Array<{
  value: ClaudePermissionMode
  label: string
  description: string
}> = [
  { value: 'default', label: 'default', description: 'codex' },
  { value: 'acceptEdits', label: '--full-auto', description: 'codex --full-auto' },
  {
    value: 'dangerouslySkipPermissions',
    label: '--dangerously-bypass-approvals-and-sandbox',
    description: 'codex --dangerously-bypass-approvals-and-sandbox',
  },
]

export function NewSessionForm({
  name,
  setName,
  cwd,
  setCwd,
  mode,
  setMode,
  task,
  setTask,
  agentType,
  setAgentType,
  sessionType,
  setSessionType,
  machines,
  selectedHost,
  setSelectedHost,
  isCreating,
  createError,
  onSubmit,
  // cron/context-specific overrides
  schedule,
  setSchedule,
  submitLabel = 'Start Session',
  nameLabel = 'Session Name',
  namePlaceholder = 'agent-fix-auth',
  namePattern = '[a-zA-Z0-9_\\-]+',
  taskLabel = 'Initial Task (Optional)',
  taskPlaceholder = 'Fix the auth bug in login.ts',
  taskRequired = false,
}: {
  name: string
  setName: (v: string) => void
  cwd: string
  setCwd: (v: string) => void
  mode: ClaudePermissionMode
  setMode: (v: ClaudePermissionMode) => void
  task: string
  setTask: (v: string) => void
  agentType: AgentType
  setAgentType: (v: AgentType) => void
  sessionType: SessionType
  setSessionType: (v: SessionType) => void
  machines: Machine[]
  selectedHost: string
  setSelectedHost: (v: string) => void
  isCreating: boolean
  createError: string | null
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
  schedule?: string
  setSchedule?: (v: string) => void
  submitLabel?: string
  nameLabel?: string
  namePlaceholder?: string
  namePattern?: string
  taskLabel?: string
  taskPlaceholder?: string
  taskRequired?: boolean
}) {
  const remoteMachines = machines.filter((machine) => machine.host)
  const showMachineSelector = remoteMachines.length > 0

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="section-title block mb-2">Agent</label>
        <div className="flex gap-2">
          {(['claude', 'codex'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setAgentType(type)}
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
              <div
                className={cn(
                  'text-whisper mt-1',
                  sessionType === option.value ? 'text-washi-aged/80' : 'text-sumi-diluted',
                )}
              >
                {option.description}
              </div>
            </button>
          ))}
        </div>
        {sessionType === 'pty' && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>PTY sessions cannot be resumed after server restart</span>
          </div>
        )}
      </div>

      {showMachineSelector && (
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
        <label className="section-title block mb-2">{nameLabel}</label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder={namePlaceholder}
          required
          pattern={namePattern || undefined}
          title={namePattern ? 'Alphanumeric, underscore, and hyphen only' : undefined}
        />
      </div>

      {schedule !== undefined && setSchedule && (
        <div>
          <label className="section-title block mb-2">Schedule</label>
          <input
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            placeholder="0 2 * * *"
            required
          />
          <p className="mt-1 text-whisper text-sumi-mist">Standard 5-field cron expression</p>
        </div>
      )}

      <div>
        <label className="section-title block mb-2">Working Directory</label>
        <DirectoryPicker value={cwd} onChange={setCwd} host={selectedHost || undefined} />
      </div>

      <div>
        <label className="section-title block mb-2">Permission Mode</label>
        <div className="grid gap-2">
          {(agentType === 'codex' ? CODEX_MODE_OPTIONS : CLAUDE_MODE_OPTIONS).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setMode(option.value)}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                mode === option.value
                  ? 'border-sumi-black bg-sumi-black text-washi-aged'
                  : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
              )}
            >
              <div className="font-mono text-xs">{option.label}</div>
              <div
                className={cn(
                  'text-whisper mt-1',
                  mode === option.value ? 'text-washi-aged/80' : 'text-sumi-diluted',
                )}
              >
                {option.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="section-title block mb-2">{taskLabel}</label>
        <textarea
          value={task}
          onChange={(event) => setTask(event.target.value)}
          className="w-full min-h-24 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          placeholder={taskPlaceholder}
          required={taskRequired}
        />
      </div>

      {createError && (
        <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          <AlertTriangle size={15} className="mt-0.5" />
          <span>{createError}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={isCreating}
        className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        <Plus size={14} />
        {isCreating ? 'Working...' : submitLabel}
      </button>
    </form>
  )
}
