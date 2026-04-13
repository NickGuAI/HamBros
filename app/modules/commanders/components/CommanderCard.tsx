import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Clock3, MessageSquare, Pencil, Play, Square, Trash2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommanderAgentType, CommanderSession } from '../hooks/useCommander'

export interface CommanderCardProps {
  commander: CommanderSession
  onStart: (id: string, agentType: CommanderAgentType) => void
  onStop: (id: string) => void
  onTriggerHeartbeat?: (id: string) => void
  onOpenChat: (id: string, agentType: CommanderAgentType) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  isStartPending: boolean
  isStopPending: boolean
  isTriggerHeartbeatPending?: boolean
  isDeletePending: boolean
}

const STATE_BADGE_CLASSES: Record<CommanderSession['state'], string> = {
  idle: 'badge-idle',
  running: 'badge-active',
  paused: 'badge-idle',
  stopped: 'badge-stale',
}

const CHANNEL_PROVIDER_LABELS: Record<'whatsapp' | 'telegram' | 'discord', string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
}

const ACTION_CONTROL_CLASSES =
  'btn-ghost !px-3 !py-0 inline-flex h-11 w-full items-center justify-center gap-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60'

const STAT_LINK_CLASSES =
  'btn-ghost !px-2.5 !py-1.5 inline-flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-sumi-gray'

declare module '../hooks/useCommander' {
  interface CommanderSession {
    channelMeta?: {
      provider: 'whatsapp' | 'telegram' | 'discord'
      displayName: string
    }
  }
}

function resolveDisplayName(commander: CommanderSession): string {
  const channelMeta = commander.channelMeta
  if (!channelMeta) {
    return commander.host
  }
  const providerLabel = CHANNEL_PROVIDER_LABELS[channelMeta.provider]
  const baseLabel = channelMeta.displayName.trim() || commander.host
  return `${providerLabel} - ${baseLabel}`
}

export function CommanderCard({
  commander,
  onStart,
  onStop,
  onTriggerHeartbeat,
  onOpenChat,
  onDelete,
  onEdit,
  isStartPending,
  isStopPending,
  isTriggerHeartbeatPending = false,
  isDeletePending,
}: CommanderCardProps) {
  const [agentType, setAgentType] = useState<CommanderAgentType>('claude')

  const isRunning = commander.state === 'running'
  const isStopped = commander.state === 'stopped'
  const displayName = resolveDisplayName(commander)

  const hasActiveTask = Boolean(commander.currentTask)
  const questCount = commander.questCount ?? 0
  const scheduleCount = commander.scheduleCount ?? 0

  const customBorder = commander.ui?.borderColor?.trim()

  const currentTaskTitle = commander.currentTask?.title?.trim()
  const tone = commander.ui?.speakingTone?.trim()

  return (
    <div
      className={cn('card-sumi border-2 p-4', !customBorder && 'border-sumi-mist')}
      style={customBorder ? { borderColor: customBorder } : undefined}
    >
      {/* Identity, quest/schedule pills, state */}
      <div className="flex flex-wrap items-center gap-2">
        {commander.avatarUrl ? (
          <img
            src={commander.avatarUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full border-2 border-sumi-mist object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-sumi-mist bg-sumi-mist font-mono text-sm font-semibold text-sumi-black"
            aria-hidden
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <p className="min-w-0 flex-1 font-mono text-sm text-sumi-black truncate">{displayName}</p>
        <Link
          to={`/quests?commander=${commander.id}`}
          className={STAT_LINK_CLASSES}
          onClick={(e) => e.stopPropagation()}
        >
          <ClipboardCheck size={12} className="shrink-0" />
          {questCount} quests
        </Link>
        <Link
          to={`/command-room?commander=${commander.id}`}
          className={STAT_LINK_CLASSES}
          onClick={(e) => e.stopPropagation()}
        >
          <Clock3 size={12} className="shrink-0" />
          {scheduleCount} schedules
        </Link>
        <span className={cn('badge-sumi shrink-0', STATE_BADGE_CLASSES[commander.state])}>
          <span
            className={cn(
              'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
              isRunning ? 'bg-accent-moss animate-breathe' : 'bg-sumi-mist',
            )}
          />
          {commander.state}
        </span>
      </div>
      {tone ? (
        <p className="mt-2 text-whisper text-sumi-diluted italic leading-snug">{tone}</p>
      ) : null}

      {/* Current task */}
      {currentTaskTitle && (
        <div className="mt-3">
          <p className="text-sm text-sumi-gray truncate">
            <span className="text-whisper text-sumi-diluted uppercase">Current task: </span>
            {currentTaskTitle}
          </p>
        </div>
      )}

      {/* Pill nav */}
      <div className="mt-3 flex gap-1 p-1 rounded-full bg-washi-aged/60 border border-ink-border w-fit">
        <Link
          to={`/sentinels?commander=${commander.id}`}
          className="px-3 py-1 rounded-full text-[10px] uppercase tracking-wide font-medium text-sumi-gray hover:text-sumi-black hover:bg-washi-white transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          Sentinels
        </Link>
        <Link
          to={`/quests?commander=${commander.id}`}
          className="px-3 py-1 rounded-full text-[10px] uppercase tracking-wide font-medium text-sumi-gray hover:text-sumi-black hover:bg-washi-white transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          Quests
        </Link>
        <Link
          to={`/command-room?commander=${commander.id}`}
          className="px-3 py-1 rounded-full text-[10px] uppercase tracking-wide font-medium text-sumi-gray hover:text-sumi-black hover:bg-washi-white transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          Cron
        </Link>
      </div>

      {/* Primary actions */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {isStopped ? (
          <>
            <label className={cn(ACTION_CONTROL_CLASSES, 'cursor-pointer text-sumi-diluted')}>
              <select
                value={agentType}
                onChange={(e) => {
                  const nextValue = e.target.value
                  const next = nextValue === 'codex' || nextValue === 'gemini' ? nextValue : 'claude'
                  setAgentType(next as CommanderAgentType)
                }}
                className="w-full bg-transparent text-center text-sumi-black focus:outline-none"
              >
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="gemini">gemini</option>
              </select>
            </label>
            <button
              type="button"
              disabled={isStartPending}
              onClick={() => onStart(commander.id, agentType)}
              className={ACTION_CONTROL_CLASSES}
            >
              <Play size={12} className="fill-current" />
              Start
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={isStopPending}
            onClick={() => onStop(commander.id)}
            className={ACTION_CONTROL_CLASSES}
          >
            <Square size={10} className="fill-current" />
            Stop
          </button>
        )}
        {isRunning && onTriggerHeartbeat && (
          <button
            type="button"
            disabled={isTriggerHeartbeatPending}
            onClick={() => onTriggerHeartbeat(commander.id)}
            className={ACTION_CONTROL_CLASSES}
          >
            <Zap size={12} />
            {isTriggerHeartbeatPending ? 'Triggering...' : 'Heartbeat'}
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            onOpenChat(
              commander.id,
              isRunning ? (commander.agentType ?? agentType) : agentType,
            )}
          className={ACTION_CONTROL_CLASSES}
        >
          <MessageSquare size={12} />
          Chat
        </button>
        <button
          type="button"
          onClick={() => onEdit(commander.id)}
          className={ACTION_CONTROL_CLASSES}
        >
          <Pencil size={12} />
          Edit
        </button>
        {isStopped && (
          <button
            type="button"
            disabled={isDeletePending}
            onClick={() => onDelete(commander.id)}
            className={cn(ACTION_CONTROL_CLASSES, 'text-accent-vermillion')}
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}
      </div>

    </div>
  )
}
