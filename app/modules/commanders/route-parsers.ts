import type { Request } from 'express'
import type { CommandRoomTaskType } from '../command-room/task-store.js'
import { parseOptionalClaudeEffort, type ClaudeEffortLevel } from '../claude-effort.js'
import type { JournalEntry } from './memory/index.js'
import type {
  CommanderChannelMeta,
  CommanderCurrentTask,
  CommanderLastRoute,
  CommanderTaskSource,
  HeartbeatContextConfig,
} from './store.js'
import type {
  CommanderQuest,
  CommanderQuestContract,
  CommanderQuestSource,
  CommanderQuestStatus,
  QuestArtifact,
  QuestArtifactType,
} from './quest-store.js'
import type { GitHubIssueUrlParts } from './routes/types.js'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const CRON_TASK_ID_PATTERN = /^[a-z0-9-]+$/i
const QUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const MACHINE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const ISO_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const QUEST_STATUSES = new Set<CommanderQuestStatus>(['pending', 'active', 'done', 'failed'])
const QUEST_SOURCES = new Set<CommanderQuestSource>(['manual', 'github-issue', 'idea', 'voice-log'])
const QUEST_ARTIFACT_TYPES = new Set<QuestArtifactType>(['github_issue', 'github_pr', 'url', 'file'])
const SALIENCE_LEVELS = new Set<JournalEntry['salience']>(['SPIKE', 'NOTABLE', 'ROUTINE'])
const DEFAULT_CONTEXT_PRESSURE_INPUT_TOKEN_THRESHOLD = 150_000
const MAX_PERSONA_LENGTH = 500

export const COMMANDER_MEMORY_COMPACT_TASK_TYPE: CommandRoomTaskType = 'memory_compact'
export const COMMANDER_INSTRUCTION_TASK_TYPE: CommandRoomTaskType = 'instruction'

export type CommanderMessageMode = 'collect' | 'followup'

export interface ParsedChannelMessageInput {
  message: string
  mode: CommanderMessageMode
  channelMeta: CommanderChannelMeta
  lastRoute: CommanderLastRoute
  host: string
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parseSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !SESSION_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export function parseHost(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !HOST_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export function parseMachineId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !MACHINE_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export function parseLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parseTaskSource(raw: unknown): CommanderTaskSource | null {
  if (!isObject(raw)) {
    return null
  }

  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!owner || !repo) {
    return null
  }

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : undefined
  const project = typeof raw.project === 'string' && raw.project.trim().length > 0
    ? raw.project.trim()
    : undefined

  return {
    owner,
    repo,
    label,
    project,
  }
}

export function parseOptionalHeartbeatContextConfig(
  raw: unknown,
): { valid: boolean; value: HeartbeatContextConfig | undefined } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: undefined }
  }

  if (!isObject(raw)) {
    return { valid: false, value: undefined }
  }

  const fatPinInterval = raw.fatPinInterval
  if (fatPinInterval === undefined) {
    return { valid: true, value: {} }
  }

  if (
    typeof fatPinInterval !== 'number' ||
    !Number.isInteger(fatPinInterval) ||
    fatPinInterval < 1
  ) {
    return { valid: false, value: undefined }
  }

  return {
    valid: true,
    value: { fatPinInterval },
  }
}

export function parseOptionalCurrentTask(
  raw: unknown,
  nowIso: string,
): { valid: boolean; value: CommanderCurrentTask | null } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null }
  }

  if (!isObject(raw)) {
    return { valid: false, value: null }
  }

  const issueNumber = raw.issueNumber
  const issueUrl = raw.issueUrl
  const startedAt = raw.startedAt
  if (
    typeof issueNumber !== 'number' ||
    !Number.isInteger(issueNumber) ||
    issueNumber < 1 ||
    typeof issueUrl !== 'string' ||
    issueUrl.trim().length === 0
  ) {
    return { valid: false, value: null }
  }

  return {
    valid: true,
    value: {
      issueNumber,
      issueUrl: issueUrl.trim(),
      startedAt: typeof startedAt === 'string' && startedAt.trim().length > 0
        ? startedAt.trim()
        : nowIso,
    },
  }
}

export function parseMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parseOptionalPersona(
  raw: unknown,
): { valid: true; value: string | undefined } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: undefined }
  }
  if (typeof raw !== 'string') {
    return { valid: false }
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { valid: true, value: undefined }
  }
  if (trimmed.length > MAX_PERSONA_LENGTH) {
    return { valid: false }
  }
  return { valid: true, value: trimmed }
}

function parseChannelProvider(raw: unknown): CommanderChannelMeta['provider'] | null {
  return raw === 'whatsapp' || raw === 'telegram' || raw === 'discord'
    ? raw
    : null
}

function parseChannelChatType(raw: unknown): CommanderChannelMeta['chatType'] | null {
  return raw === 'direct' || raw === 'group' || raw === 'channel' || raw === 'forum-topic'
    ? raw
    : null
}

function normalizeChannelHostToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

function buildChannelCommanderHost(
  meta: Pick<CommanderChannelMeta, 'provider' | 'chatType' | 'peerId'>,
): string {
  const parts = [
    normalizeChannelHostToken(meta.provider),
    normalizeChannelHostToken(meta.chatType),
    normalizeChannelHostToken(meta.peerId),
  ].filter((part) => part.length > 0)

  return parts.join('-') || `${meta.provider}-channel`
}

function buildCommanderSessionKeyFromChannelMeta(
  meta: Pick<CommanderChannelMeta, 'provider' | 'accountId' | 'chatType' | 'peerId' | 'threadId'>,
): string {
  const base = `${meta.provider}:${meta.accountId}:${meta.chatType}:${meta.peerId}`
  if (meta.chatType === 'forum-topic' && meta.threadId) {
    return `${base}:thread:${meta.threadId}`
  }
  return base
}

export function parseChannelMessageInput(
  raw: unknown,
): { valid: true; value: ParsedChannelMessageInput } | { valid: false; error: string } {
  if (!isObject(raw)) {
    return { valid: false, error: 'Payload must be a JSON object' }
  }

  const provider = parseChannelProvider(raw.provider)
  if (!provider) {
    return { valid: false, error: 'provider must be one of: whatsapp, telegram, discord' }
  }

  const accountId = parseMessage(raw.accountId)
  if (!accountId) {
    return { valid: false, error: 'accountId is required' }
  }

  const parsedChatType = parseChannelChatType(raw.chatType)
  if (!parsedChatType) {
    return { valid: false, error: 'chatType must be one of: direct, group, channel, forum-topic' }
  }

  const parsedPeerId = parseMessage(raw.peerId)
  if (!parsedPeerId) {
    return { valid: false, error: 'peerId is required' }
  }

  const message = parseMessage(raw.message)
  if (!message) {
    return { valid: false, error: 'message must be a non-empty string' }
  }

  const mode = raw.mode === undefined ? 'followup' : parseMessageMode(raw.mode)
  if (!mode) {
    return { valid: false, error: 'mode must be either "collect" or "followup"' }
  }

  const displayName = parseMessage(raw.displayName)
  const subject = parseMessage(raw.subject)
  const space = parseMessage(raw.space)
  const groupId = parseMessage(raw.groupId)
  const parentPeerId = parseMessage(raw.parentPeerId)
  const threadId = parseMessage(raw.threadId)

  let chatType = parsedChatType
  let peerId = parsedPeerId
  let routeThreadId: string | undefined
  let canonicalParentPeerId = parentPeerId ?? undefined

  if (provider === 'whatsapp') {
    if (chatType !== 'direct' && chatType !== 'group') {
      return { valid: false, error: 'whatsapp chatType must be direct or group' }
    }
    if (threadId) {
      return { valid: false, error: 'whatsapp does not support threadId routing' }
    }
  }

  if (provider === 'telegram') {
    if (chatType !== 'direct' && chatType !== 'group' && chatType !== 'forum-topic') {
      return { valid: false, error: 'telegram chatType must be direct, group, or forum-topic' }
    }
    if (chatType === 'forum-topic') {
      if (!threadId) {
        return { valid: false, error: 'telegram forum-topic requires threadId' }
      }
      routeThreadId = threadId
    } else if (threadId) {
      return { valid: false, error: 'telegram threadId is only valid for forum-topic chatType' }
    }
  }

  if (provider === 'discord') {
    if (chatType !== 'direct' && chatType !== 'channel') {
      return { valid: false, error: 'discord chatType must be direct or channel' }
    }
    if (threadId) {
      if (chatType !== 'channel') {
        return { valid: false, error: 'discord threadId can only be used with channel chatType' }
      }
      const parent = parentPeerId ?? parsedPeerId
      if (!parent) {
        return { valid: false, error: 'discord thread routing requires parentPeerId or channel peerId' }
      }
      chatType = 'channel'
      peerId = parent
      routeThreadId = threadId
      canonicalParentPeerId = parent
    }
  }

  const resolvedDisplayName = displayName ?? subject ?? peerId
  const channelMeta: CommanderChannelMeta = {
    provider,
    chatType,
    accountId,
    peerId,
    ...(canonicalParentPeerId ? { parentPeerId: canonicalParentPeerId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(routeThreadId ? { threadId: routeThreadId } : {}),
    sessionKey: buildCommanderSessionKeyFromChannelMeta({
      provider,
      accountId,
      chatType,
      peerId,
      threadId: routeThreadId,
    }),
    displayName: resolvedDisplayName,
    ...(subject ? { subject } : {}),
    ...(space ? { space } : {}),
  }

  const lastRoute: CommanderLastRoute = {
    channel: provider,
    to: peerId,
    accountId,
    ...(routeThreadId ? { threadId: routeThreadId } : {}),
  }

  return {
    valid: true,
    value: {
      message,
      mode,
      channelMeta,
      lastRoute,
      host: buildChannelCommanderHost(channelMeta),
    },
  }
}

export function formatChannelCommanderDisplayName(meta: CommanderChannelMeta): string {
  const providerLabels: Record<CommanderChannelMeta['provider'], string> = {
    whatsapp: 'WhatsApp',
    telegram: 'Telegram',
    discord: 'Discord',
  }
  return `${providerLabels[meta.provider]} • ${meta.displayName}`
}

export function parseOptionalCommanderAgentType(
  raw: unknown,
): 'claude' | 'codex' | 'gemini' | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (raw === 'claude' || raw === 'codex' || raw === 'gemini') {
    return raw
  }
  return null
}

export function parseOptionalCommanderEffort(
  raw: unknown,
): ClaudeEffortLevel | undefined | null {
  return parseOptionalClaudeEffort(raw)
}

export function parseIssueNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return null
  }
  return raw
}

export function parseQuestId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !QUEST_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

export function parseQuestStatus(raw: unknown): CommanderQuestStatus | null {
  if (typeof raw !== 'string') {
    return null
  }
  return QUEST_STATUSES.has(raw as CommanderQuestStatus)
    ? (raw as CommanderQuestStatus)
    : null
}

export function parseQuestSource(raw: unknown): CommanderQuestSource | null {
  if (typeof raw !== 'string') {
    return null
  }
  return QUEST_SOURCES.has(raw as CommanderQuestSource)
    ? (raw as CommanderQuestSource)
    : null
}

function parseQuestArtifactType(raw: unknown): QuestArtifactType | null {
  if (typeof raw !== 'string') {
    return null
  }
  return QUEST_ARTIFACT_TYPES.has(raw as QuestArtifactType)
    ? (raw as QuestArtifactType)
    : null
}

export function parseQuestArtifacts(raw: unknown): QuestArtifact[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const artifacts: QuestArtifact[] = []
  for (const entry of raw) {
    if (!isObject(entry)) {
      return null
    }

    const type = parseQuestArtifactType(entry.type)
    const label = parseMessage(entry.label)
    const href = parseMessage(entry.href)
    if (!type || !label || !href) {
      return null
    }

    artifacts.push({ type, label, href })
  }
  return artifacts
}

export function parseQuestContract(raw: unknown): CommanderQuestContract | null {
  if (raw === undefined) {
    return {
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      agentType: 'claude',
      skillsToUse: [],
    }
  }

  if (!isObject(raw)) {
    return null
  }

  const cwd = parseMessage(raw.cwd) ?? process.cwd()
  const permissionMode = parseMessage(raw.permissionMode) ?? 'bypassPermissions'
  const agentType = parseMessage(raw.agentType) ?? 'claude'
  const skillsToUse = parseOptionalStringArray(raw.skillsToUse)
  if (skillsToUse === null) {
    return null
  }

  return {
    cwd,
    permissionMode,
    agentType,
    skillsToUse,
  }
}

export function parseGitHubIssueUrl(raw: unknown): GitHubIssueUrlParts | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    return null
  }

  const host = parsedUrl.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') {
    return null
  }

  const pathParts = parsedUrl.pathname.split('/').filter((entry) => entry.length > 0)
  if (pathParts.length < 4 || pathParts[2] !== 'issues') {
    return null
  }

  const owner = pathParts[0] ?? ''
  const repo = pathParts[1] ?? ''
  const issueNumber = Number.parseInt(pathParts[3] ?? '', 10)
  if (!owner || !repo || !Number.isInteger(issueNumber) || issueNumber < 1) {
    return null
  }

  return {
    owner,
    repo,
    issueNumber,
    normalizedUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  }
}

export function parseQuestIssueNumber(quest: Pick<CommanderQuest, 'githubIssueUrl'>): number | null {
  if (!quest.githubIssueUrl) {
    return null
  }
  const parsed = parseGitHubIssueUrl(quest.githubIssueUrl)
  return parsed?.issueNumber ?? null
}

export function parseOptionalStringArray(raw: unknown): string[] | null {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    return null
  }

  const cleaned: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return null
    }
    const trimmed = entry.trim()
    if (trimmed) {
      cleaned.push(trimmed)
    }
  }
  return cleaned
}

export function parseMessageMode(raw: unknown): CommanderMessageMode | null {
  if (raw === undefined) {
    return 'collect'
  }
  if (Array.isArray(raw)) {
    return parseMessageMode(raw[0])
  }
  if (typeof raw !== 'string') {
    return null
  }

  const normalized = raw.trim().toLowerCase()
  if (!normalized) {
    return 'collect'
  }
  if (normalized === 'collect' || normalized === 'followup') {
    return normalized as CommanderMessageMode
  }
  return null
}

export function parseIsoDateKey(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!ISO_DATE_KEY_PATTERN.test(trimmed)) {
    return null
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null
}

export function parseBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') {
    return null
  }

  const match = value.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return null
  }

  const token = match[1]?.trim()
  return token && token.length > 0 ? token : null
}

function parseJournalEntry(raw: unknown): JournalEntry | null {
  if (!isObject(raw)) {
    return null
  }

  const timestamp = parseMessage(raw.timestamp)
  const outcome = parseMessage(raw.outcome)
  const body = typeof raw.body === 'string' ? raw.body : null
  const salience =
    typeof raw.salience === 'string' && SALIENCE_LEVELS.has(raw.salience as JournalEntry['salience'])
      ? (raw.salience as JournalEntry['salience'])
      : null

  if (!timestamp || !outcome || body === null || !salience) {
    return null
  }

  const parsedDate = new Date(timestamp)
  if (Number.isNaN(parsedDate.getTime())) {
    return null
  }

  const issueNumber = raw.issueNumber
  if (
    issueNumber !== null &&
    issueNumber !== undefined &&
    (
      typeof issueNumber !== 'number' ||
      !Number.isInteger(issueNumber) ||
      issueNumber < 1
    )
  ) {
    return null
  }

  const durationMin = raw.durationMin
  if (
    durationMin !== null &&
    durationMin !== undefined &&
    (
      typeof durationMin !== 'number' ||
      !Number.isInteger(durationMin) ||
      durationMin < 0
    )
  ) {
    return null
  }

  const repo = raw.repo
  if (repo !== null && repo !== undefined && typeof repo !== 'string') {
    return null
  }

  return {
    timestamp,
    issueNumber: typeof issueNumber === 'number' ? issueNumber : null,
    repo: typeof repo === 'string' ? repo : null,
    outcome,
    durationMin: typeof durationMin === 'number' ? durationMin : null,
    salience,
    body,
  }
}

export function parseJournalEntries(raw: unknown): JournalEntry[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const entries: JournalEntry[] = []
  for (const entry of raw) {
    const parsed = parseJournalEntry(entry)
    if (!parsed) {
      return null
    }
    entries.push(parsed)
  }

  return entries
}

export function parseStringMap(raw: unknown): Record<string, string> | null {
  if (raw === undefined) {
    return {}
  }

  if (!isObject(raw)) {
    return null
  }

  const parsed: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const filePath = key.trim()
    if (!filePath || typeof value !== 'string') {
      return null
    }
    parsed[filePath] = value
  }
  return parsed
}

export function parsePositiveInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }

  return parsed
}

// heartbeat.interval in COMMANDER.md must be a positive integer (milliseconds).
// Cron expressions are not supported because the heartbeat system uses setInterval, not cron scheduling.
export function resolveWorkflowHeartbeatIntervalMs(rawInterval: string | undefined): number | undefined {
  if (rawInterval === undefined) {
    return undefined
  }

  const trimmed = rawInterval.trim()
  if (!trimmed) {
    return undefined
  }

  const ms = parsePositiveInteger(trimmed)
  return ms !== null ? ms : undefined
}

export function parseContextPressureInputTokenThreshold(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CONTEXT_PRESSURE_INPUT_TOKEN_THRESHOLD
  }

  return Math.floor(raw)
}

export function parseCommanderId(rawCommanderId: unknown): string | null {
  if (typeof rawCommanderId !== 'string') {
    return null
  }

  const commanderId = rawCommanderId.trim()
  if (!COMMANDER_ID_PATTERN.test(commanderId)) {
    return null
  }

  return commanderId
}

export function parseCronTaskId(rawCronTaskId: unknown): string | null {
  if (typeof rawCronTaskId !== 'string') {
    return null
  }

  const cronTaskId = rawCronTaskId.trim()
  if (!CRON_TASK_ID_PATTERN.test(cronTaskId)) {
    return null
  }

  return cronTaskId
}

export function parseSchedule(rawSchedule: unknown): string | null {
  if (typeof rawSchedule !== 'string') {
    return null
  }

  const schedule = rawSchedule.trim()
  if (schedule.length === 0) {
    return null
  }

  return schedule
}

export function parseCronInstruction(rawInstruction: unknown): string | null {
  if (typeof rawInstruction !== 'string') {
    return null
  }

  const instruction = rawInstruction.trim()
  if (instruction.length === 0) {
    return null
  }

  return instruction
}

export function parseCronTaskType(rawTaskType: unknown): CommandRoomTaskType | null {
  if (rawTaskType === undefined || rawTaskType === null) {
    return COMMANDER_INSTRUCTION_TASK_TYPE
  }
  if (typeof rawTaskType !== 'string') {
    return null
  }
  if (rawTaskType === COMMANDER_INSTRUCTION_TASK_TYPE || rawTaskType === COMMANDER_MEMORY_COMPACT_TASK_TYPE) {
    return rawTaskType
  }
  return null
}

export function buildCommanderMemoryCompactTaskName(commanderId: string): string {
  return `commander-${commanderId}-memory-compact`
}

export function parseOptionalEnabled(rawEnabled: unknown): boolean | undefined | null {
  if (rawEnabled === undefined) {
    return undefined
  }

  if (typeof rawEnabled !== 'boolean') {
    return null
  }

  return rawEnabled
}

export function parseTriggerInstruction(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const directInstruction = parseCronInstruction(
    (payload as { instruction?: unknown }).instruction,
  )
  if (directInstruction) {
    return directInstruction
  }

  const detail = (payload as { detail?: unknown }).detail
  if (!detail || typeof detail !== 'object') {
    return null
  }

  return parseCronInstruction((detail as { instruction?: unknown }).instruction)
}
