import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronUp, FileText, Folder, Loader2, Plus, Trash2, X } from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import { fetchJson, fetchVoid } from '@/lib/api'
import { ConfirmModal } from '@modules/components/ConfirmModal'
import { Toast } from '@modules/components/Toast'
import type { CommanderSession } from '../hooks/useCommander'
import { ModalFormContainer } from '../../components/ModalFormContainer'
import {
  fetchWorkspaceTree,
  resolveWorkspaceReference,
  useWorkspaceFilePreview,
  type WorkspaceSource,
} from '../../workspace/use-workspace'
import { WorkspaceFilePreviewModal } from '../../workspace/components/WorkspaceFilePreviewModal'
import type { WorkspaceTreeNode } from '../../workspace/types'
import { isValidQuestArtifactHref } from '../quest-artifact-href'
import {
  type QuestAgentType,
  type QuestArtifact,
  type QuestArtifactType,
  QUEST_ARTIFACT_PREFIX,
  QuestCreateForm,
  type QuestPermissionMode,
  type QuestSource,
} from './QuestCreateForm'

type QuestStatus = 'pending' | 'active' | 'blocked' | 'done' | 'failed'
type QuestDisplayStatus = QuestStatus | 'unknown'

interface QuestContract {
  cwd?: string | null
  agentType?: string | null
  model?: string | null
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
  blockedAt?: string | null
  blockedReason?: string | null
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

interface UpdateQuestArtifactsInput {
  commanderId: string
  questId: string
  artifacts: QuestArtifact[]
}

type QuestBoardCommander = Pick<CommanderSession, 'id' | 'host'>
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const QUEST_DRAFT_STORAGE_KEY = 'herd:quest-board:draft:v1'

interface QuestDraftSnapshot {
  showForm: boolean
  instruction: string
  source: QuestSource
  githubIssueUrl: string
  cwd: string
  agentType: QuestAgentType
  permissionMode: QuestPermissionMode
  selectedSkills: string[]
  artifacts: QuestArtifact[]
  showArtifactForm: boolean
  artifactType: QuestArtifactType
  artifactLabel: string
  artifactHref: string
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
  blocked: {
    symbol: '!',
    label: 'blocked',
    badgeClassName: 'badge-stale',
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
    normalized === 'blocked' ||
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

function safeQuestArtifactsForReplacement(raw: unknown): QuestArtifact[] {
  return parseQuestArtifacts(raw).filter(
    (artifact) => isValidQuestArtifactHref(artifact.type, artifact.href),
  )
}

function assertValidQuestArtifactHrefs(artifacts: readonly QuestArtifact[]): void {
  const invalidArtifact = artifacts.find(
    (artifact) => !isValidQuestArtifactHref(artifact.type, artifact.href),
  )
  if (invalidArtifact) {
    throw new Error(`Artifact href is invalid for type "${invalidArtifact.type}".`)
  }
}

function parseQuestSource(value: unknown): QuestSource {
  if (
    value === 'idea' ||
    value === 'github-issue' ||
    value === 'manual' ||
    value === 'voice-log'
  ) {
    return value
  }
  return 'manual'
}

function parseQuestPermissionMode(value: unknown): QuestPermissionMode {
  return value === 'default' ? value : 'default'
}

function parseQuestAgentType(value: unknown): QuestAgentType {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim() as QuestAgentType
    : 'claude'
}

function questDraftStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readQuestDraftSnapshot(): QuestDraftSnapshot | null {
  const raw = questDraftStorage()?.getItem(QUEST_DRAFT_STORAGE_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const data = parsed as Record<string, unknown>
    return {
      showForm: data.showForm === true,
      instruction: typeof data.instruction === 'string' ? data.instruction : '',
      source: parseQuestSource(data.source),
      githubIssueUrl: typeof data.githubIssueUrl === 'string' ? data.githubIssueUrl : '',
      cwd: typeof data.cwd === 'string' ? data.cwd : '',
      agentType: parseQuestAgentType(data.agentType),
      permissionMode: parseQuestPermissionMode(data.permissionMode),
      selectedSkills: Array.isArray(data.selectedSkills)
        ? data.selectedSkills.filter((entry): entry is string => typeof entry === 'string')
        : [],
      artifacts: parseQuestArtifacts(data.artifacts),
      showArtifactForm: data.showArtifactForm === true,
      artifactType: parseArtifactType(data.artifactType) ?? 'url',
      artifactLabel: typeof data.artifactLabel === 'string' ? data.artifactLabel : '',
      artifactHref: typeof data.artifactHref === 'string' ? data.artifactHref : '',
    }
  } catch {
    return null
  }
}

function writeQuestDraftSnapshot(snapshot: QuestDraftSnapshot): void {
  questDraftStorage()?.setItem(QUEST_DRAFT_STORAGE_KEY, JSON.stringify(snapshot))
}

function clearQuestDraftSnapshot(): void {
  questDraftStorage()?.removeItem(QUEST_DRAFT_STORAGE_KEY)
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

function artifactDisplayLabel(artifact: QuestArtifact): string {
  if (artifact.type === 'github_issue' || artifact.type === 'github_pr') {
    const match = artifact.href
      .trim()
      .match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i)
    if (match) {
      return `${match[1]}/${match[2]}#${match[3]}`
    }
  }

  return artifact.label
}

async function fetchCommanderQuests(commanderId: string): Promise<CommanderQuest[]> {
  return fetchJson<CommanderQuest[]>(`/api/commanders/${encodeURIComponent(commanderId)}/quests`)
}

async function fetchAllCommanderQuests(): Promise<CommanderQuest[]> {
  return fetchJson<CommanderQuest[]>('/api/commanders/quests')
}

async function createCommanderQuest(input: CreateQuestInput): Promise<CommanderQuest> {
  assertValidQuestArtifactHrefs(input.artifacts ?? [])
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

async function updateCommanderQuestArtifacts(input: UpdateQuestArtifactsInput): Promise<CommanderQuest> {
  assertValidQuestArtifactHrefs(input.artifacts)
  return fetchJson<CommanderQuest>(
    `/api/commanders/${encodeURIComponent(input.commanderId)}/quests/${encodeURIComponent(input.questId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifacts: input.artifacts }),
    },
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
  if (status === 'blocked') {
    const blocked = formatRelativeTime(quest.blockedAt) ?? created
    return blocked ? `blocked ${blocked}` : 'blocked'
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
  addingArtifact,
  artifactType,
  artifactLabel,
  artifactHref,
  artifactError,
  artifactPending,
  isDeleting,
  onRequestAddArtifact,
  onArtifactTypeChange,
  onArtifactLabelChange,
  onArtifactHrefChange,
  onSubmitArtifact,
  onCancelArtifact,
  onRemoveArtifact,
  onOpenArtifact,
  onDelete,
}: {
  quest: CommanderQuest
  commanderLabel: string | null
  expanded: boolean
  onToggleExpanded: (questId: string) => void
  addingArtifact: boolean
  artifactType: QuestArtifactType
  artifactLabel: string
  artifactHref: string
  artifactError: string | null
  artifactPending: boolean
  isDeleting: boolean
  onRequestAddArtifact: (quest: CommanderQuest) => void
  onArtifactTypeChange: (value: QuestArtifactType) => void
  onArtifactLabelChange: (value: string) => void
  onArtifactHrefChange: (value: string) => void
  onSubmitArtifact: (quest: CommanderQuest) => Promise<void>
  onCancelArtifact: () => void
  onRemoveArtifact: (quest: CommanderQuest, artifactIndex: number) => Promise<void>
  onOpenArtifact: (quest: CommanderQuest, artifact: QuestArtifact) => Promise<void>
  onDelete: (quest: CommanderQuest) => Promise<void>
}) {
  const status = normalizeStatus(quest.status)
  const statusMeta = STATUS_META[status]
  const note = latestQuestNote(quest)
  const contract = contractSummary(quest.contract)
  const questArtifacts = parseQuestArtifacts(quest.artifacts)

  return (
    <article className={cn(
      'rounded-lg border border-ink-border bg-washi-white',
      expanded ? 'px-3 py-2.5' : 'px-2 py-1',
    )}>
      <div className={cn('flex justify-between gap-3', expanded ? 'items-start' : 'items-center')}>
        <button
          type="button"
          onClick={() => onToggleExpanded(quest.id)}
          className={cn(
            'min-w-0 flex-1 text-left',
            !expanded && 'rounded-md px-1 py-0.5 transition-colors hover:bg-ink-wash focus:outline-none focus:ring-1 focus:ring-sumi-black/10',
          )}
        >
          <div className={cn('flex min-w-0 gap-2', expanded ? 'items-start' : 'items-center')}>
            <ChevronUp
              size={14}
              className={cn('shrink-0 transition-transform duration-200', expanded ? 'mt-0.5' : 'rotate-180')}
            />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm text-sumi-black', expanded ? 'whitespace-pre-wrap' : 'truncate leading-6')}>
                <span className="font-mono mr-2">{statusMeta.symbol}</span>
                {quest.instruction}
              </p>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onRequestAddArtifact(quest)}
            title="Add artifact"
            aria-label={`Add artifact to ${quest.instruction}`}
            className="inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-ink-border text-sumi-diluted hover:border-ink-border-hover hover:text-sumi-black transition-colors"
          >
            <Plus size={12} />
          </button>
          <span className={cn('badge-sumi', statusMeta.badgeClassName)}>
            {statusMeta.label}
          </span>
          {expanded && (
            <button
              type="button"
              onClick={() => void onDelete(quest)}
              disabled={isDeleting}
              title="Delete quest"
              className="rounded border border-ink-border p-1 text-sumi-diluted hover:text-accent-vermillion hover:border-accent-vermillion/40 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {expanded && contract && (
        <p className="text-whisper text-sumi-diluted mt-1 truncate">{contract}</p>
      )}

      {expanded && (
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-whisper text-sumi-diluted truncate">
          {[commanderLabel, sourceLabel(quest.source)].filter(Boolean).join(' • ')}
        </span>
        <span className="text-whisper text-sumi-diluted shrink-0">{questTimeLabel(quest, status)}</span>
      </div>
      )}

      {expanded && note && (
        <p className="text-whisper text-sumi-mist mt-2 whitespace-pre-wrap">
          {status === 'done' ? 'Completed:' : status === 'failed' ? 'Failed:' : status === 'blocked' ? 'Blocked:' : 'Note:'} {note}
        </p>
      )}

      {(questArtifacts.length > 0 || addingArtifact) && (
        <div className="mt-2 space-y-2">
          {questArtifacts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {questArtifacts.map((artifact, index) => {
                const chipClassName = 'inline-flex min-h-[32px] max-w-full items-center gap-1 rounded border border-ink-border bg-washi-aged/45 px-2 py-0.5 text-whisper text-sumi-diluted hover:border-ink-border-hover hover:text-sumi-black focus:outline-none focus:ring-1 focus:ring-sumi-black/10 transition-colors'
                const inertChipClassName = 'inline-flex min-h-[32px] max-w-full items-center gap-1 rounded border border-ink-border bg-washi-aged/45 px-2 py-0.5 text-whisper text-sumi-diluted'
                const chipLabel = `[${QUEST_ARTIFACT_PREFIX[artifact.type]}] ${artifactDisplayLabel(artifact)}`
                const safeLinkedArtifact = artifact.type !== 'file'
                  && isValidQuestArtifactHref(artifact.type, artifact.href)
                return (
                  <span
                    key={`${quest.id}-${artifact.type}-${artifact.href}-${index}`}
                    className="inline-flex max-w-full items-center"
                  >
                    {artifact.type === 'file' ? (
                      <button
                        type="button"
                        onClick={() => void onOpenArtifact(quest, artifact)}
                        className={chipClassName}
                        title={artifact.href}
                      >
                        <span className="truncate">{chipLabel}</span>
                      </button>
                    ) : safeLinkedArtifact ? (
                      <a
                        href={artifact.href}
                        target="_blank"
                        rel="noreferrer"
                        className={chipClassName}
                        title={artifact.href}
                      >
                        <span className="truncate">{chipLabel}</span>
                      </a>
                    ) : (
                      <span
                        className={inertChipClassName}
                        title={artifact.href}
                        aria-label={`${chipLabel} (invalid link)`}
                      >
                        <span className="truncate">{chipLabel}</span>
                      </span>
                    )}
                    {expanded && (
                      <button
                        type="button"
                        onClick={() => void onRemoveArtifact(quest, index)}
                        disabled={artifactPending}
                        title={`Remove ${artifact.label}`}
                        aria-label={`Remove ${artifact.label}`}
                        className="-ml-px inline-flex min-h-[32px] min-w-[28px] items-center justify-center rounded-r border border-ink-border bg-washi-white text-sumi-diluted hover:text-accent-vermillion disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
          )}

          {addingArtifact && (
            <div className="rounded-md border border-ink-border bg-washi-aged/50 p-2">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1.4fr)]">
                <select
                  value={artifactType}
                  onChange={(event) => onArtifactTypeChange(event.target.value as QuestArtifactType)}
                  className="w-full rounded border border-ink-border bg-washi-white px-2 py-1.5 text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                  aria-label="Artifact type"
                >
                  <option value="github_issue">github_issue</option>
                  <option value="github_pr">github_pr</option>
                  <option value="url">url</option>
                  <option value="file">file</option>
                </select>
                <input
                  value={artifactLabel}
                  onChange={(event) => onArtifactLabelChange(event.target.value)}
                  placeholder="Label"
                  className="w-full rounded border border-ink-border bg-washi-white px-2 py-1.5 text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                  aria-label="Artifact label"
                />
                <input
                  value={artifactHref}
                  onChange={(event) => onArtifactHrefChange(event.target.value)}
                  placeholder="URL or file path"
                  className="w-full rounded border border-ink-border bg-washi-white px-2 py-1.5 text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
                  aria-label="Artifact href"
                />
              </div>
              {artifactError && (
                <p className="mt-2 text-xs text-accent-vermillion">{artifactError}</p>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onCancelArtifact}
                  disabled={artifactPending}
                  className="rounded border border-ink-border px-2 py-1 text-xs hover:bg-ink-wash disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onSubmitArtifact(quest)}
                  disabled={artifactPending}
                  className="inline-flex items-center gap-1 rounded border border-ink-border bg-washi-white px-2 py-1 text-xs hover:bg-ink-wash disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {artifactPending && <Loader2 size={11} className="animate-spin" />}
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function WorkspaceDirectoryModal({
  path,
  nodes,
  loading,
  onClose,
  onOpenNode,
}: {
  path: string
  nodes: WorkspaceTreeNode[]
  loading: boolean
  onClose: () => void
  onOpenNode: (node: WorkspaceTreeNode) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-sumi-black/40 p-0 md:items-center md:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace directory"
        className="flex h-[78dvh] w-full flex-col overflow-hidden rounded-t-xl border border-ink-border bg-washi-white shadow-xl md:h-[70dvh] md:max-w-3xl md:rounded-xl"
      >
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-ink-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-whisper uppercase tracking-wide text-sumi-diluted">
              Workspace directory
            </p>
            <p className="truncate font-mono text-sm text-sumi-black">{path || '.'}</p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-sumi-diluted hover:bg-ink-wash"
            onClick={onClose}
            aria-label="Close directory"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={16} className="animate-spin text-sumi-diluted" />
            </div>
          )}
          {!loading && nodes.length === 0 && (
            <p className="rounded-lg border border-dashed border-ink-border px-3 py-2 text-sm text-sumi-diluted">
              Directory is empty.
            </p>
          )}
          {!loading && nodes.length > 0 && (
            <div className="space-y-1">
              {nodes.map((node) => (
                <button
                  key={node.path}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-ink-wash"
                  onClick={() => onOpenNode(node)}
                >
                  {node.type === 'directory'
                    ? <Folder size={15} className="shrink-0 text-sumi-diluted" />
                    : <FileText size={15} className="shrink-0 text-sumi-diluted" />}
                  <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
                  <span className="text-whisper text-sumi-diluted">{node.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
  const [permissionMode, setPermissionMode] = useState<QuestPermissionMode>('default')
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [artifacts, setArtifacts] = useState<QuestArtifact[]>([])
  const [showArtifactForm, setShowArtifactForm] = useState(false)
  const [artifactType, setArtifactType] = useState<QuestArtifactType>('url')
  const [artifactLabel, setArtifactLabel] = useState('')
  const [artifactHref, setArtifactHref] = useState('')
  const [activeArtifactQuestId, setActiveArtifactQuestId] = useState<string | null>(null)
  const [cardArtifactType, setCardArtifactType] = useState<QuestArtifactType>('file')
  const [cardArtifactLabel, setCardArtifactLabel] = useState('')
  const [cardArtifactHref, setCardArtifactHref] = useState('')
  const [cardArtifactError, setCardArtifactError] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<WorkspaceSource | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [directorySource, setDirectorySource] = useState<WorkspaceSource | null>(null)
  const [directoryPath, setDirectoryPath] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [fetchingIssue, setFetchingIssue] = useState(false)
  const [deletingQuestId, setDeletingQuestId] = useState<string | null>(null)
  const [expandedQuestIds, setExpandedQuestIds] = useState<string[]>([])
  const [showOlderDoneQuests, setShowOlderDoneQuests] = useState(false)
  const [confirmDirtyCloseOpen, setConfirmDirtyCloseOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [draftStorageReady, setDraftStorageReady] = useState(false)

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

  useEffect(() => {
    setShowOlderDoneQuests(false)
  }, [filterCommanderId])

  useEffect(() => {
    if (!toastMessage) {
      return
    }

    const timer = window.setTimeout(() => {
      setToastMessage(null)
    }, 2500)

    return () => {
      window.clearTimeout(timer)
    }
  }, [toastMessage])

  useEffect(() => {
    const storedDraft = readQuestDraftSnapshot()
    if (storedDraft) {
      setShowForm(storedDraft.showForm)
      setInstruction(storedDraft.instruction)
      setSource(storedDraft.source)
      setGithubIssueUrl(storedDraft.githubIssueUrl)
      setCwd(storedDraft.cwd)
      setAgentType(storedDraft.agentType)
      setPermissionMode(storedDraft.permissionMode)
      setSelectedSkills(storedDraft.selectedSkills)
      setArtifacts(storedDraft.artifacts)
      setShowArtifactForm(storedDraft.showArtifactForm)
      setArtifactType(storedDraft.artifactType)
      setArtifactLabel(storedDraft.artifactLabel)
      setArtifactHref(storedDraft.artifactHref)
    }
    setDraftStorageReady(true)
  }, [])

  const activeFilterCommanderId = filterCommanderId ?? 'all'
  const selectedCommander = activeFilterCommanderId === 'all'
    ? null
    : commanders.find((commander) => commander.id === activeFilterCommanderId) ?? null
  const commanderLabels = useMemo(
    () => new Map(commanders.map((commander) => [commander.id, commander.host])),
    [commanders],
  )
  const isQuestDraftDirty = source !== 'manual'
    || githubIssueUrl.trim().length > 0
    || instruction.trim().length > 0
    || cwd.trim().length > 0
    || agentType !== 'claude'
    || permissionMode !== 'default'
    || selectedSkills.length > 0
    || artifacts.length > 0
    || artifactLabel.trim().length > 0
    || artifactHref.trim().length > 0
    || artifactType !== 'url'

  useEffect(() => {
    if (!draftStorageReady) {
      return
    }
    if (!isQuestDraftDirty) {
      clearQuestDraftSnapshot()
      return
    }
    writeQuestDraftSnapshot({
      showForm,
      instruction,
      source,
      githubIssueUrl,
      cwd,
      agentType,
      permissionMode,
      selectedSkills,
      artifacts,
      showArtifactForm,
      artifactType,
      artifactLabel,
      artifactHref,
    })
  }, [
    agentType,
    artifactHref,
    artifactLabel,
    artifacts,
    artifactType,
    cwd,
    draftStorageReady,
    githubIssueUrl,
    instruction,
    isQuestDraftDirty,
    permissionMode,
    selectedSkills,
    showArtifactForm,
    showForm,
    source,
  ])

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

  const updateArtifactsMutation = useMutation({
    mutationFn: updateCommanderQuestArtifacts,
    onSuccess: async (_updatedQuest, input) => {
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

  const activePreviewSource = previewSource ?? { kind: 'target' as const, targetId: '__inactive__' }
  const previewQuery = useWorkspaceFilePreview(
    activePreviewSource,
    previewPath,
    Boolean(previewSource && previewPath),
  )
  const activeDirectorySource = directorySource ?? { kind: 'target' as const, targetId: '__inactive__' }
  const directoryQuery = useQuery({
    queryKey: [
      'workspace',
      activeDirectorySource.targetId,
      'artifact-directory',
      directoryPath ?? '',
    ],
    queryFn: () => fetchWorkspaceTree(activeDirectorySource, directoryPath ?? ''),
    enabled: Boolean(directorySource),
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

  function resetQuestDraft(): void {
    clearQuestDraftSnapshot()
    setInstruction('')
    setSource('manual')
    setGithubIssueUrl('')
    setCwd('')
    setAgentType('claude')
    setPermissionMode('default')
    setSelectedSkills([])
    setArtifacts([])
    setShowArtifactForm(false)
    setArtifactType('url')
    setArtifactLabel('')
    setArtifactHref('')
    setFormError(null)
  }

  function resetCardArtifactDraft(): void {
    setActiveArtifactQuestId(null)
    setCardArtifactType('file')
    setCardArtifactLabel('')
    setCardArtifactHref('')
    setCardArtifactError(null)
  }

  function handleRequestAddCardArtifact(quest: CommanderQuest): void {
    setActiveArtifactQuestId(quest.id)
    setCardArtifactType('file')
    setCardArtifactLabel('')
    setCardArtifactHref('')
    setCardArtifactError(null)
    setExpandedQuestIds((current) => current.includes(quest.id) ? current : [...current, quest.id])
  }

  function resolveQuestCommanderId(quest: CommanderQuest): string | null {
    return quest.commanderId ?? selectedCommander?.id ?? null
  }

  async function handleSubmitCardArtifact(quest: CommanderQuest): Promise<void> {
    const commanderId = resolveQuestCommanderId(quest)
    if (!commanderId) {
      setCardArtifactError('Commander is required to update artifacts.')
      return
    }
    const label = cardArtifactLabel.trim()
    const href = cardArtifactHref.trim()
    if (!label || !href) {
      setCardArtifactError('Artifact label and href are required.')
      return
    }
    if (!isValidQuestArtifactHref(cardArtifactType, href)) {
      setCardArtifactError(`Artifact href is invalid for type "${cardArtifactType}".`)
      return
    }

    setCardArtifactError(null)
    try {
      await updateArtifactsMutation.mutateAsync({
        commanderId,
        questId: quest.id,
        artifacts: [
          ...safeQuestArtifactsForReplacement(quest.artifacts),
          { type: cardArtifactType, label, href },
        ],
      })
      resetCardArtifactDraft()
      setToastMessage('Artifact added.')
    } catch (error) {
      setCardArtifactError(toErrorMessage(error) ?? 'Failed to add artifact.')
    }
  }

  async function handleRemoveCardArtifact(quest: CommanderQuest, artifactIndex: number): Promise<void> {
    const commanderId = resolveQuestCommanderId(quest)
    if (!commanderId) {
      setCardArtifactError('Commander is required to update artifacts.')
      return
    }
    const currentArtifacts = parseQuestArtifacts(quest.artifacts)
    if (artifactIndex < 0 || artifactIndex >= currentArtifacts.length) {
      setCardArtifactError('Artifact no longer exists.')
      return
    }

    setCardArtifactError(null)
    try {
      await updateArtifactsMutation.mutateAsync({
        commanderId,
        questId: quest.id,
        artifacts: currentArtifacts
          .filter((_artifact, index) => index !== artifactIndex)
          .filter((artifact) => isValidQuestArtifactHref(artifact.type, artifact.href)),
      })
      setToastMessage('Artifact removed.')
    } catch (error) {
      setActiveArtifactQuestId(quest.id)
      setCardArtifactError(toErrorMessage(error) ?? 'Failed to remove artifact.')
    }
  }

  async function handleOpenArtifact(quest: CommanderQuest, artifact: QuestArtifact): Promise<void> {
    if (artifact.type !== 'file') {
      return
    }
    const commanderId = resolveQuestCommanderId(quest)
    setPreviewError(null)
    try {
      const resolution = await resolveWorkspaceReference({
        path: artifact.href,
        commanderId,
        pathHint: nonEmpty(quest.contract?.cwd) ?? undefined,
      })
      if (!resolution.targetId) {
        setPreviewError('Workspace resolver did not return a target.')
        return
      }
      if (resolution.type === 'directory') {
        setDirectorySource({
          kind: 'target',
          targetId: resolution.targetId,
          label: resolution.targetLabel,
          readOnly: true,
        })
        setDirectoryPath(resolution.path)
        return
      }
      setPreviewSource({
        kind: 'target',
        targetId: resolution.targetId,
        label: resolution.targetLabel,
        readOnly: true,
      })
      setPreviewPath(resolution.path)
    } catch (error) {
      setPreviewError(toErrorMessage(error) ?? 'Failed to open file artifact.')
    }
  }

  function closePreview(): void {
    setPreviewSource(null)
    setPreviewPath(null)
    setPreviewError(null)
  }

  function closeDirectory(): void {
    setDirectorySource(null)
    setDirectoryPath(null)
  }

  function handleDirectoryNodeOpen(node: WorkspaceTreeNode): void {
    if (!directorySource) {
      return
    }
    if (node.type === 'directory') {
      setDirectoryPath(node.path)
      return
    }
    setPreviewSource(directorySource)
    setPreviewPath(node.path)
  }

  function handleRequestCloseForm(): void {
    if (isQuestDraftDirty) {
      setConfirmDirtyCloseOpen(true)
      return
    }
    setShowForm(false)
  }

  function handleDiscardDraftAndClose(): void {
    setConfirmDirtyCloseOpen(false)
    resetQuestDraft()
    setShowForm(false)
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

    const contract = {
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(agentType ? { agentType } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(selectedSkills.length > 0 ? { skillsToUse: selectedSkills } : {}),
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
      resetQuestDraft()
      setShowForm(false)
      setToastMessage('Quest added.')
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
    if (!isValidQuestArtifactHref(artifactType, href)) {
      setFormError(`Artifact href is invalid for type "${artifactType}".`)
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
      setToastMessage('Quest deleted.')
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
    { key: 'pending', title: 'Pending (unclaimed)', emptyLabel: 'No pending quests.' },
    { key: 'active', title: 'Active', emptyLabel: 'No active quests.' },
    { key: 'blocked', title: 'Blocked', emptyLabel: 'No blocked quests.' },
    { key: 'failed', title: 'Failed', emptyLabel: 'No failed quests.' },
    { key: 'done', title: 'Done', emptyLabel: 'No completed quests.' },
  ]
  const questsByStatus = Object.fromEntries(
    kanbanColumns.map(({ key }) => [
      key,
      sortByMostRecent(quests.filter((quest) => toKanbanStatus(quest.status) === key)),
    ]),
  ) as Record<QuestStatus, CommanderQuest[]>
  const doneHistoryBoundary = Date.now() - ONE_DAY_MS
  const recentDoneQuests = questsByStatus.done.filter((quest) => {
    const completedTimestamp = resolveCompletedTimestamp(quest)
    return completedTimestamp !== null && completedTimestamp >= doneHistoryBoundary
  })
  const olderDoneQuests = questsByStatus.done.filter((quest) => {
    const completedTimestamp = resolveCompletedTimestamp(quest)
    return completedTimestamp === null || completedTimestamp < doneHistoryBoundary
  })
  const apiError = toErrorMessage(questsQuery.error) ?? toErrorMessage(createQuestMutation.error)
  const footerError = apiError ?? previewError ?? toErrorMessage(directoryQuery.error)

  function renderQuestCard(quest: CommanderQuest) {
    return (
      <QuestCard
        key={quest.id}
        quest={quest}
        commanderLabel={commanderLabels.get(quest.commanderId ?? '') ?? null}
        expanded={expandedQuestIds.includes(quest.id)}
        onToggleExpanded={toggleQuestExpanded}
        addingArtifact={activeArtifactQuestId === quest.id}
        artifactType={cardArtifactType}
        artifactLabel={cardArtifactLabel}
        artifactHref={cardArtifactHref}
        artifactError={activeArtifactQuestId === quest.id ? cardArtifactError : null}
        artifactPending={updateArtifactsMutation.isPending}
        isDeleting={deleteQuestMutation.isPending || deletingQuestId === quest.id}
        onRequestAddArtifact={handleRequestAddCardArtifact}
        onArtifactTypeChange={setCardArtifactType}
        onArtifactLabelChange={setCardArtifactLabel}
        onArtifactHrefChange={setCardArtifactHref}
        onSubmitArtifact={handleSubmitCardArtifact}
        onCancelArtifact={resetCardArtifactDraft}
        onRemoveArtifact={handleRemoveCardArtifact}
        onOpenArtifact={handleOpenArtifact}
        onDelete={handleDelete}
      />
    )
  }

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
          onClick={() => {
            if (showForm) {
              handleRequestCloseForm()
              return
            }
            setShowForm(true)
          }}
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
        onClose={handleRequestCloseForm}
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
          directoryHost={selectedCommander?.host}
          agentType={agentType}
          onAgentTypeChange={setAgentType}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          selectedSkills={selectedSkills}
          onSelectedSkillsChange={setSelectedSkills}
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
          canClearDraft={isQuestDraftDirty}
          onSubmit={(event) => void handleSubmit(event)}
          onClearDraft={resetQuestDraft}
        />
      </ModalFormContainer>
      <ConfirmModal
        open={confirmDirtyCloseOpen}
        title="Discard quest draft?"
        message="This quest draft has unsaved changes. Discard it and close the form?"
        confirmLabel="Discard draft"
        confirmTone="danger"
        onClose={() => setConfirmDirtyCloseOpen(false)}
        onConfirm={handleDiscardDraftAndClose}
      />

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
          <div className="space-y-3">
            {kanbanColumns.map((column) => {
              const columnQuests = questsByStatus[column.key]
              const isDoneColumn = column.key === 'done'
              return (
                <section
                  key={column.key}
                  className="rounded-lg border border-ink-border bg-washi-aged/30 p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between rounded-lg border border-ink-border bg-washi-aged/60 px-3 py-2">
                    <p className="text-whisper uppercase tracking-wide text-sumi-diluted">{column.title}</p>
                    <span className="font-mono text-whisper text-sumi-mist">{columnQuests.length}</span>
                  </div>

                  {!isDoneColumn && columnQuests.length === 0 && (
                    <p className="rounded-lg border border-dashed border-ink-border px-3 py-2 text-whisper text-sumi-diluted">
                      {column.emptyLabel}
                    </p>
                  )}

                  {!isDoneColumn && columnQuests.map((quest) => renderQuestCard(quest))}

                  {isDoneColumn && (
                    <>
                      {recentDoneQuests.length === 0 && (
                        <p className="rounded-lg border border-dashed border-ink-border px-3 py-2 text-whisper text-sumi-diluted">
                          No completed quests in the past day.
                        </p>
                      )}

                      {recentDoneQuests.map((quest) => renderQuestCard(quest))}

                      {olderDoneQuests.length > 0 && (
                        <div className="rounded-lg border border-ink-border bg-washi-aged/40 p-2 space-y-2">
                          <button
                            type="button"
                            onClick={() => setShowOlderDoneQuests((current) => !current)}
                            className="w-full flex items-center justify-between gap-3 text-left"
                          >
                            <p className="text-whisper uppercase tracking-wide text-sumi-diluted">
                              Older completed quests
                            </p>
                            <span className="font-mono text-whisper text-sumi-mist">
                              {showOlderDoneQuests ? 'Hide' : 'Show'} {olderDoneQuests.length}
                            </span>
                          </button>

                          {showOlderDoneQuests && (
                            <div className="space-y-2">
                              {olderDoneQuests.map((quest) => renderQuestCard(quest))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {footerError && (
        <p className="border-t border-ink-border px-4 py-2 text-sm text-accent-vermillion">
          {footerError}
        </p>
      )}
      {directorySource && (
        <WorkspaceDirectoryModal
          path={directoryPath ?? ''}
          nodes={directoryQuery.data?.nodes ?? []}
          loading={directoryQuery.isLoading}
          onClose={closeDirectory}
          onOpenNode={handleDirectoryNodeOpen}
        />
      )}
      <WorkspaceFilePreviewModal
        open={Boolean(previewSource && previewPath)}
        selectedPath={previewPath}
        preview={previewQuery.data ?? null}
        draftContent={previewQuery.data?.content ?? ''}
        loading={previewQuery.isLoading}
        refreshing={previewQuery.isFetching && !previewQuery.isLoading}
        error={toErrorMessage(previewQuery.error)}
        readOnly={previewSource?.readOnly ?? true}
        onClose={closePreview}
        onRefresh={() => {
          void previewQuery.refetch()
        }}
      />
      <Toast open={Boolean(toastMessage)} message={toastMessage ?? ''} />
    </section>
  )
}
