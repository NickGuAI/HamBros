import { useState, type FormEvent } from 'react'
import type { CommanderCreateInput } from '../hooks/useCommander'

const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const MIN_HEARTBEAT_MINUTES = 1
const DEFAULT_HEARTBEAT_MINUTES = 15
const MS_PER_MINUTE = 60_000

declare module '../hooks/useCommander' {
  interface CommanderCreateInput {
    persona?: string
    heartbeat?: {
      intervalMs: number
    }
  }
}

export function CreateCommanderForm({
  onAdd,
  isPending,
  onClose,
}: {
  onAdd: (input: CommanderCreateInput) => Promise<void>
  isPending: boolean
  onClose?: () => void
}) {
  const [host, setHost] = useState('')
  const [cwd, setCwd] = useState('')
  const [persona, setPersona] = useState('')
  const [heartbeatMinutes, setHeartbeatMinutes] = useState(String(DEFAULT_HEARTBEAT_MINUTES))
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

    const trimmedCwd = cwd.trim() || undefined
    const trimmedPersona = persona.trim() || undefined
    const parsedHeartbeatMinutes = Number.parseInt(heartbeatMinutes.trim(), 10)
    if (!Number.isFinite(parsedHeartbeatMinutes) || parsedHeartbeatMinutes < MIN_HEARTBEAT_MINUTES) {
      setActionError('Heartbeat interval must be at least 1 minute.')
      return
    }

    setActionError(null)
    try {
      const createInput: CommanderCreateInput = {
        host: trimmedHost,
        cwd: trimmedCwd,
        persona: trimmedPersona,
        heartbeat: {
          intervalMs: parsedHeartbeatMinutes * MS_PER_MINUTE,
        },
      }

      await onAdd(createInput)
      setHost('')
      setCwd('')
      setPersona('')
      setHeartbeatMinutes(String(DEFAULT_HEARTBEAT_MINUTES))
      onClose?.()
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes('(409)')) {
        setActionError(`Host "${trimmedHost}" already exists.`)
      } else {
        setActionError(caughtError instanceof Error ? caughtError.message : 'Failed to create commander.')
      }
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="rounded-lg border border-dashed border-ink-border p-3 space-y-2"
    >
      <p className="text-sm text-sumi-gray">New commander</p>

      <input
        value={host}
        onChange={(event) => setHost(event.target.value)}
        placeholder="host (e.g. my-agent-1)"
        className="w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
      />

      <input
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        placeholder="working directory (optional, e.g. /home/user/project)"
        className="w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
      />

      <label className="block">
        <span className="text-whisper uppercase tracking-wide text-sumi-diluted">Persona</span>
        <input
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
          placeholder="Senior engineer who owns infra"
          className="mt-1 w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
        />
      </label>

      <label className="block">
        <span className="text-whisper uppercase tracking-wide text-sumi-diluted">
          Heartbeat interval (minutes)
        </span>
        <input
          type="number"
          min={MIN_HEARTBEAT_MINUTES}
          step={1}
          value={heartbeatMinutes}
          onChange={(event) => setHeartbeatMinutes(event.target.value)}
          className="mt-1 w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
        />
      </label>

      {actionError && <p className="text-sm text-accent-vermillion">{actionError}</p>}

      <div className="flex justify-end gap-2">
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
