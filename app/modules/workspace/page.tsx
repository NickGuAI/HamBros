import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useAgentSessions } from '@/hooks/use-agents'
import { cn } from '@/lib/utils'
import type { AgentSession } from '@/types'
import type { WorkspaceSource } from './use-workspace'
import { WorkspacePanel } from './components/WorkspacePanel'

type SourceEntry = {
  label: string
  source: WorkspaceSource
  cwd?: string
}

function buildSources(sessions: AgentSession[]): SourceEntry[] {
  const entries: SourceEntry[] = []
  for (const session of sessions) {
    if (!session.cwd) {
      continue
    }
    entries.push({
      label: session.label ?? session.name,
      source: { kind: 'agent-session', sessionName: session.name },
      cwd: session.cwd,
    })
  }
  return entries
}

export default function WorkspacePage() {
  const { data: sessions, isLoading } = useAgentSessions()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const sources = buildSources(sessions ?? [])
  const selected = selectedIndex !== null ? sources[selectedIndex] : null

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <FolderOpen size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Workspace</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Browse files for active agent sessions
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6">
        <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] xl:h-full gap-4">
          {/* Source list */}
          <section className="card-sumi p-3 xl:min-h-0 xl:overflow-y-auto">
            <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider px-1 mb-3">
              Sessions
            </h3>
            {isLoading && (
              <div className="flex items-center justify-center h-20">
                <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
              </div>
            )}
            {!isLoading && sources.length === 0 && (
              <p className="text-sm text-sumi-diluted px-1">
                No active sessions with a workspace directory.
              </p>
            )}
            <div className="space-y-1">
              {sources.map((entry, index) => (
                <button
                  key={entry.label}
                  type="button"
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg transition-colors',
                    selectedIndex === index
                      ? 'bg-washi-aged/60 border border-sumi-black/10'
                      : 'hover:bg-ink-wash border border-transparent',
                  )}
                  onClick={() => setSelectedIndex(index)}
                >
                  <p className="font-mono text-sm text-sumi-black truncate">{entry.label}</p>
                  {entry.cwd && (
                    <p className="text-whisper text-sumi-mist mt-0.5 truncate">{entry.cwd}</p>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Workspace panel */}
          <section className="card-sumi xl:min-h-0 overflow-hidden flex flex-col">
            {selected ? (
              <div className="flex-1 min-h-0 p-3">
                <WorkspacePanel source={selected.source} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-ink-border text-sm text-sumi-diluted m-3">
                Select a session to browse its workspace.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
