import { getAvatarTileIndex, getTileFrame } from '../avatar-hash'
import type { WorldAgent } from '../use-world-state'

interface PartyScreenProps {
  agents: WorldAgent[]
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function phaseClass(phase: WorldAgent['phase']): string {
  if (phase === 'tool_use') return 'border-amber-300/50 bg-amber-400/15 text-amber-100'
  if (phase === 'thinking') return 'border-cyan-300/50 bg-cyan-400/15 text-cyan-100'
  if (phase === 'blocked') return 'border-red-300/50 bg-red-400/15 text-red-100'
  if (phase === 'completed') return 'border-emerald-300/50 bg-emerald-400/15 text-emerald-100'
  return 'border-zinc-300/35 bg-zinc-500/20 text-zinc-100'
}

function AvatarTile({ agentId }: { agentId: string }) {
  const frame = getTileFrame(getAvatarTileIndex(agentId))

  return (
    <div className="h-10 w-10 overflow-hidden rounded border border-white/20 bg-black/50">
      <div
        className="h-4 w-4"
        style={{
          backgroundImage: "url('/assets/rpg/creatures.png')",
          backgroundPosition: `-${frame.x}px -${frame.y}px`,
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated',
          transform: 'scale(2.5)',
          transformOrigin: 'top left',
        }}
      />
    </div>
  )
}

export function PartyScreen({ agents }: PartyScreenProps) {
  return (
    <section className="h-[100dvh] w-full overflow-hidden bg-zinc-950 text-white">
      <header className="border-b border-white/10 px-4 py-3">
        <h1 className="font-mono text-xs uppercase tracking-[0.12em] text-white/85">party</h1>
      </header>

      <div className="h-[calc(100dvh-3.25rem)] overflow-y-auto p-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {agents.map((agent) => {
            const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens
            return (
              <article key={agent.id} className="rounded-lg border border-white/15 bg-black/35 p-3">
                <div className="flex items-start gap-3">
                  <AvatarTile agentId={agent.id} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] uppercase tracking-[0.08em] text-white/95">
                      {agent.id}
                    </p>
                    <span className={`mt-1 inline-flex rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${phaseClass(agent.phase)}`}>
                      {agent.phase}
                    </span>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-1 font-mono text-[10px] text-white/75">
                  <span>cost {formatCost(agent.usage.costUsd)}</span>
                  <span>tokens {formatTokens(totalTokens)}</span>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
