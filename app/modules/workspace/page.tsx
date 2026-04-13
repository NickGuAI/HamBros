import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAgentSessions } from '@/hooks/use-agents'
import { fetchJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { AgentSession } from '@/types'
import type { WorkspaceSource } from './use-workspace'
import { WorkspacePanel } from './components/WorkspacePanel'

interface Commander {
  id: string
  host: string
  state: string
}

type SourceEntry = {
  label: string
  source: WorkspaceSource
  cwd?: string
}

function buildCommanderSources(commanders: Commander[]): SourceEntry[] {
  return commanders.map((commander) => ({
    label: commander.host,
    source: { kind: 'commander', commanderId: commander.id } as WorkspaceSource,
    cwd: commander.host,
  }))
}

function buildSessionSources(sessions: AgentSession[]): SourceEntry[] {
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
  const { data: sessions, isLoading: sessionsLoading } = useAgentSessions()
  const { data: commanders = [], isLoading: commandersLoading } = useQuery({
    queryKey: ['commanders', 'list'],
    queryFn: () => fetchJson<Commander[]>('/api/commanders'),
  })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const commanderSources = buildCommanderSources(commanders)
  const sessionSources = buildSessionSources(sessions ?? [])

  const isLoading = commandersLoading || sessionsLoading
  const isEmpty = commanderSources.length === 0 && sessionSources.length === 0

  // Build a flat lookup map keyed by a unique string for selection tracking
  const allSources: Array<{ key: string; entry: SourceEntry }> = [
    ...commanderSources.map((entry) => ({
      key: `commander:${'commanderId' in entry.source ? entry.source.commanderId : ''}`,
      entry,
    })),
    ...sessionSources.map((entry) => ({
      key: `session:${'sessionName' in entry.source ? entry.source.sessionName : ''}`,
      entry,
    })),
  ]

  const selected = allSources.find((s) => s.key === selectedKey)?.entry ?? null

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <FolderOpen size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Workspace</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Browse files for commanders and agent sessions
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6">
        <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] xl:h-full gap-4">
          {/* Source list */}
          <section className="card-sumi p-3 xl:min-h-0 xl:overflow-y-auto">
            {isLoading && (
              <div className="flex items-center justify-center h-20">
                <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
              </div>
            )}
            {!isLoading && isEmpty && (
              <p className="text-sm text-sumi-diluted px-1">
                No commanders or sessions with a workspace directory.
              </p>
            )}

            {!isLoading && commanderSources.length > 0 && (
              <div className="mb-4">
                <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider px-1 mb-2">
                  Commanders
                </h3>
                <div className="space-y-1">
                  {commanderSources.map((entry) => {
                    const key = `commander:${'commanderId' in entry.source ? entry.source.commanderId : ''}`
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-lg transition-colors',
                          selectedKey === key
                            ? 'bg-washi-aged/60 border border-sumi-black/10'
                            : 'hover:bg-ink-wash border border-transparent',
                        )}
                        onClick={() => setSelectedKey(key)}
                      >
                        <p className="font-mono text-sm text-sumi-black truncate">{entry.label}</p>
                        {entry.cwd && (
                          <p className="text-whisper text-sumi-mist mt-0.5 truncate">{entry.cwd}</p>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {!isLoading && sessionSources.length > 0 && (
              <div>
                <h3 className="font-display text-sm text-sumi-black uppercase tracking-wider px-1 mb-2">
                  Sessions
                </h3>
                <div className="space-y-1">
                  {sessionSources.map((entry) => {
                    const key = `session:${'sessionName' in entry.source ? entry.source.sessionName : ''}`
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-lg transition-colors',
                          selectedKey === key
                            ? 'bg-washi-aged/60 border border-sumi-black/10'
                            : 'hover:bg-ink-wash border border-transparent',
                        )}
                        onClick={() => setSelectedKey(key)}
                      >
                        <p className="font-mono text-sm text-sumi-black truncate">{entry.label}</p>
                        {entry.cwd && (
                          <p className="text-whisper text-sumi-mist mt-0.5 truncate">{entry.cwd}</p>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Workspace panel */}
          <section className="card-sumi xl:min-h-0 overflow-hidden flex flex-col">
            {selected ? (
              <div className="flex-1 min-h-0 p-3">
                <WorkspacePanel source={selected.source} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-ink-border text-sm text-sumi-diluted m-3">
                Select a commander or session to browse its workspace.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
