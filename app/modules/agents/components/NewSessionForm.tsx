import { memo, type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentSession, AgentType, ClaudePermissionMode, Machine, SessionType } from '@/types'
import {
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_CLAUDE_EFFORT_LEVEL,
  type ClaudeEffortLevel,
} from '../../claude-effort.js'
import { ScheduleExpressionField } from '../../components/ScheduleExpressionField'
import { DirectoryPicker } from './DirectoryPicker'

interface OpenClawGatewayInfo {
  url: string
  authEnabled: boolean
  reachable: boolean
}

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

export const GEMINI_MODE_OPTIONS: Array<{
  value: ClaudePermissionMode
  label: string
  description: string
}> = [
  { value: 'default', label: 'default', description: 'gemini --acp (mode: default)' },
  { value: 'acceptEdits', label: 'autoEdit', description: 'gemini --acp (mode: autoEdit)' },
  {
    value: 'dangerouslySkipPermissions',
    label: 'yolo',
    description: 'gemini --acp (mode: yolo)',
  },
]

const DEFAULT_AGENT_OPTIONS: AgentType[] = ['claude', 'codex', 'gemini', 'openclaw']
const NOOP_SET_STRING = (_value: string): undefined => undefined

function getResumeSourceStateLabel(session: AgentSession | null): string {
  if (!session?.status) {
    return session?.processAlive === false ? 'exited' : 'active'
  }
  return session.status
}

function getMachineDisplayValue(session: AgentSession | null, machines: Machine[]): string {
  if (!session?.host) {
    return 'Local (this server)'
  }
  const machine = machines.find((entry) => entry.id === session.host)
  if (!machine) {
    return session.host
  }
  return `${machine.label} (${machine.user ? `${machine.user}@` : ''}${machine.host})`
}

function NewSessionFormComponent({
  name = '',
  setName = NOOP_SET_STRING,
  cwd,
  setCwd,
  mode,
  setMode,
  task,
  setTask,
  effort,
  setEffort,
  agentType,
  setAgentType,
  sessionType,
  setSessionType,
  machines,
  selectedHost,
  setSelectedHost,
  openclawAgentId = '',
  setOpenclawAgentId = NOOP_SET_STRING,
  isCreating,
  createError,
  onSubmit,
  resumeOptions,
  resumeSourceName = '',
  setResumeSourceName,
  resumeSource = null,
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
  beforeTaskField,
  afterScheduleField,
  showNameField = true,
  agentOptions = DEFAULT_AGENT_OPTIONS,
}: {
  name?: string
  setName?: (v: string) => void
  cwd: string
  setCwd: (v: string) => void
  mode: ClaudePermissionMode
  setMode: (v: ClaudePermissionMode) => void
  task: string
  setTask: (v: string) => void
  effort: ClaudeEffortLevel
  setEffort: (v: ClaudeEffortLevel) => void
  agentType: AgentType
  setAgentType: (v: AgentType) => void
  sessionType: SessionType
  setSessionType: (v: SessionType) => void
  machines: Machine[]
  selectedHost: string
  setSelectedHost: (v: string) => void
  openclawAgentId?: string
  setOpenclawAgentId?: (v: string) => void
  isCreating: boolean
  createError: string | null
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
  resumeOptions?: AgentSession[]
  resumeSourceName?: string
  setResumeSourceName?: (v: string) => void
  resumeSource?: AgentSession | null
  schedule?: string
  setSchedule?: (v: string) => void
  submitLabel?: string
  nameLabel?: string
  namePlaceholder?: string
  namePattern?: string
  taskLabel?: string
  taskPlaceholder?: string
  taskRequired?: boolean
  beforeTaskField?: ReactNode
  afterScheduleField?: ReactNode
  showNameField?: boolean
  agentOptions?: readonly AgentType[]
}) {
  const remoteMachines = machines.filter((machine) => machine.host)
  const showMachineSelector = remoteMachines.length > 0
  const resumeSelectionEnabled = Array.isArray(resumeOptions) && typeof setResumeSourceName === 'function'
  const resumeLocked = resumeSource !== null
  const [openclawAgents, setOpenclawAgents] = useState<string[]>([])
  const [openclawGatewayInfo, setOpenclawGatewayInfo] = useState<OpenClawGatewayInfo | null>(null)
  const showOpenClaw = agentOptions.includes('openclaw')

  useEffect(() => {
    if (agentOptions.includes(agentType)) {
      return
    }
    const fallbackAgent = agentOptions[0]
    if (fallbackAgent) {
      setAgentType(fallbackAgent)
    }
  }, [agentOptions, agentType, setAgentType])

  useEffect(() => {
    if (!showOpenClaw || agentType !== 'openclaw') return
    let cancelled = false
    fetch('/api/agents/openclaw/agents')
      .then((r) => r.ok ? r.json() as Promise<{ agents: Array<{ id: string }> }> : Promise.resolve({ agents: [] }))
      .then((data) => {
        if (!cancelled) {
          const ids = data.agents.map((a) => a.id).filter(Boolean)
          setOpenclawAgents(ids)
          if (ids.length > 0 && !ids.includes(openclawAgentId)) {
            setOpenclawAgentId(ids[0])
          }
        }
      })
      .catch(() => { if (!cancelled) setOpenclawAgents([]) })
    return () => { cancelled = true }
  }, [agentType, openclawAgentId, setOpenclawAgentId, showOpenClaw])

  useEffect(() => {
    if (!showOpenClaw || agentType !== 'openclaw') return
    let cancelled = false
    setOpenclawGatewayInfo(null)

    fetch('/api/agents/openclaw/gateway-info')
      .then((r) => r.ok ? r.json() as Promise<OpenClawGatewayInfo> : Promise.reject(new Error('Failed to load gateway info')))
      .then((data) => {
        if (!cancelled) {
          setOpenclawGatewayInfo(data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpenclawGatewayInfo({
            url: 'Unavailable',
            authEnabled: false,
            reachable: false,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentType, showOpenClaw])

  useEffect(() => {
    if (agentType === 'gemini' && sessionType !== 'stream') {
      setSessionType('stream')
    }
  }, [agentType, sessionType, setSessionType])

  useEffect(() => {
    if (agentType !== 'claude' && effort !== DEFAULT_CLAUDE_EFFORT_LEVEL) {
      setEffort(DEFAULT_CLAUDE_EFFORT_LEVEL)
    }
  }, [agentType, effort, setEffort])

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="section-title block mb-2">Agent</label>
        <div className="flex gap-2">
          {agentOptions.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setAgentType(type)}
              disabled={resumeLocked}
              className={cn(
                'flex-1 text-center rounded-lg border px-3 py-2 transition-colors min-h-[44px] font-mono text-sm',
                agentType === type
                  ? 'border-sumi-black bg-sumi-black text-washi-aged'
                  : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                resumeLocked && 'cursor-not-allowed opacity-60 hover:border-ink-border',
              )}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {agentType !== 'openclaw' && (
        <div>
          <label className="section-title block mb-2">Session Type</label>
          <div className="flex gap-2">
            {(
              agentType === 'gemini'
                ? [{ value: 'stream', label: 'Stream', description: 'ACP chat UI, supports resume' }]
                : [
                    { value: 'stream', label: 'Stream', description: 'Chat UI, supports resume' },
                    { value: 'pty', label: 'PTY', description: 'Terminal UI, no resume' },
                  ]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSessionType(option.value as SessionType)}
                disabled={resumeLocked}
                className={cn(
                  'flex-1 text-left rounded-lg border px-3 py-2 transition-colors min-h-[44px]',
                  sessionType === option.value
                    ? 'border-sumi-black bg-sumi-black text-washi-aged'
                    : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                  resumeLocked && 'cursor-not-allowed opacity-60 hover:border-ink-border',
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
          {agentType === 'gemini' && (
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-700">
              <span>Gemini uses ACP-backed stream sessions only.</span>
            </div>
          )}
        </div>
      )}

      {resumeSelectionEnabled && (
        <div>
          <label className="section-title block mb-2">Resume From Previous Session</label>
          <select
            value={resumeSourceName}
            onChange={(event) => setResumeSourceName?.(event.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          >
            <option value="">— Start fresh —</option>
            {(resumeOptions ?? []).map((session) => (
              <option key={session.name} value={session.name}>
                {session.name} · {session.agentType ?? 'claude'} · {getResumeSourceStateLabel(session)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-whisper text-sumi-mist">
            Only resumable Claude, Codex, and Gemini sessions appear here.
          </p>
          {resumeSource && (
            <div className="mt-2 rounded-lg border border-ink-border bg-washi-aged/70 px-3 py-2 text-sm text-sumi-gray">
              <div className="font-mono text-xs text-sumi-black">{resumeSource.name}</div>
              <div className="mt-1 text-whisper">State: {getResumeSourceStateLabel(resumeSource)}</div>
              <div className="text-whisper">Machine: {getMachineDisplayValue(resumeSource, machines)}</div>
              <div className="text-whisper break-all">Workspace: {resumeSource.cwd ?? 'Home directory'}</div>
              <div className="mt-1 text-whisper text-sumi-mist">
                Agent, session type, machine, and workspace are locked to the selected source.
              </div>
            </div>
          )}
        </div>
      )}

      {showOpenClaw && agentType === 'openclaw' && (
        <div>
          <label className="section-title block mb-2">Gateway</label>
          <div className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-sm flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'inline-block h-2.5 w-2.5 rounded-full shrink-0',
                openclawGatewayInfo?.reachable ? 'bg-emerald-500' : 'bg-accent-vermillion',
              )}
            />
            <span className="font-mono break-all">{openclawGatewayInfo?.url ?? 'Loading...'}</span>
          </div>

          <label className="section-title block mt-3 mb-2">Agent ID</label>
          {openclawAgents.length > 0 ? (
            <select
              value={openclawAgentId}
              onChange={(event) => setOpenclawAgentId(event.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            >
              {openclawAgents.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          ) : (
            <input
              value={openclawAgentId}
              onChange={(event) => setOpenclawAgentId(event.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              placeholder="main"
            />
          )}
          <p className="mt-1 text-whisper text-sumi-mist">
            Agent must be configured in your OpenClaw gateway. Default agent is `main`.
          </p>
        </div>
      )}

      {agentType !== 'openclaw' && showMachineSelector && (
        <div>
          <label className="section-title block mb-2">Machine</label>
          {resumeLocked ? (
            <div className="w-full rounded-lg border border-ink-border bg-washi-aged px-3 py-2 text-sm text-sumi-black">
              {getMachineDisplayValue(resumeSource, machines)}
            </div>
          ) : (
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
          )}
        </div>
      )}

      {showNameField && (
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
      )}

      {schedule !== undefined && setSchedule && (
        <ScheduleExpressionField
          schedule={schedule}
          onScheduleChange={setSchedule}
        />
      )}

      {afterScheduleField}

      <div>
        <label className="section-title block mb-2">Working Directory</label>
        {resumeLocked ? (
          <div className="rounded-lg border border-ink-border bg-washi-aged px-3 py-2 font-mono text-[16px] text-sumi-black md:text-sm">
            {cwd || '~'}
          </div>
        ) : (
          <DirectoryPicker value={cwd} onChange={setCwd} host={selectedHost || undefined} />
        )}
      </div>

      {agentType !== 'openclaw' && (
      <div>
        <label className="section-title block mb-2">Permission Mode</label>
        <div className="grid gap-2">
          {(agentType === 'codex'
            ? CODEX_MODE_OPTIONS
            : (agentType === 'gemini' ? GEMINI_MODE_OPTIONS : CLAUDE_MODE_OPTIONS)).map((option) => (
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
      )}

      {agentType === 'claude' && (
        <div>
          <label className="section-title block mb-2">Claude Effort</label>
          <select
            value={effort}
            onChange={(event) => setEffort(event.target.value as ClaudeEffortLevel)}
            disabled={resumeLocked}
            className={cn(
              'w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover',
              resumeLocked && 'cursor-not-allowed opacity-60',
            )}
          >
            {CLAUDE_EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
          <p className="mt-1 text-whisper text-sumi-mist">
            Default is `max`. Resume reuses the selected session’s Claude effort.
          </p>
        </div>
      )}

      {beforeTaskField}

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

export const NewSessionForm = memo(NewSessionFormComponent)
NewSessionForm.displayName = 'NewSessionForm'
