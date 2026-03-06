interface ToolLogEntry {
  id: string
  ts: string
  agentId: string
  toolName: string
}

interface LogScreenProps {
  entries: ToolLogEntry[]
}

export function LogScreen({ entries }: LogScreenProps) {
  return (
    <section className="h-[100dvh] w-full overflow-hidden bg-zinc-950 text-white">
      <header className="border-b border-white/10 px-4 py-3">
        <h1 className="font-mono text-xs uppercase tracking-[0.12em] text-white/85">log</h1>
      </header>

      <div className="h-[calc(100dvh-3.25rem)] overflow-y-auto p-4">
        <div className="space-y-2">
          {entries.map((entry) => (
            <article key={entry.id} className="rounded border border-white/15 bg-black/35 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/65">
                  {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className="rounded border border-white/15 bg-black/45 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-white/85">
                  {entry.toolName}
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-white/90">{entry.agentId}</p>
            </article>
          ))}

          {entries.length === 0 ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-white/55">no tool activity yet</p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export type { ToolLogEntry }
