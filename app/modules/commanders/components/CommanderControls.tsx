import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Circle, MessageSquare, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommanderSession, CommanderWsStatus } from '../hooks/useCommander'

function formatHeartbeatElapsed(lastHeartbeat: string | null, nowMs: number): string {
  if (!lastHeartbeat) {
    return 'never'
  }

  const heartbeatMs = new Date(lastHeartbeat).getTime()
  if (!Number.isFinite(heartbeatMs)) {
    return 'unknown'
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - heartbeatMs) / 1000))
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) {
    return `${elapsedHours}h`
  }

  const elapsedDays = Math.floor(elapsedHours / 24)
  return `${elapsedDays}d`
}

export function CommanderControls({
  commander,
  wsStatus,
  heartbeatPulseAt,
  onStart,
  onStop,
  onSendMessage,
  isStarting,
  isStopping,
  isSendingMessage,
}: {
  commander: CommanderSession | null
  wsStatus: CommanderWsStatus
  heartbeatPulseAt: number | null
  onStart: (commanderId: string) => Promise<void>
  onStop: (commanderId: string) => Promise<void>
  onSendMessage: (input: { commanderId: string; message: string }) => Promise<void>
  isStarting: boolean
  isStopping: boolean
  isSendingMessage: boolean
}) {
  const [composerOpen, setComposerOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [heartbeatFlash, setHeartbeatFlash] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const isRunning = commander?.state === 'running'
  const canStart = Boolean(commander) && !isRunning
  const canStop = Boolean(commander) && isRunning
  const canSend = Boolean(commander) && isRunning

  const lastHeartbeat = commander?.lastHeartbeat ?? commander?.heartbeat?.lastSentAt ?? null
  const heartbeatElapsed = useMemo(
    () => formatHeartbeatElapsed(lastHeartbeat, nowMs),
    [lastHeartbeat, nowMs],
  )

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!heartbeatPulseAt) {
      return
    }

    setHeartbeatFlash(true)
    const timer = window.setTimeout(() => setHeartbeatFlash(false), 1200)
    return () => window.clearTimeout(timer)
  }, [heartbeatPulseAt])

  async function handleStart(): Promise<void> {
    if (!commander) {
      return
    }

    setActionError(null)
    try {
      await onStart(commander.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to start commander')
    }
  }

  async function handleStop(): Promise<void> {
    if (!commander) {
      return
    }

    setActionError(null)
    try {
      await onStop(commander.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to stop commander')
    }
  }

  async function handleMessageSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!commander) {
      return
    }

    const trimmed = message.trim()
    if (!trimmed) {
      setActionError('Message is required.')
      return
    }

    setActionError(null)
    try {
      await onSendMessage({
        commanderId: commander.id,
        message: trimmed,
      })
      setMessage('')
      setComposerOpen(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to send message')
    }
  }

  return (
    <section className="card-sumi p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={!canStart || isStarting}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-ink-border hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <Play size={14} />
            Start
          </button>
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={!canStop || isStopping}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-ink-border hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <Square size={14} />
            Stop
          </button>
          <button
            type="button"
            onClick={() => setComposerOpen((open) => !open)}
            disabled={!canSend}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-ink-border hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <MessageSquare size={14} />
            Send Message
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-sumi-diluted">
          <span className="inline-flex items-center gap-2">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span
                className={cn(
                  'absolute inline-flex h-full w-full rounded-full',
                  heartbeatFlash && isRunning ? 'animate-ping bg-accent-moss/60' : 'bg-transparent',
                )}
              />
              <span
                className={cn(
                  'relative inline-flex h-2.5 w-2.5 rounded-full',
                  isRunning ? 'bg-accent-moss' : 'bg-sumi-mist',
                )}
              />
            </span>
            Heartbeat {heartbeatElapsed}
          </span>
          <span
            className={cn(
              'badge-sumi',
              wsStatus === 'connected'
                ? 'badge-active'
                : wsStatus === 'connecting'
                  ? 'badge-idle'
                  : 'badge-stale',
            )}
          >
            <Circle size={10} className="mr-1 fill-current" />
            {wsStatus}
          </span>
        </div>
      </div>

      {composerOpen && (
        <form onSubmit={(event) => void handleMessageSubmit(event)} className="mt-3 space-y-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            placeholder="Ask commander for an update or give the next instruction..."
            className="w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-sumi-black/20"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setComposerOpen(false)}
              className="px-3 py-1.5 text-sm text-sumi-diluted hover:text-sumi-black transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSendingMessage}
              className="inline-flex items-center gap-2 rounded-lg border border-ink-border px-3 py-1.5 text-sm hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {isSendingMessage ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      )}

      {actionError && (
        <p className="mt-3 text-sm text-accent-vermillion">{actionError}</p>
      )}
    </section>
  )
}
