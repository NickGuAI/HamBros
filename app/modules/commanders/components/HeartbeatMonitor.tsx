import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { fetchJson } from '../../../src/lib/api'
import type { CommanderSession } from '../hooks/useCommander'

interface HeartbeatLogEntry {
  id: string
  firedAt: string
  questCount: number
  claimedQuestId?: string
  claimedQuestInstruction?: string
  outcome: 'ok' | 'no-quests' | 'error'
  errorMessage?: string
}

interface HeartbeatLogResponse {
  entries: HeartbeatLogEntry[]
}

interface HeartbeatPatchResponse {
  id: string
  heartbeat: {
    intervalMs: number
    messageTemplate: string
    lastSentAt: string | null
  }
  lastHeartbeat: string | null
}

const OUTCOME_PILL_STYLES: Record<HeartbeatLogEntry['outcome'], string> = {
  ok: 'badge-completed',
  'no-quests': 'badge-idle',
  error: 'badge-stale',
}

const OUTCOME_DOT_STYLES: Record<HeartbeatLogEntry['outcome'], string> = {
  ok: 'bg-accent-moss',
  'no-quests': 'bg-sumi-mist',
  error: 'bg-accent-vermillion',
}

const MIN_HEARTBEAT_MINUTES = 1
const MS_PER_MINUTE = 60_000

async function fetchHeartbeatLog(commanderId: string): Promise<HeartbeatLogResponse> {
  return fetchJson<HeartbeatLogResponse>(
    `/api/commanders/${encodeURIComponent(commanderId)}/heartbeat-log`,
  )
}

async function patchHeartbeat(
  commanderId: string,
  patch: { intervalMs: number; messageTemplate: string },
): Promise<HeartbeatPatchResponse> {
  return fetchJson<HeartbeatPatchResponse>(
    `/api/commanders/${encodeURIComponent(commanderId)}/heartbeat`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(patch),
    },
  )
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString()
}

function formatIntervalMinutes(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs < MS_PER_MINUTE) {
    return '<1m'
  }

  const minutes = Math.round(intervalMs / MS_PER_MINUTE)
  return minutes === 1 ? '1 min' : `${minutes} mins`
}

function toMinutesInput(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return '15'
  }

  return String(Math.max(MIN_HEARTBEAT_MINUTES, Math.round(intervalMs / MS_PER_MINUTE)))
}

function summarizeTemplate(messageTemplate: string): string {
  const firstLine = messageTemplate
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ?? messageTemplate
}

function formatClaim(entry: HeartbeatLogEntry): string {
  if (entry.claimedQuestInstruction) {
    return entry.claimedQuestInstruction
  }
  if (entry.claimedQuestId) {
    return `Claimed quest ${entry.claimedQuestId}`
  }
  return 'No quest claimed'
}

export function HeartbeatMonitor({
  commander,
}: {
  commander: CommanderSession | null
}) {
  const commanderId = commander?.id ?? null
  const isRunning = commander?.state === 'running'
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState('15')
  const [messageTemplate, setMessageTemplate] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const heartbeatLogQuery = useQuery({
    queryKey: ['commanders', 'heartbeat-log', commanderId ?? 'none'],
    queryFn: () => fetchHeartbeatLog(commanderId!),
    enabled: Boolean(commanderId),
    refetchInterval: isRunning ? 30_000 : false,
  })

  const entries = useMemo(
    () => (heartbeatLogQuery.data?.entries ?? []).slice(0, 10),
    [heartbeatLogQuery.data?.entries],
  )

  const updateHeartbeatMutation = useMutation({
    mutationFn: async (patch: { intervalMs: number; messageTemplate: string }) => {
      if (!commanderId) {
        throw new Error('Select a commander to update heartbeat settings.')
      }
      return patchHeartbeat(commanderId, patch)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['commanders', 'sessions'] })
    },
  })

  useEffect(() => {
    if (!commander) {
      setIsEditing(false)
      setIntervalMinutes('15')
      setMessageTemplate('')
      setActionError(null)
      return
    }

    if (isEditing) {
      return
    }

    setIntervalMinutes(toMinutesInput(commander.heartbeat.intervalMs))
    setMessageTemplate(commander.heartbeat.messageTemplate)
    setActionError(null)
  }, [
    commander,
    commander?.heartbeat.intervalMs,
    commander?.heartbeat.messageTemplate,
    isEditing,
  ])

  function handleCancelEdit(): void {
    if (commander) {
      setIntervalMinutes(toMinutesInput(commander.heartbeat.intervalMs))
      setMessageTemplate(commander.heartbeat.messageTemplate)
    }
    setActionError(null)
    setIsEditing(false)
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!commander) {
      return
    }

    const parsedMinutes = Number.parseInt(intervalMinutes.trim(), 10)
    if (!Number.isFinite(parsedMinutes) || parsedMinutes < MIN_HEARTBEAT_MINUTES) {
      setActionError('Interval must be at least 1 minute.')
      return
    }

    const trimmedTemplate = messageTemplate.trim()
    if (!trimmedTemplate) {
      setActionError('Message template is required.')
      return
    }

    setActionError(null)
    try {
      const updated = await updateHeartbeatMutation.mutateAsync({
        intervalMs: parsedMinutes * MS_PER_MINUTE,
        messageTemplate: trimmedTemplate,
      })
      setIntervalMinutes(toMinutesInput(updated.heartbeat.intervalMs))
      setMessageTemplate(updated.heartbeat.messageTemplate)
      setIsEditing(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update heartbeat settings.')
    }
  }

  return (
    <section className="card-sumi min-h-[12rem] overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60 flex items-center justify-between gap-3">
        <h3 className="section-title">Heartbeat Monitor</h3>
        <span className="text-[11px] uppercase tracking-wide text-sumi-diluted">
          {isRunning ? 'Polling every 30s' : 'Idle'}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {!commander && (
          <p className="text-sm text-sumi-diluted">Select a commander to view heartbeat activity.</p>
        )}

        {commander && (
          <div className="mb-3 rounded-lg border border-ink-border bg-washi-white p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-whisper uppercase text-sumi-diluted tracking-wide">
                  Settings
                </p>
                <p className="text-sm text-sumi-black">
                  Every {formatIntervalMinutes(commander.heartbeat.intervalMs)}
                </p>
                {!isEditing && (
                  <p className="mt-1 text-xs text-sumi-mist truncate">
                    {summarizeTemplate(commander.heartbeat.messageTemplate)}
                  </p>
                )}
              </div>
              {!isEditing && (
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash transition-colors"
                  onClick={() => {
                    setIntervalMinutes(toMinutesInput(commander.heartbeat.intervalMs))
                    setMessageTemplate(commander.heartbeat.messageTemplate)
                    setActionError(null)
                    setIsEditing(true)
                  }}
                >
                  Edit
                </button>
              )}
            </div>

            {isEditing && (
              <form className="mt-3 space-y-2" onSubmit={(event) => void handleSaveSettings(event)}>
                <label className="block">
                  <span className="text-whisper uppercase tracking-wide text-sumi-diluted">
                    Interval (minutes)
                  </span>
                  <input
                    type="number"
                    min={MIN_HEARTBEAT_MINUTES}
                    step={1}
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-ink-border px-3 py-2 text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
                  />
                </label>

                <label className="block">
                  <span className="text-whisper uppercase tracking-wide text-sumi-diluted">
                    Message template
                  </span>
                  <textarea
                    value={messageTemplate}
                    onChange={(event) => setMessageTemplate(event.target.value)}
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-ink-border px-3 py-2 text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
                  />
                </label>

                {actionError && <p className="text-xs text-accent-vermillion">{actionError}</p>}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={updateHeartbeatMutation.isPending}
                    className="rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={updateHeartbeatMutation.isPending}
                    className="rounded-lg border border-ink-border px-2.5 py-1 text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {updateHeartbeatMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {commander && heartbeatLogQuery.isLoading && entries.length === 0 && (
          <div className="flex items-center justify-center h-28">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commander && !heartbeatLogQuery.isLoading && entries.length === 0 && !heartbeatLogQuery.error && (
          <p className="text-sm text-sumi-diluted">No heartbeat activity recorded yet.</p>
        )}

        {entries.length > 0 && (
          <div className="space-y-2">
            {entries.map((entry, index) => (
              <article key={entry.id} className="relative pl-6">
                {index < entries.length - 1 && (
                  <span className="absolute left-[11px] top-3 bottom-[-10px] w-px bg-ink-border" />
                )}
                <span
                  className={cn(
                    'absolute left-2 top-2 block h-[7px] w-[7px] rounded-full',
                    OUTCOME_DOT_STYLES[entry.outcome],
                  )}
                />

                <div className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-sumi-diluted">{formatTimestamp(entry.firedAt)}</span>
                    <span className="badge-sumi badge-idle">{entry.questCount} quests</span>
                    <span className={cn('badge-sumi', OUTCOME_PILL_STYLES[entry.outcome])}>
                      {entry.outcome}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-sumi-black truncate">{formatClaim(entry)}</p>
                  {entry.errorMessage && (
                    <p className="mt-1 text-xs text-accent-vermillion">{entry.errorMessage}</p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {heartbeatLogQuery.error && (
        <p className="border-t border-ink-border px-4 py-2 text-sm text-accent-vermillion">
          {heartbeatLogQuery.error instanceof Error
            ? heartbeatLogQuery.error.message
            : 'Failed to load heartbeat log'}
        </p>
      )}
    </section>
  )
}
