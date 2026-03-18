import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronUp, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchJson, fetchVoid } from '@/lib/api'
import type { CommanderSession } from '../hooks/useCommander'

type QuestStatus = 'pending' | 'active' | 'done' | 'failed'
type QuestDisplayStatus = QuestStatus | 'unknown'
type QuestSource = 'idea' | 'github-issue' | 'manual' | 'voice-log'
type QuestAgentType = 'claude' | 'codex'
type QuestPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
type QuestArtifactType = 'github_issue' | 'github_pr' | 'url' | 'file'

interface QuestArtifact {
  type: QuestArtifactType
  label: string
  href: string
}

interface QuestContract {
  cwd?: string | null
  agentType?: string | null
  permissionMode?: string | null
  skillsToUse?: string[] | null
}

interface QuestNote {
  note?: string | null
  message?: string | null
  text?: string | null
  body?: string | null
  content?: string | null
}

interface CommanderQuest {
  id: string
  status: QuestStatus | string
  instruction: string
  source: QuestSource | string
  githubIssueUrl?: string | null
  artifacts?: QuestArtifact[] | null
  contract?: QuestContract | null
  latestNote?: string | QuestNote | null
  notes?: QuestNote[] | null
}

interface CreateQuestInput {
  commanderId: string
  instruction: string
  source: QuestSource
  githubIssueUrl?: string
  artifacts?: QuestArtifact[]
  contract?: {
    cwd?: string
    agentType?: QuestAgentType
    permissionMode?: QuestPermissionMode
    skillsToUse?: string[]
  }
}

interface DeleteQuestInput {
  commanderId: string
  questId: string
}

const STATUS_META: Record<
  QuestDisplayStatus,
  { symbol: string; label: string; badgeClassName: string }
> = {
  pending: {
    symbol: '●',
    label: 'pending',
    badgeClassName: 'badge-idle',
  },
  active: {
    symbol: '▶',
    label: 'active',
    badgeClassName: 'badge-active',
  },
  done: {
    symbol: '✓',
    label: 'done',
    badgeClassName: 'badge-completed',
  },
  failed: {
    symbol: '✗',
    label: 'failed',
    badgeClassName: 'badge-error',
  },
  unknown: {
    symbol: '•',
    label: 'unknown',
    badgeClassName: 'badge-stale',
  },
}

const QUEST_SOURCES: Array<{ value: QuestSource; label: string }> = [
  { value: 'manual', label: 'manual' },
  { value: 'github-issue', label: 'github-issue' },
  { value: 'idea', label: 'idea' },
  { value: 'voice-log', label: 'voice-log' },
]

const QUEST_ARTIFACT_TYPES: Array<{ value: QuestArtifactType; label: string }> = [
  { value: 'github_issue', label: 'github_issue' },
  { value: 'github_pr', label: 'github_pr' },
  { value: 'url', label: 'url' },
  { value: 'file', label: 'file' },
]

const QUEST_ARTIFACT_PREFIX: Record<QuestArtifactType, string> = {
  github_issue: 'issue',
  github_pr: 'PR',
  url: 'url',
  file: 'file',
}

function toErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return null
}

function normalizeStatus(rawStatus: string): QuestDisplayStatus {
  const normalized = rawStatus.trim().toLowerCase()
  if (
    normalized === 'pending' ||
    normalized === 'active' ||
    normalized === 'done' ||
    normalized === 'failed'
  ) {
    return normalized
  }
  return 'unknown'
}

function sourceLabel(source: string): string {
  const normalized = source.trim().toLowerCase()
  if (normalized === 'github-issue') {
    return 'github-issue'
  }
  if (normalized === 'idea') {
    return 'idea'
  }
  if (normalized === 'manual') {
    return 'manual'
  }
  if (normalized === 'voice-log') {
    return 'voice-log'
  }
  return normalized || 'unknown'
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseArtifactType(value: unknown): QuestArtifactType | null {
  if (
    value === 'github_issue' ||
    value === 'github_pr' ||
    value === 'url' ||
    value === 'file'
  ) {
    return value
  }
  return null
}

function parseQuestArtifacts(raw: unknown): QuestArtifact[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const artifacts: QuestArtifact[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const record = entry as Record<string, unknown>
    const type = parseArtifactType(record.type)
    const label = nonEmpty(record.label)
    const href = nonEmpty(record.href)
    if (!type || !label || !href) {
      continue
    }

    artifacts.push({ type, label, href })
  }

  return artifacts
}

function extractNoteText(value: unknown): string | null {
  if (typeof value === 'string') {
    return nonEmpty(value)
  }
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  return (
    nonEmpty(record.note) ??
    nonEmpty(record.message) ??
    nonEmpty(record.text) ??
    nonEmpty(record.body) ??
    nonEmpty(record.content)
  )
}

function latestQuestNote(quest: CommanderQuest): string | null {
  const direct = extractNoteText(quest.latestNote)
  if (direct) {
    return direct
  }

  if (!Array.isArray(quest.notes)) {
    return null
  }

  for (let index = quest.notes.length - 1; index >= 0; index -= 1) {
    const candidate = extractNoteText(quest.notes[index])
    if (candidate) {
      return candidate
    }
  }

  return null
}

function contractSummary(contract: QuestContract | null | undefined): string | null {
  const parts = [
    nonEmpty(contract?.cwd),
    nonEmpty(contract?.agentType),
    nonEmpty(contract?.permissionMode),
  ].filter((part): part is string => part !== null)

  if (parts.length === 0) {
    return null
  }

  return parts.join(' • ')
}

function parseGitHubIssueUrlParts(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) }
}

async function fetchCommanderQuests(commanderId: string): Promise<CommanderQuest[]> {
  return fetchJson<CommanderQuest[]>(`/api/commanders/${encodeURIComponent(commanderId)}/quests`)
}

async function createCommanderQuest(input: CreateQuestInput): Promise<CommanderQuest> {
  return fetchJson<CommanderQuest>(`/api/commanders/${encodeURIComponent(input.commanderId)}/quests`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      instruction: input.instruction,
      source: input.source,
      githubIssueUrl: input.githubIssueUrl,
      artifacts: input.artifacts,
      contract: input.contract,
    }),
  })
}

async function deleteCommanderQuest(input: DeleteQuestInput): Promise<void> {
  await fetchVoid(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/quests/${encodeURIComponent(input.questId)}`,
    { method: 'DELETE' },
  )
}

export function QuestBoard({
  commander,
}: {
  commander: CommanderSession | null
}) {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [source, setSource] = useState<QuestSource>('manual')
  const [githubIssueUrl, setGithubIssueUrl] = useState('')
  const [cwd, setCwd] = useState('')
  const [agentType, setAgentType] = useState<QuestAgentType>('claude')
  const [permissionMode, setPermissionMode] = useState<QuestPermissionMode>('acceptEdits')
  const [skillsInput, setSkillsInput] = useState('')
  const [artifacts, setArtifacts] = useState<QuestArtifact[]>([])
  const [showArtifactForm, setShowArtifactForm] = useState(false)
  const [artifactType, setArtifactType] = useState<QuestArtifactType>('url')
  const [artifactLabel, setArtifactLabel] = useState('')
  const [artifactHref, setArtifactHref] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [fetchingIssue, setFetchingIssue] = useState(false)
  const [deletingQuestId, setDeletingQuestId] = useState<string | null>(null)

  const questsQuery = useQuery({
    queryKey: ['commanders', 'quests', commander?.id ?? 'none'],
    queryFn: () => fetchCommanderQuests(commander!.id),
    enabled: Boolean(commander?.id),
    refetchInterval: 10_000,
  })

  const createQuestMutation = useMutation({
    mutationFn: createCommanderQuest,
    onSuccess: async (_createdQuest, input) => {
      await queryClient.invalidateQueries({
        queryKey: ['commanders', 'quests', input.commanderId],
      })
    },
  })

  const deleteQuestMutation = useMutation({
    mutationFn: deleteCommanderQuest,
    onSuccess: async (_data, input) => {
      await queryClient.invalidateQueries({
        queryKey: ['commanders', 'quests', input.commanderId],
      })
    },
  })

  async function handleFetchIssue(): Promise<void> {
    const parsed = parseGitHubIssueUrlParts(githubIssueUrl)
    if (!parsed) {
      setFormError('Enter a valid GitHub issue URL first.')
      return
    }

    setFetchingIssue(true)
    setFormError(null)
    try {
      const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`
      const response = await fetch(apiUrl)
      if (!response.ok) {
        setFormError(`GitHub API error: ${response.status}`)
        return
      }
      const issue = await response.json() as { title?: string; body?: string | null }
      const title = typeof issue.title === 'string' ? issue.title.trim() : ''
      const body = typeof issue.body === 'string' ? issue.body.trim() : ''
      const combined = [title, body].filter(Boolean).join('\n\n')
      if (combined) {
        setInstruction(combined)
      } else {
        setFormError('No content found in that issue.')
      }
    } catch {
      setFormError('Failed to fetch issue. Check the URL and try again.')
    } finally {
      setFetchingIssue(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!commander) {
      return
    }

    const trimmedInstruction = instruction.trim()
    if (!trimmedInstruction) {
      setFormError('Instruction is required.')
      return
    }

    const trimmedGitHubIssueUrl = githubIssueUrl.trim()
    if (source === 'github-issue' && !trimmedGitHubIssueUrl) {
      setFormError('GitHub issue URL is required when source is github-issue.')
      return
    }

    const skillsToUse = skillsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const contract = {
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(agentType ? { agentType } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(skillsToUse.length > 0 ? { skillsToUse } : {}),
    }

    setFormError(null)
    try {
      await createQuestMutation.mutateAsync({
        commanderId: commander.id,
        instruction: trimmedInstruction,
        source,
        ...(trimmedGitHubIssueUrl ? { githubIssueUrl: trimmedGitHubIssueUrl } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(Object.keys(contract).length > 0 ? { contract } : {}),
      })
      setInstruction('')
      setSource('manual')
      setGithubIssueUrl('')
      setCwd('')
      setAgentType('claude')
      setPermissionMode('acceptEdits')
      setSkillsInput('')
      setArtifacts([])
      setShowArtifactForm(false)
      setArtifactType('url')
      setArtifactLabel('')
      setArtifactHref('')
      setShowForm(false)
    } catch (error) {
      setFormError(toErrorMessage(error) ?? 'Failed to create quest')
    }
  }

  function handleAddArtifact(): void {
    const label = artifactLabel.trim()
    const href = artifactHref.trim()
    if (!label || !href) {
      setFormError('Artifact label and href are required.')
      return
    }

    setArtifacts((current) => [...current, { type: artifactType, label, href }])
    setArtifactType('url')
    setArtifactLabel('')
    setArtifactHref('')
    setShowArtifactForm(false)
    setFormError(null)
  }

  function handleRemoveArtifact(indexToRemove: number): void {
    setArtifacts((current) => current.filter((_artifact, index) => index !== indexToRemove))
  }

  async function handleDelete(quest: CommanderQuest): Promise<void> {
    if (!commander) {
      return
    }
    setDeletingQuestId(quest.id)
    try {
      await deleteQuestMutation.mutateAsync({
        commanderId: commander.id,
        questId: quest.id,
      })
    } finally {
      setDeletingQuestId(null)
    }
  }

  const quests = questsQuery.data ?? []
  const activeQuests = [...quests.filter((q) => {
    const s = normalizeStatus(q.status)
    return s === 'pending' || s === 'active' || s === 'unknown'
  })].reverse()
  const completedQuests = [...quests.filter((q) => {
    const s = normalizeStatus(q.status)
    return s === 'done' || s === 'failed'
  })].reverse()
  const apiError = toErrorMessage(questsQuery.error) ?? toErrorMessage(createQuestMutation.error)

  return (
    <section className="card-sumi min-h-[16rem] xl:h-full overflow-hidden flex flex-col xl:min-h-0">
      <header className="px-4 py-3 border-b border-ink-border bg-washi-aged/60 flex items-center justify-between gap-3">
        <h3 className="section-title">Quest Board</h3>
        <button
          type="button"
          onClick={() => setShowForm((current) => !current)}
          disabled={!commander}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          {showForm ? 'Close' : 'Add Quest'}
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!commander && (
          <p className="text-sm text-sumi-diluted">Select a commander to view quests.</p>
        )}

        {commander && showForm && (
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="rounded-lg border border-dashed border-ink-border p-3 space-y-3"
          >
            <p className="text-sm text-sumi-gray">Add quest</p>

            <div>
              <label className="section-title block mb-2">Source</label>
              <div className="flex flex-wrap gap-2">
                {QUEST_SOURCES.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSource(opt.value)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors',
                      source === opt.value
                        ? 'border-sumi-black bg-sumi-black text-washi-aged'
                        : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {source === 'github-issue' && (
              <div>
                <label className="section-title block mb-2">GitHub Issue URL</label>
                <div className="flex gap-2">
                  <input
                    value={githubIssueUrl}
                    onChange={(event) => setGithubIssueUrl(event.target.value)}
                    placeholder="https://github.com/NickGuAI/monorepo-g/issues/412"
                    className="flex-1 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                  />
                  <button
                    type="button"
                    onClick={() => void handleFetchIssue()}
                    disabled={fetchingIssue || !githubIssueUrl.trim()}
                    className="px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors shrink-0"
                  >
                    {fetchingIssue ? 'Fetching...' : 'Fetch'}
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="section-title block mb-2">Instruction</label>
              <textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Investigate Auth0 token expiry on mobile sessions"
                className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div>
                <label className="section-title block mb-2">cwd</label>
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder="~/App"
                  className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                />
              </div>
              <div>
                <label className="section-title block mb-2">agentType</label>
                <select
                  value={agentType}
                  onChange={(event) => setAgentType(event.target.value as QuestAgentType)}
                  className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
              </div>
              <div>
                <label className="section-title block mb-2">permissionMode</label>
                <select
                  value={permissionMode}
                  onChange={(event) => setPermissionMode(event.target.value as QuestPermissionMode)}
                  className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
                >
                  <option value="default">default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                </select>
              </div>
            </div>

            <div>
              <label className="section-title block mb-2">skills (comma-separated)</label>
              <input
                value={skillsInput}
                onChange={(event) => setSkillsInput(event.target.value)}
                placeholder="legion-investigate, legion-implement"
                className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="section-title">Artifacts</label>
                <button
                  type="button"
                  onClick={() => setShowArtifactForm((current) => !current)}
                  className="rounded-lg border border-ink-border bg-washi-aged px-2 py-1 text-xs hover:bg-ink-wash transition-colors"
                >
                  {showArtifactForm ? 'Cancel' : 'Add artifact'}
                </button>
              </div>

              {artifacts.length > 0 && (
                <div className="space-y-1">
                  {artifacts.map((artifact, index) => (
                    <div
                      key={`${artifact.type}-${artifact.href}-${index}`}
                      className="flex items-center justify-between gap-2 rounded border border-ink-border bg-washi-aged px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        [{QUEST_ARTIFACT_PREFIX[artifact.type]}] {artifact.label} ({artifact.href})
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveArtifact(index)}
                        className="rounded border border-ink-border px-1.5 py-0.5 text-[10px] hover:bg-ink-wash transition-colors shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {showArtifactForm && (
                <div className="rounded-lg border border-ink-border bg-washi-aged/60 p-2 space-y-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <select
                      value={artifactType}
                      onChange={(event) => setArtifactType(event.target.value as QuestArtifactType)}
                      className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                    >
                      {QUEST_ARTIFACT_TYPES.map((typeOption) => (
                        <option key={typeOption.value} value={typeOption.value}>
                          {typeOption.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={artifactLabel}
                      onChange={(event) => setArtifactLabel(event.target.value)}
                      placeholder="Label"
                      className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                    />
                    <input
                      value={artifactHref}
                      onChange={(event) => setArtifactHref(event.target.value)}
                      placeholder="https://github.com/... or path"
                      className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddArtifact}
                      className="rounded-lg border border-ink-border bg-washi-aged px-2 py-1 text-xs hover:bg-ink-wash transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>

            {formError && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={createQuestMutation.isPending}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <Plus size={14} />
              {createQuestMutation.isPending ? 'Adding...' : 'Add Quest'}
            </button>
          </form>
        )}

        {commander && questsQuery.isLoading && quests.length === 0 && (
          <div className="flex items-center justify-center h-28">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commander && !questsQuery.isLoading && quests.length === 0 && !apiError && (
          <p className="text-sm text-sumi-diluted">No quests created for this commander.</p>
        )}

        {commander && activeQuests.map((quest) => {
          const status = normalizeStatus(quest.status)
          const statusMeta = STATUS_META[status]
          const note = latestQuestNote(quest)
          const contract = contractSummary(quest.contract)
          const questArtifacts = parseQuestArtifacts(quest.artifacts)
          const isDeleting = deletingQuestId === quest.id

          return (
            <div
              key={quest.id}
              className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-sumi-black line-clamp-2">
                    <span className="font-mono mr-2">{statusMeta.symbol}</span>
                    <span className="mr-2">{statusMeta.label}</span>
                    {quest.instruction}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={cn('badge-sumi', statusMeta.badgeClassName)}>
                    {statusMeta.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(quest)}
                    disabled={isDeleting || deleteQuestMutation.isPending}
                    title="Delete quest"
                    className="rounded border border-ink-border p-1 text-sumi-diluted hover:text-accent-vermillion hover:border-accent-vermillion/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>

              {contract && (
                <p className="text-whisper text-sumi-diluted mt-1 truncate">{contract}</p>
              )}

              {note && (
                <p className="text-whisper text-sumi-mist mt-1 line-clamp-2">
                  {status === 'done' ? 'Completed:' : status === 'failed' ? 'Failed:' : 'Note:'} {note}
                </p>
              )}

              {questArtifacts.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {questArtifacts.map((artifact, index) => {
                    const isHttp = /^https?:\/\//i.test(artifact.href)
                    return (
                      <a
                        key={`${quest.id}-${artifact.type}-${artifact.href}-${index}`}
                        href={artifact.href}
                        target={isHttp ? '_blank' : undefined}
                        rel={isHttp ? 'noreferrer' : undefined}
                        className="inline-flex max-w-full items-center rounded border border-ink-border bg-washi-aged px-2 py-0.5 text-whisper text-sumi-diluted hover:border-ink-border-hover hover:text-sumi-black transition-colors"
                        title={artifact.href}
                      >
                        <span className="truncate">
                          [{QUEST_ARTIFACT_PREFIX[artifact.type]}] {artifact.label}
                        </span>
                      </a>
                    )
                  })}
                </div>
              )}

              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-whisper text-sumi-diluted">{sourceLabel(quest.source)}</span>
              </div>
            </div>
          )
        })}

        {commander && completedQuests.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setCompletedOpen((prev) => !prev)}
              className="w-full flex items-center gap-2 rounded-lg border border-ink-border bg-washi-aged/60 px-3 py-2 text-xs text-sumi-diluted hover:bg-ink-wash transition-colors"
            >
              <ChevronUp
                size={14}
                className={cn(
                  'transition-transform duration-200',
                  completedOpen ? '' : 'rotate-180',
                )}
              />
              <span className="font-mono">
                {completedQuests.length} completed quest{completedQuests.length !== 1 ? 's' : ''}
              </span>
            </button>

            {completedOpen && completedQuests.map((quest) => {
              const status = normalizeStatus(quest.status)
              const statusMeta = STATUS_META[status]
              const note = latestQuestNote(quest)
              const contract = contractSummary(quest.contract)
              const questArtifacts = parseQuestArtifacts(quest.artifacts)
              const isDeleting = deletingQuestId === quest.id

              return (
                <div
                  key={quest.id}
                  className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-sumi-black line-clamp-2">
                        <span className="font-mono mr-2">{statusMeta.symbol}</span>
                        <span className="mr-2">{statusMeta.label}</span>
                        {quest.instruction}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={cn('badge-sumi', statusMeta.badgeClassName)}>
                        {statusMeta.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDelete(quest)}
                        disabled={isDeleting || deleteQuestMutation.isPending}
                        title="Delete quest"
                        className="rounded border border-ink-border p-1 text-sumi-diluted hover:text-accent-vermillion hover:border-accent-vermillion/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>

                  {contract && (
                    <p className="text-whisper text-sumi-diluted mt-1 truncate">{contract}</p>
                  )}

                  {note && (
                    <p className="text-whisper text-sumi-mist mt-1 line-clamp-2">
                      {status === 'done' ? 'Completed:' : status === 'failed' ? 'Failed:' : 'Note:'} {note}
                    </p>
                  )}

                  {questArtifacts.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {questArtifacts.map((artifact, index) => {
                        const isHttp = /^https?:\/\//i.test(artifact.href)
                        return (
                          <a
                            key={`${quest.id}-${artifact.type}-${artifact.href}-${index}`}
                            href={artifact.href}
                            target={isHttp ? '_blank' : undefined}
                            rel={isHttp ? 'noreferrer' : undefined}
                            className="inline-flex max-w-full items-center rounded border border-ink-border bg-washi-aged px-2 py-0.5 text-whisper text-sumi-diluted hover:border-ink-border-hover hover:text-sumi-black transition-colors"
                            title={artifact.href}
                          >
                            <span className="truncate">
                              [{QUEST_ARTIFACT_PREFIX[artifact.type]}] {artifact.label}
                            </span>
                          </a>
                        )
                      })}
                    </div>
                  )}

                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-whisper text-sumi-diluted">{sourceLabel(quest.source)}</span>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {apiError && (
        <p className="border-t border-ink-border px-4 py-2 text-sm text-accent-vermillion">
          {apiError}
        </p>
      )}
    </section>
  )
}
