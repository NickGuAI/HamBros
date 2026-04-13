import { useState, type FormEvent } from 'react'
import {
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_CLAUDE_EFFORT_LEVEL,
  type ClaudeEffortLevel,
} from '../../claude-effort.js'
import type { CommanderCreateInput } from '../hooks/useCommander'
import { CommanderMdPreview } from './CommanderMdPreview'

const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const MIN_HEARTBEAT_MINUTES = 1
const DEFAULT_HEARTBEAT_MINUTES = 15
const MS_PER_MINUTE = 60_000

declare module '../hooks/useCommander' {
  interface CommanderCreateInput {
    displayName?: string
    agentType?: 'claude' | 'codex' | 'gemini'
    effort?: ClaudeEffortLevel
    persona?: string
    avatarSeed?: string
    heartbeat?: {
      intervalMs: number
      messageTemplate?: string
    }
    contextConfig?: {
      fatPinInterval?: number
    }
    taskSource?: {
      owner: string
      repo: string
      label?: string
      project?: string
    }
  }
}

const INPUT_CLASS =
  'w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20 placeholder:text-sumi-mist'

const LABEL_CLASS = 'text-whisper uppercase tracking-wide text-sumi-diluted'

export function CreateCommanderForm({
  onAdd,
  isPending,
  onClose,
}: {
  onAdd: (input: CommanderCreateInput) => Promise<void>
  isPending: boolean
  onClose?: () => void
}) {
  // Identity
  const [host, setHost] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [agentType, setAgentType] = useState<'claude' | 'codex' | 'gemini'>('claude')
  const [effort, setEffort] = useState<ClaudeEffortLevel>(DEFAULT_CLAUDE_EFFORT_LEVEL)

  // Working directory
  const [cwd, setCwd] = useState('')

  // Persona
  const [persona, setPersona] = useState('')

  // Avatar
  const [avatarSeed, setAvatarSeed] = useState('')

  // Heartbeat
  const [heartbeatMinutes, setHeartbeatMinutes] = useState(String(DEFAULT_HEARTBEAT_MINUTES))
  const [messageTemplate, setMessageTemplate] = useState('')
  const [fatPinInterval, setFatPinInterval] = useState('')

  // Task source
  const [showTaskSource, setShowTaskSource] = useState(false)
  const [taskOwner, setTaskOwner] = useState('')
  const [taskRepo, setTaskRepo] = useState('')
  const [taskLabel, setTaskLabel] = useState('')
  const [taskProject, setTaskProject] = useState('')

  const [actionError, setActionError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    const trimmedHost = host.trim()

    if (!trimmedHost) {
      setActionError('Host is required.')
      return
    }

    if (!HOST_PATTERN.test(trimmedHost)) {
      setActionError('Host must only contain letters, numbers, hyphens, and underscores.')
      return
    }

    const parsedHeartbeatMinutes = Number.parseInt(heartbeatMinutes.trim(), 10)
    if (!Number.isFinite(parsedHeartbeatMinutes) || parsedHeartbeatMinutes < MIN_HEARTBEAT_MINUTES) {
      setActionError('Heartbeat interval must be at least 1 minute.')
      return
    }

    const parsedFatPinInterval = fatPinInterval.trim() ? Number.parseInt(fatPinInterval.trim(), 10) : 0
    if (fatPinInterval.trim() && (!Number.isFinite(parsedFatPinInterval) || parsedFatPinInterval < 1)) {
      setActionError('Fat context interval must be at least 1 heartbeat if provided.')
      return
    }

    const trimmedCwd = cwd.trim() || undefined
    const trimmedPersona = persona.trim() || undefined

    setActionError(null)
    try {
      const createInput: CommanderCreateInput = {
        host: trimmedHost,
        displayName: displayName.trim() || undefined,
        agentType,
        effort,
        cwd: trimmedCwd,
        persona: trimmedPersona,
        avatarSeed: avatarSeed.trim() || undefined,
        heartbeat: {
          intervalMs: parsedHeartbeatMinutes * MS_PER_MINUTE,
          messageTemplate: messageTemplate.trim() || undefined,
        },
        contextConfig: parsedFatPinInterval > 0
          ? { fatPinInterval: parsedFatPinInterval }
          : undefined,
        taskSource: (taskOwner.trim() && taskRepo.trim())
          ? {
              owner: taskOwner.trim(),
              repo: taskRepo.trim(),
              label: taskLabel.trim() || undefined,
              project: taskProject.trim() || undefined,
            }
          : undefined,
      }

      await onAdd(createInput)

      // Reset all fields on success
      setHost('')
      setDisplayName('')
      setAgentType('claude')
      setEffort(DEFAULT_CLAUDE_EFFORT_LEVEL)
      setCwd('')
      setPersona('')
      setAvatarSeed('')
      setHeartbeatMinutes(String(DEFAULT_HEARTBEAT_MINUTES))
      setMessageTemplate('')
      setFatPinInterval('')
      setShowTaskSource(false)
      setTaskOwner('')
      setTaskRepo('')
      setTaskLabel('')
      setTaskProject('')
      onClose?.()
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes('(409)')) {
        setActionError(`Host "${trimmedHost}" already exists.`)
      } else {
        setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to create commander.')
      }
    }
  }

  const parsedHeartbeatMs =
    Number.parseInt(heartbeatMinutes.trim(), 10) * MS_PER_MINUTE

  const parsedFatPin = fatPinInterval.trim()
    ? Number.parseInt(fatPinInterval.trim(), 10)
    : undefined

  const previewTaskSource =
    taskOwner.trim() && taskRepo.trim()
      ? {
          owner: taskOwner.trim(),
          repo: taskRepo.trim(),
          label: taskLabel.trim() || undefined,
          project: taskProject.trim() || undefined,
        }
      : undefined

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="rounded-lg border border-dashed border-ink-border p-4"
    >
      <div className="flex flex-col lg:flex-row gap-5">
        {/* Left — form fields */}
        <div className="flex-1 min-w-0 space-y-4">
          <p className="text-sm text-sumi-gray">New commander</p>

      {/* Identity */}
      <div className="space-y-2">
        <p className={LABEL_CLASS}>Identity</p>

        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="host (e.g. my-agent-1)"
          className={INPUT_CLASS}
        />

        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Display name (defaults to host)"
          className={INPUT_CLASS}
        />

        <label className="block">
          <span className={`${LABEL_CLASS} mb-1 block`}>Agent type</span>
          <select
            value={agentType}
            onChange={(event) => setAgentType(event.target.value as 'claude' | 'codex' | 'gemini')}
            className={INPUT_CLASS}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="gemini">gemini</option>
          </select>
        </label>

        <label className="block">
          <span className={`${LABEL_CLASS} mb-1 block`}>Claude effort</span>
          <select
            value={effort}
            onChange={(event) => setEffort(event.target.value as ClaudeEffortLevel)}
            className={INPUT_CLASS}
          >
            {CLAUDE_EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>

        <input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="Working directory (optional, e.g. /home/user/project)"
          className={INPUT_CLASS}
        />
      </div>

      {/* Persona */}
      <label className="block">
        <span className={`${LABEL_CLASS} mb-1 block`}>Persona</span>
        <textarea
          rows={4}
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
          placeholder="Senior engineer who owns infra"
          style={{ resize: 'vertical' }}
          className={INPUT_CLASS}
        />
      </label>

      {/* Avatar seed */}
      <label className="block">
        <span className={`${LABEL_CLASS} mb-1 block`}>Avatar</span>
        <input
          value={avatarSeed}
          onChange={(event) => setAvatarSeed(event.target.value)}
          placeholder="Avatar seed (optional)"
          className={INPUT_CLASS}
        />
      </label>

      {/* Heartbeat */}
      <div className="space-y-2">
        <p className={LABEL_CLASS}>Heartbeat</p>

        <label className="block">
          <span className="text-whisper text-sumi-diluted mb-1 block">Interval (minutes)</span>
          <input
            type="number"
            min={MIN_HEARTBEAT_MINUTES}
            step={1}
            value={heartbeatMinutes}
            onChange={(event) => setHeartbeatMinutes(event.target.value)}
            className={INPUT_CLASS}
          />
        </label>

        <input
          value={messageTemplate}
          onChange={(event) => setMessageTemplate(event.target.value)}
          placeholder="Heartbeat message (optional)"
          className={INPUT_CLASS}
        />

        <input
          type="number"
          min={1}
          step={1}
          value={fatPinInterval}
          onChange={(event) => setFatPinInterval(event.target.value)}
          placeholder="Fat context every N heartbeats (optional)"
          className={INPUT_CLASS}
        />
      </div>

      {/* Task source */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setShowTaskSource((prev) => !prev)}
          className="flex items-center gap-1.5 text-whisper text-sumi-diluted uppercase tracking-wide hover:text-sumi-black transition-colors"
        >
          <span>{showTaskSource ? '▾' : '▸'}</span>
          <span>Task Source (GitHub)</span>
        </button>

        {showTaskSource && (
          <div className="space-y-2 pl-3 border-l border-ink-border">
            <input
              value={taskOwner}
              onChange={(event) => setTaskOwner(event.target.value)}
              placeholder="GitHub owner (e.g. NickGuAI)"
              className={INPUT_CLASS}
            />
            <input
              value={taskRepo}
              onChange={(event) => setTaskRepo(event.target.value)}
              placeholder="GitHub repo (e.g. monorepo-g)"
              className={INPUT_CLASS}
            />
            <input
              value={taskLabel}
              onChange={(event) => setTaskLabel(event.target.value)}
              placeholder="Label filter (optional)"
              className={INPUT_CLASS}
            />
            <input
              value={taskProject}
              onChange={(event) => setTaskProject(event.target.value)}
              placeholder="Project filter (stored, not yet used in task fetch)"
              className={INPUT_CLASS}
            />
          </div>
        )}
      </div>

        </div>{/* end left column */}

        {/* Right — live COMMANDER.md preview */}
        <div className="lg:w-80 xl:w-96 flex-shrink-0">
          <CommanderMdPreview
            host={host}
            displayName={displayName || undefined}
            cwd={cwd || undefined}
            persona={persona || undefined}
            agentType={agentType}
            effort={effort}
            heartbeatIntervalMs={Number.isFinite(parsedHeartbeatMs) ? parsedHeartbeatMs : undefined}
            heartbeatMessage={messageTemplate || undefined}
            fatPinInterval={parsedFatPin && parsedFatPin >= 1 ? parsedFatPin : undefined}
            taskSource={previewTaskSource}
          />
        </div>
      </div>{/* end flex row */}

      {actionError && <p className="text-sm text-accent-vermillion mt-4">{actionError}</p>}

      <div className="flex justify-end gap-2 mt-4">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-border px-3 py-1.5 text-sm min-h-[44px] min-w-[44px] hover:bg-ink-wash transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg border border-ink-border px-3 py-1.5 text-sm min-h-[44px] min-w-[44px] hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Creating...' : '+ Create'}
        </button>
      </div>
    </form>
  )
}
