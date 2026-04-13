import { ArrowLeft, MessageSquare, Square, Triangle, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchVoid } from '@/lib/api'
import type { CommanderSession, CommanderCronTask } from '../hooks/useCommander'
import { QuestBoard } from './QuestBoard'
import { CommanderCronTab } from './CommanderCronTab'
import { CommanderSentinelsTab } from './CommanderSentinelsTab'
import { CommanderIdentityTab } from './CommanderIdentityTab'

type TabId = 'quests' | 'sentinels' | 'cron' | 'identity'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'quests', label: 'Quests' },
  { id: 'sentinels', label: 'Sentinels' },
  { id: 'cron', label: 'Cron' },
  { id: 'identity', label: 'Identity' },
]

const STATE_BADGE_CLASSES: Record<CommanderSession['state'], string> = {
  idle: 'badge-idle',
  running: 'badge-active',
  paused: 'badge-idle',
  stopped: 'badge-stale',
}

function normalizeTab(tab: string): TabId {
  if (tab === 'sentinels' || tab === 'cron' || tab === 'identity') {
    return tab
  }
  return 'quests'
}

async function triggerHeartbeat(commanderId: string): Promise<void> {
  await fetchVoid(`/api/commanders/${encodeURIComponent(commanderId)}/heartbeat/trigger`, {
    method: 'POST',
  })
}

export function CommanderDetailPanel({
  commander,
  activeTab,
  onTabChange,
  onBack,
  commanderOptions,
  onSelectCommander,
  onOpenChat,
  onStartCommander,
  onStopCommander,
  isStartPending,
  isStopPending,
  crons,
  cronsLoading,
  cronsError,
  addCron,
  addCronPending,
  toggleCron,
  toggleCronPending,
  deleteCron,
  deleteCronPending,
}: {
  commander: CommanderSession
  activeTab: string
  onTabChange: (tab: TabId) => void
  onBack: () => void
  commanderOptions: Array<{ id: string; label: string }>
  onSelectCommander: (commanderId: string) => void
  onOpenChat?: (commanderId: string) => void
  onStartCommander?: (commanderId: string) => Promise<void>
  onStopCommander?: (commanderId: string) => Promise<void>
  isStartPending?: boolean
  isStopPending?: boolean
  crons: CommanderCronTask[]
  cronsLoading: boolean
  cronsError: string | null
  addCron: (input: { commanderId: string; schedule: string; instruction: string }) => Promise<void>
  addCronPending: boolean
  toggleCron: (input: { commanderId: string; cronId: string; enabled: boolean }) => Promise<void>
  toggleCronPending: boolean
  deleteCron: (input: { commanderId: string; cronId: string }) => Promise<void>
  deleteCronPending: boolean
}) {
  const tab = normalizeTab(activeTab)
  const isRunning = commander.state === 'running'

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
      {/* Back button — mobile only */}
      <div className="md:hidden px-4 py-3 border-b border-ink-border bg-washi-aged/30 space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-sumi-gray hover:text-sumi-black transition-colors"
        >
          <ArrowLeft size={16} />
          Commanders
        </button>
        <label className="block">
          <span className="mb-1 block text-whisper text-sumi-diluted uppercase tracking-wider">
            Commander
          </span>
          <select
            aria-label="Select commander"
            value={commander.id}
            onChange={(event) => onSelectCommander(event.target.value)}
            className="w-full rounded-lg border border-ink-border bg-washi-white px-3 py-2 text-[16px] text-sumi-black focus:outline-none focus:border-ink-border-hover"
          >
            {commanderOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Commander header */}
      <div className="px-4 md:px-6 py-4 border-b border-ink-border bg-washi-aged/20">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full shrink-0',
                  isRunning ? 'bg-accent-moss animate-breathe' : 'bg-sumi-mist',
                )}
              />
              <h2 className="font-mono text-base text-sumi-black truncate">{commander.host}</h2>
              <span className={cn('badge-sumi', STATE_BADGE_CLASSES[commander.state])}>
                {commander.state}
              </span>
            </div>
            <p className="text-whisper text-sumi-mist mt-1 font-mono truncate pl-4">{commander.id}</p>
            <p className="text-whisper text-sumi-diluted mt-1 pl-4">
              agent: {commander.agentType ?? 'claude'} · effort: {commander.effort ?? 'max'}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* ⚡ Trigger Heartbeat */}
            {isRunning && (
              <button
                type="button"
                onClick={() => void triggerHeartbeat(commander.id)}
                title="Trigger heartbeat"
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-xs text-amber-600 hover:bg-amber-500/10 transition-colors"
              >
                <Zap size={12} />
                <span className="hidden sm:inline">HB</span>
              </button>
            )}

            {/* Start/Stop */}
            {!isRunning && onStartCommander && (
              <button
                type="button"
                disabled={isStartPending}
                onClick={() => void onStartCommander(commander.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent-moss/40 px-2.5 py-1.5 text-xs text-accent-moss hover:bg-accent-moss/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                <Triangle size={10} className="fill-current" />
                Start
              </button>
            )}
            {isRunning && onStopCommander && (
              <button
                type="button"
                disabled={isStopPending}
                onClick={() => void onStopCommander(commander.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent-vermillion/40 px-2.5 py-1.5 text-xs text-accent-vermillion hover:bg-accent-vermillion/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                <Square size={10} className="fill-current" />
                Stop
              </button>
            )}

            {/* Open Chat */}
            {onOpenChat && (
              <button
                type="button"
                onClick={() => onOpenChat(commander.id)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-border px-2.5 py-1.5 text-xs hover:bg-ink-wash transition-colors"
              >
                <MessageSquare size={12} />
                <span className="hidden sm:inline">Chat</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div className="border-b border-ink-border bg-washi-aged/10 flex items-end overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTabChange(t.id)}
            className={cn(
              'px-4 py-3 text-sm whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === t.id
                ? 'border-sumi-black text-sumi-black font-medium'
                : 'border-transparent text-sumi-gray hover:text-sumi-black hover:border-ink-border',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'quests' && <QuestBoard commanders={[commander]} selectedCommanderId={commander.id} />}
        {tab === 'sentinels' && <CommanderSentinelsTab commander={commander} />}
        {tab === 'cron' && (
          <CommanderCronTab
            commander={commander}
            crons={crons}
            cronsLoading={cronsLoading}
            cronsError={cronsError}
            addCron={addCron}
            addCronPending={addCronPending}
            toggleCron={toggleCron}
            toggleCronPending={toggleCronPending}
            deleteCron={deleteCron}
            deleteCronPending={deleteCronPending}
          />
        )}
        {tab === 'identity' && <CommanderIdentityTab commander={commander} />}
      </div>
    </div>
  )
}
