import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronUp, Plus, X } from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import { fetchJson, fetchVoid } from '@/lib/api'
import type { CommanderSession } from '../hooks/useCommander'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import {
  type QuestAgentType,
  type QuestArtifact,
  type QuestArtifactType,
  QUEST_ARTIFACT_PREFIX,
  QuestCreateForm,
  type QuestPermissionMode,
  type QuestSource,
} from './QuestCreateForm'

type QuestStatus = 'pending' | 'active' | 'done' | 'failed'
type QuestDisplayStatus = QuestStatus | 'unknown'

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
  commanderId?: string | null
  createdAt?: string | null
  completedAt?: string | null
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

type QuestBoardCommander = Pick<CommanderSession, 'id' | 'host'>

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

async function fetchAllCommanderQuests(): Promise<CommanderQuest[]> {
  return fetchJson<CommanderQuest[]>('/api/commanders/quests')
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

function parseDateMillis(value: string | null | undefined): number | null {
  const raw = nonEmpty(value)
  if (!raw) {
    return null
  }

  const timestamp = new Date(raw).getTime()
  if (Number.isNaN(timestamp)) {
    return null
  }
  return timestamp
}

function formatRelativeTime(value: string | null | undefined): string | null {
  const raw = nonEmpty(value)
  if (!raw) {
    return null
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return timeAgo(parsed.toISOString())
}

function resolveCompletedTimestamp(quest: CommanderQuest): number | null {
  return parseDateMillis(quest.completedAt) ?? parseDateMillis(quest.createdAt)
}

function sortByMostRecent(quests: CommanderQuest[]): CommanderQuest[] {
  return [...quests].sort((left, right) => {
    const leftTimestamp = resolveCompletedTimestamp(left) ?? 0
    const rightTimestamp = resolveCompletedTimestamp(right) ?? 0
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp
    }
    return left.id.localeCompare(right.id)
  })
}

function questTimeLabel(quest: CommanderQuest, status: QuestDisplayStatus): string {
  const created = formatRelativeTime(quest.createdAt)
  const completed = formatRelativeTime(quest.completedAt) ?? created

  if (status === 'done') {
    return completed ? `done ${completed}` : 'done'
  }
  if (status === 'failed') {
    return completed ? `failed ${completed}` : 'failed'
  }
  if (status === 'active') {
    return created ? `claimed ${created}` : 'claimed'
  }
  return created ? `created ${created}` : 'created'
}

function toKanbanStatus(rawStatus: string): QuestStatus {
  const normalized = normalizeStatus(rawStatus)
  if (normalized === 'unknown') {
    return 'active'
  }
  return normalized
}

function QuestCard({
  quest,
  commanderLabel,
  expanded,
  onToggleExpanded,
  isDeleting,
  onDelete,
}: {
  quest: CommanderQuest
  commanderLabel: string | null
  expanded: boolean
  onToggleExpanded: (questId: string) => void
  isDeleting: boolean
  onDelete: (quest: CommanderQuest) => Promise<void>
}) {
  const status = normalizeStatus(quest.status)
  const statusMeta = STATUS_META[status]
  const note = latestQuestNote(quest)
  const contract = contractSummary(quest.contract)
  const questArtifacts = parseQuestArtifacts(quest.artifacts)

  return (
    <article className="rounded-lg border border-ink-border bg-washi-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onToggleExpanded(quest.id)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-start gap-2">
            <ChevronUp
              size={14}
              className={cn('mt-0.5 shrink-0 transition-transform duration-200', expanded ? '' : 'rotate-180')}
            />
            <div className="min-w-0">
              <p className={cn('text-sm text-sumi-black', expanded ? 'whitespace-pre-wrap' : 'line-clamp-2')}>
                <span className="font-mono mr-2">{statusMeta.symbol}</span>
                {quest.instruction}
              </p>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn('badge-sumi', statusMeta.badgeClassName)}>
            {statusMeta.label}
          </span>
          <button
            type="button"
            onClick={() => void onDelete(quest)}
            disabled={isDeleting}
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

      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-whisper text-sumi-diluted truncate">
          {[commanderLabel, sourceLabel(quest.source)].filter(Boolean).join(' • ')}
        </span>
        <span className="text-whisper text-sumi-diluted shrink-0">{questTimeLabel(quest, status)}</span>
      </div>

      {expanded && note && (
        <p className="text-whisper text-sumi-mist mt-2 whitespace-pre-wrap">
          {status === 'done' ? 'Completed:' : status === 'failed' ? 'Failed:' : 'Note:'} {note}
        </p>
      )}

      {expanded && questArtifacts.length > 0 && (
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
    </article>
  )
}

export function QuestBoard({
  commanders,
  selectedCommanderId,
}: {
  commanders: QuestBoardCommander[]
  selectedCommanderId: string | null
}) {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [filterCommanderId, setFilterCommanderId] = useState<string | null>(selectedCommanderId)
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
  const [expandedQuestIds, setExpandedQuestIds] = useState<string[]>([])

  useEffect(() => {
    if (filterCommanderId === 'all') {
      return
    }
    if (filterCommanderId && commanders.some((commander) => commander.id === filterCommanderId)) {
      return
    }
    if (!selectedCommanderId && commanders.length === 0) {
      return
    }
    setFilterCommanderId(selectedCommanderId ?? commanders[0]?.id ?? 'all')
  }, [commanders, filterCommanderId, selectedCommanderId])

  useEffect(() => {
    if (filterCommanderId === 'all') {
      setShowForm(false)
    }
  }, [filterCommanderId])

  const activeFilterCommanderId = filterCommanderId ?? 'all'
  const selectedCommander = activeFilterCommanderId === 'all'
    ? null
    : commanders.find((commander) => commander.id === activeFilterCommanderId) ?? null
  const commanderLabels = useMemo(
    () => new Map(commanders.map((commander) => [commander.id, commander.host])),
    [commanders],
  )

  const questsQuery = useQuery({
    queryKey: ['commanders', 'quests', activeFilterCommanderId],
    queryFn: () => (
      activeFilterCommanderId === 'all'
        ? fetchAllCommanderQuests()
        : fetchCommanderQuests(activeFilterCommanderId)
    ),
    enabled: activeFilterCommanderId === 'all' || Boolean(selectedCommander?.id),
    refetchInterval: 10_000,
  })

  const createQuestMutation = useMutation({
    mutationFn: createCommanderQuest,
    onSuccess: async (_createdQuest, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'quests', input.commanderId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'quests', 'all'],
        }),
      ])
    },
  })

  const deleteQuestMutation = useMutation({
    mutationFn: deleteCommanderQuest,
    onSuccess: async (_data, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'quests', input.commanderId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['commanders', 'quests', 'all'],
        }),
      ])
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
    if (!selectedCommander) {
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
        commanderId: selectedCommander.id,
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
    const commanderId = quest.commanderId ?? selectedCommander?.id
    if (!commanderId) {
      return
    }
    setDeletingQuestId(quest.id)
    try {
      await deleteQuestMutation.mutateAsync({
        commanderId,
        questId: quest.id,
      })
    } finally {
      setDeletingQuestId(null)
    }
  }

  function toggleQuestExpanded(questId: string): void {
    setExpandedQuestIds((current) => (
      current.includes(questId)
        ? current.filter((entry) => entry !== questId)
        : [...current, questId]
    ))
  }

  const quests = questsQuery.data ?? []
  const kanbanColumns: Array<{ key: QuestStatus; title: string; emptyLabel: string }> = [
    { key: 'pending', title: 'Pending', emptyLabel: 'No pending quests.' },
    { key: 'active', title: 'Active', emptyLabel: 'No active quests.' },
    { key: 'done', title: 'Done', emptyLabel: 'No completed quests.' },
    { key: 'failed', title: 'Failed', emptyLabel: 'No failed quests.' },
  ]
  const questsByStatus = Object.fromEntries(
    kanbanColumns.map(({ key }) => [
      key,
      sortByMostRecent(quests.filter((quest) => toKanbanStatus(quest.status) === key)),
    ]),
  ) as Record<QuestStatus, CommanderQuest[]>
  const apiError = toErrorMessage(questsQuery.error) ?? toErrorMessage(createQuestMutation.error)

  return (
    <section className="card-sumi min-h-[16rem] xl:h-full overflow-hidden flex flex-col xl:min-h-0">
      <div className="px-3 pt-3 pb-1 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <label
            className="block text-whisper text-sumi-diluted uppercase tracking-wider"
            htmlFor="quests-commander-filter"
          >
            Commander
          </label>
          <select
            id="quests-commander-filter"
            value={activeFilterCommanderId}
            onChange={(event) => setFilterCommanderId(event.target.value)}
            className="w-full min-w-[15rem] rounded border border-ink-border bg-washi-white px-3 py-2 text-sm text-sumi-black focus:outline-none focus:border-sumi-black/40"
          >
            <option value="all">All commanders</option>
            {commanders.map((commander) => (
              <option key={commander.id} value={commander.id}>
                {commander.host} ({commander.id.slice(0, 8)})
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => setShowForm((current) => !current)}
          disabled={!selectedCommander}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex min-h-[44px] items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          {showForm ? 'Close' : 'Add Quest'}
        </button>
      </div>

      <ModalFormContainer
        open={Boolean(selectedCommander && showForm)}
        title="Add Quest"
        onClose={() => setShowForm(false)}
      >
        <QuestCreateForm
          source={source}
          onSourceChange={setSource}
          githubIssueUrl={githubIssueUrl}
          onGitHubIssueUrlChange={setGithubIssueUrl}
          onFetchIssue={() => void handleFetchIssue()}
          fetchingIssue={fetchingIssue}
          instruction={instruction}
          onInstructionChange={setInstruction}
          cwd={cwd}
          onCwdChange={setCwd}
          agentType={agentType}
          onAgentTypeChange={setAgentType}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          skillsInput={skillsInput}
          onSkillsInputChange={setSkillsInput}
          artifacts={artifacts}
          showArtifactForm={showArtifactForm}
          onToggleArtifactForm={() => setShowArtifactForm((current) => !current)}
          artifactType={artifactType}
          onArtifactTypeChange={setArtifactType}
          artifactLabel={artifactLabel}
          onArtifactLabelChange={setArtifactLabel}
          artifactHref={artifactHref}
          onArtifactHrefChange={setArtifactHref}
          onAddArtifact={handleAddArtifact}
          onRemoveArtifact={handleRemoveArtifact}
          formError={formError}
          submitPending={createQuestMutation.isPending}
          onSubmit={(event) => void handleSubmit(event)}
        />
      </ModalFormContainer>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {commanders.length === 0 && (
          <p className="text-sm text-sumi-diluted">Create a commander to start tracking quests.</p>
        )}

        {commanders.length > 0 && questsQuery.isLoading && quests.length === 0 && (
          <div className="flex items-center justify-center h-28">
            <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {commanders.length > 0 && !questsQuery.isLoading && !apiError && (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
            {kanbanColumns.map((column) => {
              const columnQuests = questsByStatus[column.key]
              return (
                <section key={column.key} className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-ink-border bg-washi-aged/60 px-3 py-2">
                    <p className="text-whisper uppercase tracking-wide text-sumi-diluted">{column.title}</p>
                    <span className="font-mono text-whisper text-sumi-mist">{columnQuests.length}</span>
                </div>
                  {columnQuests.length === 0 && (
                  <p className="rounded-lg border border-dashed border-ink-border px-3 py-2 text-whisper text-sumi-diluted">
                      {column.emptyLabel}
                  </p>
                )}
                  {columnQuests.map((quest) => (
                  <QuestCard
                    key={quest.id}
                    quest={quest}
                      commanderLabel={commanderLabels.get(quest.commanderId ?? '') ?? null}
                      expanded={expandedQuestIds.includes(quest.id)}
                      onToggleExpanded={toggleQuestExpanded}
                    isDeleting={deleteQuestMutation.isPending || deletingQuestId === quest.id}
                    onDelete={handleDelete}
                  />
                ))}
              </section>
              )
            })}
          </div>
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
