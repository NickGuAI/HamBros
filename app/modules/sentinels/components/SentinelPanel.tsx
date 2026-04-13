import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn, formatCost, timeAgo } from '@/lib/utils'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import { useSentinelHistory, useSentinels } from '../hooks/useSentinels'
import type { Sentinel } from '../types'
import { SentinelCreateForm } from './SentinelCreateForm'
import { SentinelDetail } from './SentinelDetail'

interface SentinelPanelProps {
  commanderId: string | null | undefined
  showCreateForm: boolean
  onCloseCreateForm: () => void
}

function statusBadgeClass(status: Sentinel['status']): string {
  if (status === 'active') {
    return 'badge-active'
  }
  if (status === 'paused') {
    return 'badge-idle'
  }
  if (status === 'cancelled') {
    return 'badge-error'
  }
  return 'badge-completed'
}

function statusSymbol(status: Sentinel['status']): string {
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

function runsLabel(sentinel: Sentinel): string {
  if (sentinel.maxRuns) {
    return `${sentinel.totalRuns}/${sentinel.maxRuns} runs`
  }
  if (sentinel.totalRuns === 1) {
    return '1 run'
  }
  return `${sentinel.totalRuns} runs`
}

function lastRunSummary(sentinel: Sentinel): string {
  const latest = sentinel.history[0]
  if (!latest || !sentinel.lastRun) {
    return 'Last: no runs yet'
  }

  const action = latest.action.trim().length > 0 ? latest.action.trim() : 'run finished'
  return `Last: "${action}" - ${timeAgo(sentinel.lastRun)} - ${formatCost(latest.costUsd)}`
}

function SentinelPanelClient({ commanderId, showCreateForm, onCloseCreateForm }: SentinelPanelProps) {
  const [expandedSentinelId, setExpandedSentinelId] = useState<string | null>(null)

  const sentinelState = useSentinels(commanderId)
  const historyState = useSentinelHistory(expandedSentinelId)

  const expandedSentinel = useMemo(
    () => sentinelState.sentinels.find((sentinel) => sentinel.id === expandedSentinelId) ?? null,
    [expandedSentinelId, sentinelState.sentinels],
  )

  return (
    <section className="card-sumi min-h-[12rem] overflow-hidden flex flex-col">
      <ModalFormContainer
        open={Boolean(commanderId && showCreateForm)}
        title="Create Sentinel"
        onClose={onCloseCreateForm}
      >
        <SentinelCreateForm
          skillOptions={sentinelState.skillOptions}
          isSubmitting={sentinelState.createPending}
          error={sentinelState.actionError}
          onSubmit={sentinelState.createSentinel}
          onCancel={onCloseCreateForm}
        />
      </ModalFormContainer>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {!commanderId && (
          <p className="text-sm text-sumi-diluted">Select a commander to view sentinels.</p>
        )}

        {commanderId && sentinelState.sentinelsLoading && sentinelState.sentinels.length === 0 && (
          <div className="flex items-center justify-center h-20">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commanderId && !sentinelState.sentinelsLoading && sentinelState.sentinels.length === 0 && !sentinelState.sentinelsError && !showCreateForm && (
          <p className="text-sm text-sumi-diluted">No sentinels for this commander.</p>
        )}

        {commanderId && sentinelState.sentinels.map((sentinel) => {
          const expanded = expandedSentinelId === sentinel.id
          return (
            <div key={sentinel.id} className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5">
              <button
                type="button"
                onClick={() => {
                  setExpandedSentinelId((current) => (current === sentinel.id ? null : sentinel.id))
                }}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-center gap-2 text-sm text-sumi-black">
                    <p className="font-mono truncate">{sentinel.name}</p>
                    <span className={cn('badge-sumi shrink-0', statusBadgeClass(sentinel.status))}>
                      {statusSymbol(sentinel.status)} {sentinel.status}
                    </span>
                  </div>

                  <ChevronDown
                    size={14}
                    className={cn('text-sumi-diluted transition-transform', expanded && 'rotate-180')}
                  />
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-whisper text-sumi-diluted">
                  <span className="font-mono">{sentinel.schedule}</span>
                  <span>{runsLabel(sentinel)}</span>
                  {sentinel.totalCostUsd > 0 && <span>{formatCost(sentinel.totalCostUsd)} total</span>}
                </div>

                <p className="mt-1.5 text-xs text-sumi-gray truncate">{lastRunSummary(sentinel)}</p>
              </button>

              {expanded && expandedSentinel && (
                <SentinelDetail
                  sentinel={expandedSentinel}
                  history={historyState.history}
                  historyLoading={historyState.historyLoading}
                  actionsDisabled={sentinelState.updatePending || sentinelState.deletePending || sentinelState.triggerPending}
                  onUpdate={sentinelState.updateSentinel}
                  onPause={sentinelState.pauseSentinel}
                  onResume={sentinelState.resumeSentinel}
                  onTrigger={async (sentinelId) => {
                    await sentinelState.triggerSentinel(sentinelId)
                  }}
                  onDelete={async (sentinelId) => {
                    const confirmed = window.confirm('Delete this sentinel and all run artifacts?')
                    if (!confirmed) {
                      return
                    }
                    await sentinelState.deleteSentinel(sentinelId)
                    setExpandedSentinelId((current) => (current === sentinelId ? null : current))
                  }}
                />
              )}
            </div>
          )
        })}

        {sentinelState.sentinelsError && (
          <p className="text-sm text-accent-vermillion">{sentinelState.sentinelsError}</p>
        )}

        {!sentinelState.sentinelsError && sentinelState.actionError && (
          <p className="text-sm text-accent-vermillion">{sentinelState.actionError}</p>
        )}
      </div>
    </section>
  )
}

export function SentinelPanel(props: SentinelPanelProps) {
  if (typeof window === 'undefined') {
    return null
  }

  return <SentinelPanelClient {...props} />
}

