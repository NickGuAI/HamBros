import type { WorldAgent } from './use-world-state'

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString()
}

function statusProgress(status: WorldAgent['status']): number {
  switch (status) {
    case 'completed':
      return 100
    case 'active':
      return 74
    case 'idle':
      return 42
    default:
      return 18
  }
}

function statusClass(status: WorldAgent['status']): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-400/90'
    case 'active':
      return 'bg-emerald-300/90'
    case 'idle':
      return 'bg-amber-300/90'
    default:
      return 'bg-zinc-500/80'
  }
}

function statusAccent(status: WorldAgent['status']): string {
  switch (status) {
    case 'completed':
      return '#34d399'
    case 'active':
      return '#6ee7b7'
    case 'idle':
      return '#fcd34d'
    default:
      return '#71717a'
  }
}

function phaseClass(phase: WorldAgent['phase']): string {
  switch (phase) {
    case 'tool_use':
      return 'border-amber-300/50 bg-amber-400/15 text-amber-100'
    case 'thinking':
      return 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
    case 'blocked':
      return 'border-red-300/50 bg-red-400/15 text-red-100'
    case 'completed':
      return 'border-emerald-300/50 bg-emerald-400/20 text-emerald-100'
    default:
      return 'border-zinc-300/35 bg-zinc-500/20 text-zinc-100'
  }
}

interface PartyHudProps {
  agents: WorldAgent[]
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  worldStatus: 'live' | 'syncing' | 'offline'
  wsStatus: 'idle' | 'connecting' | 'connected' | 'disconnected'
}

export function PartyHud({
  agents,
  selectedAgentId,
  onSelectAgent,
  worldStatus,
  wsStatus,
}: PartyHudProps) {
  return (
    <aside className="pointer-events-none absolute inset-y-3 left-3 z-20 flex w-[340px] max-w-[calc(100%-1.5rem)] flex-col gap-2">
      <header className="rounded-lg border border-white/20 bg-black/55 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-white/90 backdrop-blur-[2px]">
        <div className="flex items-center justify-between gap-3">
          <span>party hud</span>
          <span className="rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px]">
            world {worldStatus}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-white/65">ws {wsStatus}</div>
      </header>

      <div className="pointer-events-auto min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {agents.map((agent) => {
          const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens
          const selected = selectedAgentId === agent.id
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent?.(agent.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left backdrop-blur-[1px] transition ${selected
                ? 'border-emerald-300/60 bg-emerald-300/15'
                : 'border-white/20 bg-black/45 hover:border-white/40 hover:bg-black/60'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.08em] text-white/95">
                  {agent.id}
                </p>
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${phaseClass(agent.phase)}`}>
                  {agent.phase}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-white/80">
                <span>cost {formatCost(agent.usage.costUsd)}</span>
                <span className="text-right">tokens {formatTokens(totalTokens)}</span>
                <span>in {formatTokens(agent.usage.inputTokens)}</span>
                <span className="text-right">out {formatTokens(agent.usage.outputTokens)}</span>
              </div>

              <progress
                className={`mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10 ${statusClass(agent.status)}`}
                max={100}
                value={statusProgress(agent.status)}
                style={{ accentColor: statusAccent(agent.status) }}
              />
            </button>
          )
        })}
      </div>
    </aside>
  )
}
