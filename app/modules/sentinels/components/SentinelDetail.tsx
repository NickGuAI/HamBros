import { useState } from 'react'
import { Clock3, Play, Trash2 } from 'lucide-react'
import { cn, formatCost, timeAgo } from '@/lib/utils'
import type { Sentinel, SentinelHistoryEntry, UpdateSentinelInput } from '../types'

interface SentinelDetailProps {
  sentinel: Sentinel
  history: SentinelHistoryEntry[]
  historyLoading: boolean
  actionsDisabled: boolean
  onUpdate: (sentinelId: string, patch: UpdateSentinelInput) => Promise<unknown>
  onPause: (sentinelId: string) => Promise<unknown>
  onResume: (sentinelId: string) => Promise<unknown>
  onTrigger: (sentinelId: string) => Promise<unknown>
  onDelete: (sentinelId: string) => Promise<unknown>
}

function statusBadgeClass(status: Sentinel['status']): string {
  if (status === 'active') {
    return 'text-accent-moss bg-accent-moss/10 border-accent-moss/30'
  }
  if (status === 'paused') {
    return 'text-accent-persimmon bg-accent-persimmon/10 border-accent-persimmon/30'
  }
  if (status === 'cancelled') {
    return 'text-accent-vermillion bg-accent-vermillion/10 border-accent-vermillion/30'
  }
  return 'text-sumi-diluted bg-ink-wash border-ink-border'
}

function toStatusSymbol(status: Sentinel['status']): string {
  if (status === 'active') {
    return '●'
  }
  if (status === 'paused') {
    return '◐'
  }
  if (status === 'cancelled') {
    return '✗'
  }
  return '✓'
}

export function SentinelDetail({
  sentinel,
  history,
  historyLoading,
  actionsDisabled,
  onUpdate,
  onPause,
  onResume,
  onTrigger,
  onDelete,
}: SentinelDetailProps) {
  const [newObservation, setNewObservation] = useState('')

  const observations = sentinel.observations ?? []

  const handleAddObservation = async (): Promise<void> => {
    const trimmed = newObservation.trim()
    if (!trimmed) {
      return
    }

    await onUpdate(sentinel.id, {
      observations: [...observations, trimmed],
    })
    setNewObservation('')
  }

  const handleRemoveObservation = async (index: number): Promise<void> => {
    const next = observations.filter((_, observationIndex) => observationIndex !== index)
    await onUpdate(sentinel.id, {
      observations: next,
    })
  }

  return (
    <div className="mt-2 rounded-lg border border-ink-border bg-washi-aged/30 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 uppercase', statusBadgeClass(sentinel.status))}>
          <span aria-hidden>{toStatusSymbol(sentinel.status)}</span>
          {sentinel.status}
        </span>
        <span className="text-sumi-diluted">{sentinel.agentType}</span>
        <span className="text-sumi-diluted">{sentinel.permissionMode}</span>
      </div>

      <div>
        <p className="section-title">Instruction</p>
        <p className="mt-1 text-sm text-sumi-gray whitespace-pre-wrap">{sentinel.instruction}</p>
      </div>

      <div>
        <p className="section-title">Skills</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sentinel.skills.length === 0 && (
            <span className="text-whisper text-sumi-diluted">No skills configured.</span>
          )}
          {sentinel.skills.map((skill) => (
            <span key={skill} className="badge-sumi badge-completed font-mono normal-case">
              {skill}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="section-title">Observations</p>
        <div className="mt-2 space-y-2">
          {observations.length === 0 && (
            <p className="text-whisper text-sumi-diluted">No observations yet.</p>
          )}
          {observations.map((observation, index) => (
            <div key={`${observation}-${index}`} className="flex items-start justify-between gap-2 rounded border border-ink-border bg-washi-white px-2 py-1.5">
              <p className="text-sm text-sumi-gray">{observation}</p>
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={() => void handleRemoveObservation(index)}
                className="text-whisper text-accent-vermillion disabled:opacity-60"
              >
                remove
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <input
              value={newObservation}
              onChange={(event) => setNewObservation(event.target.value)}
              className="flex-1 px-2.5 py-2 rounded border border-ink-border bg-washi-white text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              placeholder="Add observation"
            />
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={() => void handleAddObservation()}
              className="btn-ghost !px-3 !py-2 text-xs disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div>
        <p className="section-title">Run History</p>
        <div className="mt-2 max-h-48 overflow-y-auto space-y-2 pr-1">
          {historyLoading && (
            <p className="text-whisper text-sumi-mist">Loading run history...</p>
          )}
          {!historyLoading && history.length === 0 && (
            <p className="text-whisper text-sumi-diluted">No runs yet.</p>
          )}
          {history.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className="rounded border border-ink-border bg-washi-white px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-mono text-sumi-diluted">{timeAgo(entry.timestamp)}</p>
                <span className="text-xs text-sumi-diluted">{formatCost(entry.costUsd)}</span>
              </div>
              <p className="mt-1 text-sm text-sumi-black">{entry.action}</p>
              <p className="text-xs text-sumi-gray mt-0.5">{entry.result}</p>
              <p className="mt-1 text-whisper text-sumi-mist">
                duration {entry.durationSec}s
                {entry.source ? ` • ${entry.source}` : ''}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {sentinel.status === 'active' ? (
          <button
            type="button"
            disabled={actionsDisabled}
            onClick={() => void onPause(sentinel.id)}
            className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-60"
          >
            <Clock3 size={12} />
            Pause
          </button>
        ) : sentinel.status === 'paused' ? (
          <button
            type="button"
            disabled={actionsDisabled}
            onClick={() => void onResume(sentinel.id)}
            className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-60"
          >
            <Clock3 size={12} />
            Resume
          </button>
        ) : null}

        <button
          type="button"
          disabled={actionsDisabled}
          onClick={() => void onTrigger(sentinel.id)}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1 disabled:opacity-60"
        >
          <Play size={12} />
          Trigger
        </button>

        <button
          type="button"
          disabled={actionsDisabled}
          onClick={() => void onDelete(sentinel.id)}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1 text-accent-vermillion disabled:opacity-60"
        >
          <Trash2 size={12} />
          Delete
        </button>
      </div>
    </div>
  )
}
