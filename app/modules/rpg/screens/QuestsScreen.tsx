import { useMemo, useState } from 'react'
import type { WorldAgent } from '../use-world-state'

interface QuestsScreenProps {
  agents: WorldAgent[]
}

type SortBy = 'status' | 'cost'

const STATUS_RANK: Record<WorldAgent['status'], number> = {
  active: 0,
  idle: 1,
  stale: 2,
  completed: 3,
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

function phaseClass(phase: WorldAgent['phase']): string {
  if (phase === 'tool_use') return 'border-amber-300/50 bg-amber-400/15 text-amber-100'
  if (phase === 'thinking') return 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
  if (phase === 'blocked') return 'border-red-300/50 bg-red-400/15 text-red-100'
  if (phase === 'completed') return 'border-emerald-300/50 bg-emerald-400/15 text-emerald-100'
  return 'border-zinc-300/35 bg-zinc-500/20 text-zinc-100'
}

export function QuestsScreen({ agents }: QuestsScreenProps) {
  const [sortBy, setSortBy] = useState<SortBy>('status')
  const [descending, setDescending] = useState(false)

  const sorted = useMemo(() => {
    const list = [...agents]
    list.sort((a, b) => {
      let result = 0
      if (sortBy === 'status') {
        result = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      } else {
        result = a.usage.costUsd - b.usage.costUsd
      }
      return descending ? -result : result
    })
    return list
  }, [agents, descending, sortBy])

  const toggleSort = (nextSort: SortBy) => {
    if (sortBy === nextSort) {
      setDescending((previous) => !previous)
      return
    }
    setSortBy(nextSort)
    setDescending(false)
  }

  return (
    <section className="h-[100dvh] w-full overflow-hidden bg-zinc-950 text-white">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <h1 className="font-mono text-xs uppercase tracking-[0.12em] text-white/85">quests</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleSort('status')}
            className="rounded border border-white/20 bg-black/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/80"
          >
            sort status
          </button>
          <button
            type="button"
            onClick={() => toggleSort('cost')}
            className="rounded border border-white/20 bg-black/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-white/80"
          >
            sort cost
          </button>
        </div>
      </header>

      <div className="h-[calc(100dvh-3.25rem)] overflow-y-auto p-4">
        <table className="min-w-full border-collapse text-left">
          <thead className="sticky top-0 bg-zinc-950/95 backdrop-blur-sm">
            <tr className="border-b border-white/15 font-mono text-[10px] uppercase tracking-[0.08em] text-white/60">
              <th className="px-2 py-2">session</th>
              <th className="px-2 py-2">phase</th>
              <th className="px-2 py-2">cost</th>
              <th className="px-2 py-2">status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((agent) => (
              <tr key={agent.id} className="border-b border-white/5 text-sm text-white/85">
                <td className="px-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{agent.task || agent.id}</p>
                    <p className="truncate font-mono text-[10px] text-white/50">{agent.id}</p>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <span className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${phaseClass(agent.phase)}`}>
                    {agent.phase}
                  </span>
                </td>
                <td className="px-2 py-2 font-mono text-[11px]">{formatCost(agent.usage.costUsd)}</td>
                <td className="px-2 py-2">
                  <span className="rounded border border-white/15 bg-black/35 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]">
                    {agent.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
