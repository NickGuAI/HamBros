import type { Request } from 'express'
import { parseProviderId, resolveDefaultProviderId } from '../agents/providers/registry.js'
import {
  DEFAULT_COMMANDER_CONTEXT_MODE,
  parseCommanderCostCapUsd,
} from './store.js'
import type {
  CommanderContextMode,
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
import { isValidQuestArtifactHref } from './quest-artifact-href.js'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const CRON_TASK_ID_PATTERN = /^[a-z0-9-]+$/i
const QUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const MACHINE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const QUEST_STATUSES = new Set<CommanderQuestStatus>(['pending', 'active', 'blocked', 'done', 'failed'])
const QUEST_SOURCES = new Set<CommanderQuestSource>(['manual', 'github-issue', 'idea', 'voice-log'])
const QUEST_ARTIFACT_TYPES = new Set<QuestArtifactType>(['github_issue', 'github_pr', 'url', 'file'])
const DEFAULT_CONTEXT_PRESSURE_INPUT_TOKEN_THRESHOLD = 150_000

export type CommanderMessageMode = 'collect' | 'followup'

export type ParsedChannelMessageChannelMeta = Omit<CommanderChannelMeta, 'displayName'> & {
  displayName?: string
}

export interface ParsedChannelMessageInput {
  message: string
  mode: CommanderMessageMode
  channelMeta: ParsedChannelMessageChannelMeta
  lastRoute: CommanderLastRoute
  commanderId?: string
  host: string
  audio?: {
    buffer: Buffer
    mimeType: string
    durationMs?: number
  }
  rawTimestamp: string | number
  rawSourceId: string
  metadata?: Record<string, unknown>
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

function parseOptionalDefaultPermissionMode(raw: unknown): 'default' | null | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  return raw === 'default' ? 'default' : null
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

export function parseOptionalCommanderMaxTurns(
  raw: unknown,
  options: {
    max?: number
  } = {},
): { valid: boolean; value: number | undefined } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: undefined }
  }

  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    (
      typeof options.max === 'number'
      && Number.isInteger(options.max)
      && options.max > 0
      && raw > options.max
    )
  ) {
    return { valid: false, value: undefined }
  }

  return { valid: true, value: raw }
}

export function parseOptionalCommanderCostCapUsd(
  raw: unknown,
): { valid: boolean; value: number | null | undefined } {
  if (raw === undefined) {
    return { valid: true, value: undefined }
  }
  if (raw === null) {
    return { valid: true, value: null }
  }

  const parsed = parseCommanderCostCapUsd(raw)
  if (parsed === null) {
    return { valid: false, value: undefined }
  }

  return { valid: true, value: parsed }
}

export function parseOptionalCommanderContextMode(
  raw: unknown,
): { valid: boolean; value: CommanderContextMode | undefined } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: undefined }
  }

  if (raw !== 'thin' && raw !== DEFAULT_COMMANDER_CONTEXT_MODE) {
    return { valid: false, value: undefined }
  }

  return {
    valid: true,
    value: raw as CommanderContextMode,
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

function parseChannelProvider(raw: unknown): CommanderChannelMeta['provider'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as CommanderChannelMeta['provider']
    : null
}

function parseChannelChatType(raw: unknown): CommanderChannelMeta['chatType'] | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{1,63}$/i.test(normalized)
    ? normalized as CommanderChannelMeta['chatType']
    : null
}

function parseAudioBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return Buffer.from(raw.trim(), 'base64')
  }
  if (Array.isArray(raw) && raw.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return Buffer.from(raw)
  }
  if (
    isObject(raw) &&
    raw.type === 'Buffer' &&
    Array.isArray(raw.data) &&
    raw.data.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    return Buffer.from(raw.data)
  }
  return null
}

function parseChannelAudio(raw: unknown): ParsedChannelMessageInput['audio'] | undefined {
  if (!isObject(raw)) {
    return undefined
  }
  const buffer = parseAudioBuffer(raw.buffer)
  const mimeType = parseMessage(raw.mimeType)
  if (!buffer || !mimeType) {
    return undefined
  }
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
    ? Math.floor(raw.durationMs)
    : undefined
  return {
    buffer,
    mimeType,
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

function parseOptionalStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const values = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return values.length > 0 ? values : undefined
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
  if (meta.threadId) {
    return `${base}:thread:${meta.threadId}`
  }
  return base
}

function parseChannelMetadata(raw: unknown): Record<string, unknown> | undefined {
  return isObject(raw) ? { ...raw } : undefined
}

export function parseChannelMessageInput(
  raw: unknown,
): { valid: true; value: ParsedChannelMessageInput } | { valid: false; error: string } {
  if (!isObject(raw)) {
    return { valid: false, error: 'Payload must be a JSON object' }
  }

  const provider = parseChannelProvider(raw.provider)
  if (!provider) {
    return { valid: false, error: 'provider must be a channel provider id' }
  }

  const accountId = parseMessage(raw.accountId)
  if (!accountId) {
    return { valid: false, error: 'accountId is required' }
  }

  const parsedChatType = raw.chatType === undefined
    ? 'direct'
    : parseChannelChatType(raw.chatType)
  if (!parsedChatType) {
    return { valid: false, error: 'chatType must be a channel chat type id' }
  }

  const parsedPeerId = parseMessage(raw.peerId)
  if (!parsedPeerId) {
    return { valid: false, error: 'peerId is required' }
  }

  const audio = parseChannelAudio(raw.audio)
  const message = parseMessage(raw.message) ?? parseMessage(raw.text)
  if (!message && !audio) {
    return { valid: false, error: 'message must be a non-empty string when audio is absent' }
  }

  const mode = raw.mode === undefined ? 'followup' : parseMessageMode(raw.mode)
  if (!mode) {
    return { valid: false, error: 'mode must be either "collect" or "followup"' }
  }

  const commanderId = raw.commanderId === undefined
    ? undefined
    : parseCommanderId(raw.commanderId)
  if (raw.commanderId !== undefined && !commanderId) {
    return { valid: false, error: 'commanderId is invalid' }
  }

  const displayName = parseMessage(raw.displayName)
  const subject = parseMessage(raw.subject)
  const space = parseMessage(raw.space)
  const groupId = parseMessage(raw.groupId)
  const threadId = parseMessage(raw.threadId)
  const references = parseOptionalStringList(raw.references)
  const metadata = parseChannelMetadata(raw.metadata)

  const chatType = parsedChatType
  const peerId = parsedPeerId
  const channelMeta: ParsedChannelMessageChannelMeta = {
    provider,
    chatType,
    accountId,
    peerId,
    ...(groupId ? { groupId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(references ? { references } : {}),
    sessionKey: buildCommanderSessionKeyFromChannelMeta({
      provider,
      accountId,
      chatType,
      peerId,
      threadId: threadId ?? undefined,
    }),
    ...(displayName ? { displayName } : {}),
    ...(subject ? { subject } : {}),
    ...(space ? { space } : {}),
  }

  const lastRoute: CommanderLastRoute = {
    channel: provider,
    to: peerId,
    accountId,
    ...(threadId ? { threadId } : {}),
  }

  return {
    valid: true,
    value: {
      message: message ?? '',
      mode,
      ...(commanderId ? { commanderId } : {}),
      channelMeta,
      lastRoute,
      host: buildChannelCommanderHost(channelMeta),
      ...(audio ? { audio } : {}),
      ...(metadata ? { metadata } : {}),
      rawTimestamp: typeof raw.rawTimestamp === 'number' || typeof raw.rawTimestamp === 'string'
        ? raw.rawTimestamp
        : new Date().toISOString(),
      rawSourceId: parseMessage(raw.rawSourceId) ?? channelMeta.sessionKey,
    },
  }
}

export function parseOptionalCommanderAgentType(
  raw: unknown,
): string | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined
  }
  return parseProviderId(raw)
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
    if (!type || !label || !href || !isValidQuestArtifactHref(type, href)) {
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
      permissionMode: 'default',
      agentType: resolveDefaultProviderId(),
      model: null,
      skillsToUse: [],
    }
  }

  if (!isObject(raw)) {
    return null
  }

  const cwd = parseMessage(raw.cwd) ?? process.cwd()
  const permissionMode = parseOptionalDefaultPermissionMode(raw.permissionMode)
  const agentType = parseProviderId(raw.agentType) ?? resolveDefaultProviderId()
  const model = raw.model === null
    ? null
    : (parseMessage(raw.model) ?? undefined)
  const skillsToUse = parseOptionalStringArray(raw.skillsToUse)
  if (permissionMode === null || skillsToUse === null) {
    return null
  }

  return {
    cwd,
    permissionMode: permissionMode ?? 'default',
    agentType,
    model: model ?? null,
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

export function parseOptionalEnabled(rawEnabled: unknown): boolean | undefined | null {
  if (rawEnabled === undefined) {
    return undefined
  }

  if (typeof rawEnabled !== 'boolean') {
    return null
  }

  return rawEnabled
}
