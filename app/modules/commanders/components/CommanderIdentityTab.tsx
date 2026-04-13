import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchJson, fetchVoid } from '@/lib/api'
import {
  CLAUDE_EFFORT_LEVELS,
  DEFAULT_CLAUDE_EFFORT_LEVEL,
  type ClaudeEffortLevel,
} from '../../claude-effort.js'
import type { CommanderSession } from '../hooks/useCommander'
import { HeartbeatMonitor } from './HeartbeatMonitor'

interface CommanderDetailPayload {
  workflowMd?: string | null
}

async function fetchCommanderDetail(commanderId: string): Promise<CommanderDetailPayload> {
  return fetchJson<CommanderDetailPayload>(`/api/commanders/${encodeURIComponent(commanderId)}`)
}

async function updateCommanderEffort(
  commanderId: string,
  effort: ClaudeEffortLevel,
): Promise<void> {
  await fetchVoid(`/api/commanders/${encodeURIComponent(commanderId)}/profile`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ effort }),
  })
}

export function CommanderIdentityTab({
  commander,
}: {
  commander: CommanderSession
}) {
  const queryClient = useQueryClient()
  const [effort, setEffort] = useState<ClaudeEffortLevel>(
    commander.effort ?? DEFAULT_CLAUDE_EFFORT_LEVEL,
  )
  const [actionError, setActionError] = useState<string | null>(null)

  const detailQuery = useQuery({
    queryKey: ['commanders', 'detail', commander.id],
    queryFn: () => fetchCommanderDetail(commander.id),
    staleTime: 30_000,
  })

  const updateEffortMutation = useMutation({
    mutationFn: async (nextEffort: ClaudeEffortLevel) => updateCommanderEffort(commander.id, nextEffort),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['commanders', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['commanders', 'detail', commander.id] }),
      ])
    },
  })

  useEffect(() => {
    setEffort(commander.effort ?? DEFAULT_CLAUDE_EFFORT_LEVEL)
    setActionError(null)
  }, [commander.effort, commander.id])

  async function handleSaveEffort(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setActionError(null)
    try {
      await updateEffortMutation.mutateAsync(effort)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update commander effort.')
    }
  }

  const workflowMd = detailQuery.data?.workflowMd ?? null

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <section className="card-sumi overflow-hidden">
        <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60">
          <h3 className="section-title">Runtime Config</h3>
        </header>
        <form className="p-4 space-y-3" onSubmit={(event) => void handleSaveEffort(event)}>
          <label className="block">
            <span className="section-title block mb-2">Claude effort</span>
            <select
              value={effort}
              onChange={(event) => setEffort(event.target.value as ClaudeEffortLevel)}
              className="w-full rounded-lg border border-ink-border bg-washi-aged px-3 py-2 text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            >
              {CLAUDE_EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
          <p className="text-whisper text-sumi-mist">
            Used whenever this commander launches a Claude session. Default is `max`.
          </p>
          {commander.agentType !== 'claude' && (
            <p className="text-whisper text-sumi-diluted">
              Current agent type is `{commander.agentType ?? 'claude'}`. This setting applies the next time the commander runs with Claude.
            </p>
          )}
          {actionError && (
            <p className="text-sm text-accent-vermillion">{actionError}</p>
          )}
          <button
            type="submit"
            disabled={updateEffortMutation.isPending}
            className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {updateEffortMutation.isPending ? 'Saving...' : 'Save effort'}
          </button>
        </form>
      </section>

      <section className="card-sumi overflow-hidden">
        <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60">
          <h3 className="section-title">COMMANDER.md</h3>
        </header>
        <div className="p-4">
          {detailQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
            </div>
          ) : workflowMd ? (
            <div className="prose prose-sm max-w-none text-sumi-gray break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{workflowMd}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-sumi-diluted">
              No per-commander `COMMANDER.md` has been scaffolded yet.
            </p>
          )}
        </div>
      </section>

      <HeartbeatMonitor commander={commander} />
    </div>
  )
}
