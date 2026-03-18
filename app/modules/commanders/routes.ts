import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import cron from 'node-cron'
import { Router, type Request } from 'express'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import type { CommanderSessionsInterface } from '../agents/routes.js'
import {
  resolveCommanderDataDir,
  resolveCommanderNamesPath,
  resolveCommanderPaths,
} from './paths.js'
import { CommanderAgent } from './agent.js'
import { CommanderManager, type CommanderSubagentLifecycleEvent } from './manager.js'
import {
  EmergencyFlusher,
  JournalWriter,
  MemoryMdWriter,
  MemoryRecollection,
  NightlyConsolidation,
  WorkingMemoryStore,
  type FlushContext,
  type JournalEntry,
} from './memory/index.js'
import type { GHIssue } from './memory/skill-matcher.js'
import {
  CommanderHeartbeatManager,
  createDefaultHeartbeatState,
  mergeHeartbeatState,
  parseHeartbeatPatch,
  type CommanderHeartbeatState,
} from './heartbeat.js'
import { HeartbeatLog, type HeartbeatLogAppendInput } from './heartbeat-log.js'
import {
  COMMANDER_WORKFLOW_FILE,
  loadCommanderWorkflow,
  type CommanderWorkflow,
} from './workflow.js'
import {
  buildFatHeartbeatMessage as appendHeartbeatChecklist,
  chooseHeartbeatMode,
  resolveFatPinInterval,
  THIN_HEARTBEAT_PROMPT,
} from './choose-heartbeat-mode.js'
import {
  CommanderSessionStore,
  type CommanderCurrentTask,
  type CommanderSession,
  type HeartbeatContextConfig,
  type CommanderTaskSource,
} from './store.js'
import {
  QuestStore,
  type QuestArtifact,
  type QuestArtifactType,
  type CommanderQuest,
  type CommanderQuestContract,
  type CommanderQuestSource,
  type CommanderQuestStatus,
} from './quest-store.js'
import { GhTasks } from './tools/gh-tasks.js'
import {
  CommandRoomTaskStore,
  defaultCommandRoomTaskStorePath,
  type CronTask as CommandRoomCronTask,
  type CreateCronTaskInput,
} from '../command-room/task-store.js'
import {
  CommandRoomRunStore,
  defaultCommandRoomRunStorePath,
  type WorkflowRun,
} from '../command-room/run-store.js'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/

// Serialize read-modify-write on names.json to prevent concurrent mutation races
let namesMutex: Promise<void> = Promise.resolve()
function withNamesLock(dataDir: string, fn: (names: Record<string, string>) => void): Promise<void> {
  const next = namesMutex.then(async () => {
    const namesPath = resolveCommanderNamesPath(dataDir)
    let names: Record<string, string> = {}
    try {
      names = JSON.parse(await readFile(namesPath, 'utf8')) as Record<string, string>
    } catch {
      // names.json may not exist yet
    }
    fn(names)
    await mkdir(path.dirname(namesPath), { recursive: true })
    await writeFile(namesPath, JSON.stringify(names, null, 2), 'utf8')
  })
  namesMutex = next.catch(() => {}) // keep chain alive on failure
  return next
}

const STARTUP_PROMPT = 'Commander runtime started. Acknowledge readiness and await instructions.'
const BASE_SYSTEM_PROMPT =
  'You are Commander, the orchestration agent for GitHub task execution. Follow repo instructions exactly.'
const COMMANDER_SESSION_NAME_PREFIX = 'commander-'
const DEFAULT_AGENTS_SESSION_STORE_PATH = 'data/agents/stream-sessions.json'
const COLLECT_MODE_DEBOUNCE_MS = 1_000

const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const CRON_TASK_ID_PATTERN = /^[a-z0-9-]+$/i
const QUEST_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const MACHINE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const ISO_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const QUEST_STATUSES = new Set<CommanderQuestStatus>(['pending', 'active', 'done', 'failed'])
const QUEST_SOURCES = new Set<CommanderQuestSource>(['manual', 'github-issue', 'idea', 'voice-log'])
const QUEST_ARTIFACT_TYPES = new Set<QuestArtifactType>(['github_issue', 'github_pr', 'url', 'file'])
const DEFAULT_CONTEXT_PRESSURE_INPUT_TOKEN_THRESHOLD = 150_000
const REMOTE_SYNC_SHARED_SECRET_ENV = 'COMMANDER_REMOTE_SYNC_SHARED_SECRET'
const SALIENCE_LEVELS = new Set<JournalEntry['salience']>(['SPIKE', 'NOTABLE', 'ROUTINE'])

type StreamEvent = Record<string, unknown>
type CommanderMessageMode = 'collect' | 'followup'

interface CommanderSubAgentEntry {
  sessionId: string
  dispatchedAt: string
  state: 'running' | 'completed' | 'failed'
  result?: string
}

interface ContextPressureBridge {
  onContextPressure(handler: () => Promise<void> | void): void
  trigger(): Promise<void>
}

interface CommanderRuntime {
  manager: CommanderManager
  agent: CommanderAgent
  baseSystemPrompt: string
  flusher: EmergencyFlusher
  workingMemory: WorkingMemoryStore
  contextPressureBridge: ContextPressureBridge
  lastTaskState: string
  heartbeatCount: number
  lastKnownInputTokens: number
  forceNextFatHeartbeat: boolean
  pendingSpikeObservations: string[]
  pendingCollect: string[]
  collectTimer: ReturnType<typeof setTimeout> | null
  subAgents: Map<string, CommanderSubAgentEntry>
  unsubscribeEvents?: () => void
}

type CommanderSessionResponse = Omit<CommanderSession, 'remoteOrigin'> & {
  remoteOrigin?: {
    machineId: string
    label: string
  }
}

export interface CommandersRouterOptions {
  sessionStore?: CommanderSessionStore
  sessionStorePath?: string
  questStore?: QuestStore
  questStoreDataDir?: string
  ghTasksFactory?: (repo: string) => Pick<GhTasks, 'readTask'>
  heartbeatLog?: HeartbeatLog
  fetchImpl?: typeof fetch
  sessionsInterface?: CommanderSessionsInterface
  commandRoomTaskStore?: CommandRoomTaskStore
  commandRoomRunStore?: CommandRoomRunStore
  commandRoomScheduler?: CommanderCronScheduler
  commandRoomSchedulerInitialized?: Promise<void>
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  memoryBasePath?: string
  heartbeatBasePath?: string
  contextPressureInputTokenThreshold?: number
  now?: () => Date
  githubToken?: string
  agentsSessionStorePath?: string
  remoteSyncSharedSecret?: string
}

export interface CommandersRouterResult {
  router: Router
}

interface GitHubIssueResponse {
  number: number
  title: string
  body?: string | null
  html_url: string
  state: string
  labels?: Array<{ name?: string }>
  pull_request?: unknown
}

interface GitHubIssueUrlParts {
  owner: string
  repo: string
  issueNumber: number
  normalizedUrl: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !SESSION_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

function toCommanderSessionName(commanderId: string): string {
  return `${COMMANDER_SESSION_NAME_PREFIX}${commanderId}`
}

function parsePersistedCommanderSessionNames(value: unknown): Set<string> {
  const parsed = new Set<string>()
  if (!isObject(value) || !Array.isArray(value.sessions)) {
    return parsed
  }

  for (const entry of value.sessions) {
    if (!isObject(entry)) {
      continue
    }
    const name = entry.name
    if (typeof name !== 'string' || !name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      continue
    }
    parsed.add(name)
  }

  return parsed
}

async function readPersistedCommanderSessionNames(
  sessionStorePath: string,
): Promise<Set<string>> {
  try {
    const raw = await readFile(sessionStorePath, 'utf8')
    return parsePersistedCommanderSessionNames(JSON.parse(raw) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set<string>()
    }
    throw error
  }
}

function parseHost(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed || !HOST_PATTERN.test(trimmed)) {
    return null
  }
  return trimmed
}

function parseMachineId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !MACHINE_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

function parseLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseTaskSource(raw: unknown): CommanderTaskSource | null {
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

function parseOptionalHeartbeatContextConfig(
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

function parseOptionalCurrentTask(
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

function parseMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseOptionalCommanderAgentType(
  raw: unknown,
): 'claude' | 'codex' | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined
  }
  if (raw === 'claude' || raw === 'codex') {
    return raw
  }
  return null
}

function resolveCommanderAgentType(
  session: Pick<CommanderSession, 'agentType'>,
): 'claude' | 'codex' {
  return session.agentType === 'codex' ? 'codex' : 'claude'
}

function parseIssueNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return null
  }
  return raw
}

function parseQuestId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  if (!trimmed || !QUEST_ID_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

function parseQuestStatus(raw: unknown): CommanderQuestStatus | null {
  if (typeof raw !== 'string') {
    return null
  }
  return QUEST_STATUSES.has(raw as CommanderQuestStatus)
    ? (raw as CommanderQuestStatus)
    : null
}

function parseQuestSource(raw: unknown): CommanderQuestSource | null {
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

function parseQuestArtifacts(raw: unknown): QuestArtifact[] | null {
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

function parseQuestContract(raw: unknown): CommanderQuestContract | null {
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

function parseGitHubIssueUrl(raw: unknown): GitHubIssueUrlParts | null {
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

function buildQuestInstructionFromGitHubIssue(issue: { title: string; body: string }): string {
  const title = issue.title.trim()
  const body = issue.body.trim()
  if (title && body) {
    return `${title}\n\n${body}`
  }
  return title || body || 'Review and execute the linked GitHub issue.'
}

function summarizeQuestInstruction(instruction: string): string {
  const firstLine = instruction.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return firstLine ?? instruction
}

function prependPendingQuestsToMessage(
  message: string,
  pendingQuests: CommanderQuest[],
): string {
  if (pendingQuests.length === 0) {
    return message
  }

  return [
    '[QUEST BOARD] Top pending quests:',
    ...pendingQuests.slice(0, 3).map((quest, index) => `${index + 1}. ${summarizeQuestInstruction(quest.instruction)}`),
    '',
    message,
  ].join('\n')
}

function parseOptionalStringArray(raw: unknown): string[] | null {
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

function parseMessageMode(raw: unknown): CommanderMessageMode | null {
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

function parseIsoDateKey(raw: unknown): string | null {
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

function parseBearerToken(req: Request): string | null {
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

function parseJournalEntries(raw: unknown): JournalEntry[] | null {
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

function parseStringMap(raw: unknown): Record<string, string> | null {
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

function resolveSafeRelativePath(root: string, relativePath: string): string | null {
  const trimmed = relativePath.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.startsWith('/')) {
    return null
  }

  const normalized = path.posix.normalize(trimmed)
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null
  }

  const resolved = path.resolve(root, normalized)
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  if (!resolved.startsWith(rootPrefix)) {
    return null
  }

  return resolved
}

function extractLatestIsoTimestamp(content: string): string | null {
  const matches = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)
  if (!matches || matches.length === 0) {
    return null
  }
  return matches[matches.length - 1] ?? null
}

function estimateTokenCount(content: string): number {
  const normalized = content.trim()
  if (!normalized) {
    return 0
  }
  return normalized.split(/\s+/).length
}

function shouldReplaceMemoryMd(current: string, incoming: string): boolean {
  const incomingTrimmed = incoming.trim()
  if (!incomingTrimmed) {
    return false
  }

  const currentTs = extractLatestIsoTimestamp(current)
  const incomingTs = extractLatestIsoTimestamp(incomingTrimmed)
  if (incomingTs && currentTs) {
    return incomingTs > currentTs
  }
  if (incomingTs && !currentTs) {
    return true
  }

  return estimateTokenCount(incomingTrimmed) > estimateTokenCount(current)
}

async function readSnapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}

  const walk = async (relativeDir: string): Promise<void> => {
    const absoluteDir = relativeDir.length > 0
      ? path.join(root, relativeDir)
      : root

    let entries: Dirent[]
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const nextRelative = relativeDir.length > 0
        ? path.join(relativeDir, entry.name)
        : entry.name
      if (entry.isDirectory()) {
        await walk(nextRelative)
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      const absoluteFilePath = path.join(root, nextRelative)
      const fileContent = await readFile(absoluteFilePath, 'utf8')
      files[nextRelative.split(path.sep).join('/')] = fileContent
    }
  }

  await walk('')
  return files
}

function parsePositiveInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }

  return parsed
}

type CommanderWorkflowSource = 'commander-data-dir' | 'workspace-cwd'

interface ResolvedCommanderWorkflow {
  workflow: CommanderWorkflow | null
  source: CommanderWorkflowSource | null
  sourcePath: string | null
}

// heartbeat.interval in COMMANDER.md must be a positive integer (milliseconds).
// Cron expressions are not supported because the heartbeat system uses setInterval, not cron scheduling.
function resolveWorkflowHeartbeatIntervalMs(rawInterval: string | undefined): number | undefined {
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

async function resolveCommanderWorkflow(
  commanderId: string,
  cwd: string | undefined,
  memoryBasePath?: string,
): Promise<ResolvedCommanderWorkflow> {
  // Prompt/workflow source precedence is explicit: per-commander data-dir COMMANDER.md
  // is authoritative; workspace cwd COMMANDER.md is a backward-compatibility fallback.
  const commanderRoot = resolveCommanderPaths(commanderId, memoryBasePath).commanderRoot
  const commanderWorkflow = await loadCommanderWorkflow(commanderRoot)
  if (commanderWorkflow) {
    return {
      workflow: commanderWorkflow,
      source: 'commander-data-dir',
      sourcePath: path.join(commanderRoot, COMMANDER_WORKFLOW_FILE),
    }
  }

  if (cwd) {
    const workspaceWorkflow = await loadCommanderWorkflow(cwd)
    if (workspaceWorkflow) {
      return {
        workflow: workspaceWorkflow,
        source: 'workspace-cwd',
        sourcePath: path.join(cwd, COMMANDER_WORKFLOW_FILE),
      }
    }
  }

  return {
    workflow: null,
    source: null,
    sourcePath: null,
  }
}

function resolveEffectiveBasePrompt(workflow: CommanderWorkflow | null): string {
  return workflow?.systemPromptTemplate?.trim().length
    ? workflow.systemPromptTemplate
    : BASE_SYSTEM_PROMPT
}

function resolveEffectiveHeartbeat(
  heartbeat: CommanderHeartbeatState,
  workflow: CommanderWorkflow | null,
): CommanderHeartbeatState {
  const workflowHeartbeatIntervalMs = resolveWorkflowHeartbeatIntervalMs(
    workflow?.heartbeatInterval,
  )
  return {
    ...heartbeat,
    ...(workflowHeartbeatIntervalMs !== undefined
      ? { intervalMs: workflowHeartbeatIntervalMs }
      : {}),
    ...(workflow?.heartbeatMessage !== undefined
      ? { messageTemplate: workflow.heartbeatMessage }
      : {}),
  }
}

function warnInvalidWorkflowHeartbeatInterval(
  commanderId: string,
  resolvedWorkflow: ResolvedCommanderWorkflow,
): void {
  const rawHeartbeatInterval = resolvedWorkflow.workflow?.heartbeatInterval
  if (rawHeartbeatInterval === undefined) {
    return
  }

  if (resolveWorkflowHeartbeatIntervalMs(rawHeartbeatInterval) !== undefined) {
    return
  }

  const sourceLabel = resolvedWorkflow.sourcePath ?? 'COMMANDER.md'
  console.warn(
    `[commanders] Invalid ${sourceLabel} heartbeat.interval "${rawHeartbeatInterval}" for "${commanderId}" (must be a positive integer milliseconds value); using stored interval.`,
  )
}

function isLegacyContextPressureEvent(event: StreamEvent): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  const subtype = typeof event.subtype === 'string' ? event.subtype : ''
  return type === 'context_pressure' || subtype === 'context_pressure'
}

function parseContextPressureInputTokenThreshold(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CONTEXT_PRESSURE_INPUT_TOKEN_THRESHOLD
  }
  return Math.floor(raw)
}

function isUsageBearingContextPressureEvent(event: StreamEvent): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  return type === 'message_delta' || type === 'result'
}

function isInputTokenContextPressureEvent(
  event: StreamEvent,
  sessionInputTokens: number,
  threshold: number,
): boolean {
  if (!isUsageBearingContextPressureEvent(event)) {
    return false
  }
  return Number.isFinite(sessionInputTokens) && sessionInputTokens >= threshold
}

function toPromptIssue(session: CommanderSession): GHIssue | null {
  if (!session.currentTask || !session.taskSource) {
    return null
  }

  const labels = session.taskSource.label ? [{ name: session.taskSource.label }] : undefined
  return {
    number: session.currentTask.issueNumber,
    title: `Issue #${session.currentTask.issueNumber}`,
    body: '',
    labels,
    owner: session.taskSource.owner,
    repo: session.taskSource.repo,
    repository: `${session.taskSource.owner}/${session.taskSource.repo}`,
  }
}

function buildFlushContext(
  session: CommanderSession,
  runtime: CommanderRuntime,
): Omit<FlushContext, 'trigger'> {
  const repo = toSessionRepo(session) ?? ''
  return {
    currentIssue: session.currentTask
      ? {
          number: session.currentTask.issueNumber,
          repo,
          url: session.currentTask.issueUrl,
          title: `Issue #${session.currentTask.issueNumber}`,
        }
      : null,
    taskState: runtime.lastTaskState || 'Commander running',
    pendingSpikeObservations: [...runtime.pendingSpikeObservations],
  }
}

function toSessionRepo(session: CommanderSession | null | undefined): string | null {
  if (!session?.taskSource) return null
  const owner = session.taskSource.owner?.trim()
  const repo = session.taskSource.repo?.trim()
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

function extractHypothesisFromMessage(message: string): string | null {
  const lower = message.toLowerCase()
  const marker = 'hypothesis:'
  const idx = lower.indexOf(marker)
  if (idx === -1) return null
  const raw = message.slice(idx + marker.length).split('\n')[0]?.trim() ?? ''
  return raw.length > 0 ? raw : null
}

function extractFileMentionsFromMessage(message: string): string[] {
  const matches = message.match(/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}/g) ?? []
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const normalized = match.replace(/^\.\/+/, '').trim()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
    if (deduped.length >= 12) break
  }
  return deduped
}

function normalizeHeartbeatSummary(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<timestamp>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\d{2}:\d{2}:\d{2}/g, '<time>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

function listSubAgentEntries(runtime: CommanderRuntime | undefined): CommanderSubAgentEntry[] {
  if (!runtime) {
    return []
  }
  return [...runtime.subAgents.values()]
    .sort((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
}

function consumeCompletedSubAgentEntries(runtime: CommanderRuntime): CommanderSubAgentEntry[] {
  const completed: CommanderSubAgentEntry[] = []
  for (const [sessionId, entry] of runtime.subAgents.entries()) {
    if (entry.state !== 'completed') {
      continue
    }
    completed.push(entry)
    runtime.subAgents.delete(sessionId)
  }
  completed.sort((left, right) => left.dispatchedAt.localeCompare(right.dispatchedAt))
  return completed
}

function appendSubAgentResultsToHeartbeat(
  message: string,
  completedEntries: CommanderSubAgentEntry[],
): string {
  if (completedEntries.length === 0) {
    return message
  }

  return [
    message,
    '',
    '[SUB-AGENT RESULTS]',
    ...completedEntries.map((entry, index) => {
      const summary = entry.result?.trim() || 'No sub-agent summary provided.'
      return `${index + 1}. ${entry.sessionId}: ${summary}`
    }),
  ].join('\n')
}

function toHeartbeatLogTaskSnapshot(session: CommanderSession | null): {
  questCount: number
  claimedQuestId?: string
  claimedQuestInstruction?: string
} {
  const claimedTask = session?.currentTask
  if (!claimedTask) {
    return { questCount: 0 }
  }

  return {
    questCount: 1,
    claimedQuestId: String(claimedTask.issueNumber),
    claimedQuestInstruction: `Issue #${claimedTask.issueNumber}`,
  }
}

function toCommanderSessionResponse(
  session: CommanderSession,
  runtime?: CommanderRuntime | undefined,
): CommanderSessionResponse & {
  contextConfig: { fatPinInterval: number }
  runtime: { heartbeatCount: number }
} {
  const normalizedAgentType = resolveCommanderAgentType(session)
  const base: CommanderSessionResponse = session.remoteOrigin
    ? {
        ...session,
        agentType: normalizedAgentType,
        remoteOrigin: {
          machineId: session.remoteOrigin.machineId,
          label: session.remoteOrigin.label,
        },
      }
    : {
        ...session,
        agentType: normalizedAgentType,
      }

  return {
    ...base,
    contextConfig: {
      fatPinInterval: resolveFatPinInterval(session.contextConfig?.fatPinInterval),
    },
    runtime: {
      heartbeatCount: runtime?.heartbeatCount ?? session.heartbeatTickCount ?? 0,
    },
  }
}

function parseRepoFullName(repo: string): { owner: string; name: string } | null {
  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    return null
  }
  return { owner, name }
}

function resolveGitHubToken(explicit?: string): string | null {
  const token = explicit ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token || !token.trim()) {
    return null
  }
  return token.trim()
}

function buildGitHubHeaders(token: string | null): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hammurabi-commanders',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function readGitHubError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string }
    if (payload?.message && payload.message.trim()) {
      return payload.message
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || 'GitHub API request failed'
}

function createContextPressureBridge(): ContextPressureBridge {
  const handlers = new Set<() => Promise<void> | void>()
  return {
    onContextPressure(handler: () => Promise<void> | void): void {
      handlers.add(handler)
    },
    async trigger(): Promise<void> {
      for (const handler of handlers) {
        await handler()
      }
    },
  }
}

function parseCommanderId(rawCommanderId: unknown): string | null {
  if (typeof rawCommanderId !== 'string') {
    return null
  }

  const commanderId = rawCommanderId.trim()
  if (!COMMANDER_ID_PATTERN.test(commanderId)) {
    return null
  }

  return commanderId
}

function parseCronTaskId(rawCronTaskId: unknown): string | null {
  if (typeof rawCronTaskId !== 'string') {
    return null
  }

  const cronTaskId = rawCronTaskId.trim()
  if (!CRON_TASK_ID_PATTERN.test(cronTaskId)) {
    return null
  }

  return cronTaskId
}

function parseSchedule(rawSchedule: unknown): string | null {
  if (typeof rawSchedule !== 'string') {
    return null
  }

  const schedule = rawSchedule.trim()
  if (schedule.length === 0) {
    return null
  }

  return schedule
}

function parseCronInstruction(rawInstruction: unknown): string | null {
  if (typeof rawInstruction !== 'string') {
    return null
  }

  const instruction = rawInstruction.trim()
  if (instruction.length === 0) {
    return null
  }

  return instruction
}

function parseOptionalEnabled(rawEnabled: unknown): boolean | undefined | null {
  if (rawEnabled === undefined) {
    return undefined
  }

  if (typeof rawEnabled !== 'boolean') {
    return null
  }

  return rawEnabled
}

function parseTriggerInstruction(payload: unknown): string | null {
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

function toCommanderCronTask(
  task: CommandRoomCronTask,
  fallbackCommanderId: string,
  lastRunAt: string | null = null,
): {
  id: string
  commanderId: string
  schedule: string
  instruction: string
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  agentType: 'claude' | 'codex'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
} {
  return {
    id: task.id,
    commanderId: task.commanderId ?? fallbackCommanderId,
    schedule: task.schedule,
    instruction: task.instruction,
    enabled: task.enabled,
    lastRun: lastRunAt,
    nextRun: null,
    agentType: task.agentType,
    ...(task.sessionType ? { sessionType: task.sessionType } : {}),
    ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}),
    ...(task.workDir ? { workDir: task.workDir } : {}),
    ...(task.machine ? { machine: task.machine } : {}),
  }
}

interface CommanderCronStores {
  taskStore: CommandRoomTaskStore
  runStore: CommandRoomRunStore
}

interface CommanderCronScheduler {
  createTask(input: CreateCronTaskInput): Promise<CommandRoomCronTask>
  updateTask(
    taskId: string,
    update: {
      schedule?: string
      instruction?: string
      enabled?: boolean
    },
  ): Promise<CommandRoomCronTask | null>
  deleteTask(taskId: string): Promise<boolean>
}

interface CommanderCronTaskRecord {
  task: CommandRoomCronTask
  stores: CommanderCronStores
}

function pickLatestWorkflowRun(
  runs: Array<WorkflowRun | null | undefined>,
): WorkflowRun | null {
  let latest: WorkflowRun | null = null
  for (const run of runs) {
    if (!run) {
      continue
    }
    if (!latest) {
      latest = run
      continue
    }
    const latestTimestamp = latest.completedAt ?? latest.startedAt
    const candidateTimestamp = run.completedAt ?? run.startedAt
    if (
      candidateTimestamp > latestTimestamp ||
      (candidateTimestamp === latestTimestamp && run.startedAt > latest.startedAt)
    ) {
      latest = run
    }
  }
  return latest
}

function resolveCommanderCronStorePaths(
  commanderId: string,
  basePath?: string,
): {
  tasksPath: string
  runsPath: string
} {
  const commanderPaths = resolveCommanderPaths(commanderId, basePath)
  const cronRoot = path.join(commanderPaths.memoryRoot, 'cron')
  return {
    tasksPath: path.join(cronRoot, 'tasks.json'),
    runsPath: path.join(cronRoot, 'runs.json'),
  }
}

export function createCommandersRouter(
  options: CommandersRouterOptions = {},
): CommandersRouterResult {
  const router = Router()
  const commanderDataDir = options.sessionStorePath
    ? path.dirname(path.resolve(options.sessionStorePath))
    : resolveCommanderDataDir()
  const now = options.now ?? (() => new Date())
  const contextPressureInputTokenThreshold = parseContextPressureInputTokenThreshold(
    options.contextPressureInputTokenThreshold,
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const githubToken = resolveGitHubToken(options.githubToken)
  const sessionStore = options.sessionStore ?? new CommanderSessionStore(options.sessionStorePath)
  const questStore = options.questStore ?? (
    options.questStoreDataDir
      ? new QuestStore(options.questStoreDataDir)
      : options.sessionStorePath
        ? new QuestStore(path.dirname(path.resolve(options.sessionStorePath)))
        : new QuestStore()
  )
  const ghTasksFactory = options.ghTasksFactory ?? ((repo: string) => new GhTasks({ repo }))
  const sharedCommanderCronStores: CommanderCronStores | null = (
    options.commandRoomTaskStore || options.commandRoomRunStore
  )
    ? {
      taskStore: options.commandRoomTaskStore ?? new CommandRoomTaskStore(),
      runStore: options.commandRoomRunStore ?? new CommandRoomRunStore(),
    }
    : null
  const legacyCommanderCronStores: CommanderCronStores | null = sharedCommanderCronStores
    ? null
    : {
      taskStore: new CommandRoomTaskStore(defaultCommandRoomTaskStorePath()),
      runStore: new CommandRoomRunStore({
        filePath: defaultCommandRoomRunStorePath(),
        commanderDataDir: options.memoryBasePath,
      }),
    }
  const commandRoomScheduler = options.commandRoomScheduler
  const commandRoomSchedulerInitialized = commandRoomScheduler
    ? (options.commandRoomSchedulerInitialized ?? Promise.resolve())
    : Promise.resolve()
  const commanderCronStoresById = new Map<string, CommanderCronStores>()
  const getCommanderCronStores = (commanderId: string): CommanderCronStores => {
    if (sharedCommanderCronStores) {
      return sharedCommanderCronStores
    }
    const existing = commanderCronStoresById.get(commanderId)
    if (existing) {
      return existing
    }
    const paths = resolveCommanderCronStorePaths(commanderId, options.memoryBasePath)
    const created: CommanderCronStores = {
      taskStore: new CommandRoomTaskStore(paths.tasksPath),
      runStore: new CommandRoomRunStore(paths.runsPath),
    }
    commanderCronStoresById.set(commanderId, created)
    return created
  }
  const listCommanderCronRunStores = (commanderId: string): CommandRoomRunStore[] => {
    const runStores = [getCommanderCronStores(commanderId).runStore]
    if (legacyCommanderCronStores && !runStores.includes(legacyCommanderCronStores.runStore)) {
      runStores.push(legacyCommanderCronStores.runStore)
    }
    return runStores
  }
  const listCommanderCronTaskStores = (commanderId: string): CommandRoomTaskStore[] => {
    const taskStores = [getCommanderCronStores(commanderId).taskStore]
    if (legacyCommanderCronStores && !taskStores.includes(legacyCommanderCronStores.taskStore)) {
      taskStores.push(legacyCommanderCronStores.taskStore)
    }
    return taskStores
  }
  const listCommanderCronTasksWithStores = async (
    commanderId: string,
  ): Promise<CommanderCronTaskRecord[]> => {
    const primaryStores = getCommanderCronStores(commanderId)
    const tasksById = new Map<string, CommanderCronTaskRecord>()

    const primaryTasks = await primaryStores.taskStore.listTasks({ commanderId })
    for (const task of primaryTasks) {
      tasksById.set(task.id, { task, stores: primaryStores })
    }

    if (legacyCommanderCronStores) {
      const legacyTasks = await legacyCommanderCronStores.taskStore.listTasks({ commanderId })
      for (const task of legacyTasks) {
        if (!tasksById.has(task.id)) {
          tasksById.set(task.id, { task, stores: legacyCommanderCronStores })
        }
      }
    }

    return [...tasksById.values()]
  }
  const findCommanderCronTaskWithStores = async (
    commanderId: string,
    taskId: string,
  ): Promise<CommanderCronTaskRecord | null> => {
    const primaryStores = getCommanderCronStores(commanderId)
    const primaryTask = await primaryStores.taskStore.getTask(taskId)
    if (primaryTask?.commanderId === commanderId) {
      return {
        task: primaryTask,
        stores: primaryStores,
      }
    }

    if (legacyCommanderCronStores) {
      const legacyTask = await legacyCommanderCronStores.taskStore.getTask(taskId)
      if (legacyTask?.commanderId === commanderId) {
        return {
          task: legacyTask,
          stores: legacyCommanderCronStores,
        }
      }
    }

    return null
  }
  const heartbeatDataDir = parseMessage(options.heartbeatBasePath) ?? parseMessage(options.memoryBasePath)
  const heartbeatLog = options.heartbeatLog ?? new HeartbeatLog(
    heartbeatDataDir ? { dataDir: heartbeatDataDir } : undefined,
  )
  const sessionsInterface = options.sessionsInterface
  const agentsSessionStorePath = path.resolve(
    options.agentsSessionStorePath ?? DEFAULT_AGENTS_SESSION_STORE_PATH,
  )
  const runtimes = new Map<string, CommanderRuntime>()
  const ACTIVE_COMMANDER_SESSIONS = new Map<string, { sessionName: string; startedAt: string }>()
  const heartbeatFiredAtByCommander = new Map<string, string>()

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  const onSubagentLifecycleEvent = (
    commanderId: string,
    event: CommanderSubagentLifecycleEvent,
  ): void => {
    const runtime = runtimes.get(commanderId)
    if (!runtime) {
      return
    }

    const existing = runtime.subAgents.get(event.sessionId)
    runtime.subAgents.set(event.sessionId, {
      sessionId: event.sessionId,
      dispatchedAt: existing?.dispatchedAt ?? event.dispatchedAt,
      state: event.state,
      result: event.result?.trim() || existing?.result,
    })
  }

  const scheduleCollectSend = (commanderId: string, runtime: CommanderRuntime): void => {
    if (runtime.collectTimer) {
      clearTimeout(runtime.collectTimer)
    }

    runtime.collectTimer = setTimeout(() => {
      void (async () => {
        runtime.collectTimer = null
        const merged = runtime.pendingCollect.splice(0).join('\n\n').trim()
        if (!merged || !sessionsInterface) {
          return
        }

        if (runtimes.get(commanderId) !== runtime) {
          return
        }

        const sessionName = ACTIVE_COMMANDER_SESSIONS.get(commanderId)?.sessionName
          ?? toCommanderSessionName(commanderId)
        const sent = await sessionsInterface.sendToSession(sessionName, merged)
        if (!sent) {
          console.warn(`[commanders] Collect mode send failed for "${commanderId}" (session unavailable).`)
        }
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[commanders] Collect mode send failed for "${commanderId}": ${message}`)
      })
    }, COLLECT_MODE_DEBOUNCE_MS)
  }

  const remoteSyncSharedSecret = parseMessage(
    options.remoteSyncSharedSecret ?? process.env[REMOTE_SYNC_SHARED_SECRET_ENV],
  )

  const authorizeRemoteSync = (
    req: Request,
    session: CommanderSession,
  ): { ok: true } | { ok: false; status: number; error: string } => {
    const bearerToken = parseBearerToken(req)
    if (!bearerToken) {
      return {
        ok: false,
        status: 401,
        error: 'Bearer token is required',
      }
    }

    if (remoteSyncSharedSecret && bearerToken === remoteSyncSharedSecret) {
      return { ok: true }
    }

    if (session.remoteOrigin?.syncToken && bearerToken === session.remoteOrigin.syncToken) {
      return { ok: true }
    }

    return {
      ok: false,
      status: 403,
      error: 'Invalid sync token',
    }
  }

  const heartbeatManager = new CommanderHeartbeatManager({
    now,
    preCompactionFlush: sessionsInterface
      ? {
            getConversationEntryCount(commanderId: string): number | null {
              const active = ACTIVE_COMMANDER_SESSIONS.get(commanderId)
              if (!active) return null
              const session = sessionsInterface.getSession(active.sessionName)
              return session?.conversationEntryCount ?? null
            },
            async sendFlushMessage(commanderId: string, message: string): Promise<boolean> {
              const active = ACTIVE_COMMANDER_SESSIONS.get(commanderId)
              if (!active) return false
              return sessionsInterface.sendToSession(active.sessionName, message)
            },
          }
      : undefined,
    sendHeartbeat: async ({ commanderId, renderedMessage, timestamp }) => {
      const appendHeartbeatLog = async (
        input: HeartbeatLogAppendInput,
        context: string,
      ): Promise<void> => {
        try {
          await heartbeatLog.append(commanderId, input)
        } catch (appendError) {
          console.error(
            `[commanders] Failed to append heartbeat log (${context}) for "${commanderId}":`,
            appendError,
          )
        }
      }

      heartbeatFiredAtByCommander.set(commanderId, timestamp)
      const session = await sessionStore.get(commanderId)
      if (!session || session.state !== 'running') {
        if (session) {
          await appendHeartbeatLog(
            {
              firedAt: timestamp,
              ...toHeartbeatLogTaskSnapshot(session),
              outcome: 'error',
              errorMessage: 'Commander session was not running when heartbeat fired',
            },
            'session-not-running',
          )
        }
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      const activeSession = ACTIVE_COMMANDER_SESSIONS.get(commanderId)
      if (!activeSession) {
        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'Commander session inactive when heartbeat fired',
          },
          'session-inactive',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      if (!sessionsInterface) {
        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'sessionsInterface not configured',
          },
          'no-sessions-interface',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      const runtime = runtimes.get(commanderId)
      const activeAgentSession = sessionsInterface.getSession(activeSession.sessionName)
      let heartbeatMessage: string
      const buildFatHeartbeatMessage = async (
        baseSystemPrompt: string,
        agent: CommanderAgent,
        completedSubAgentEntries: CommanderSubAgentEntry[],
      ): Promise<string> => {
        const pendingQuests = await questStore.listPending(commanderId, 3)
        const heartbeatInstruction = prependPendingQuestsToMessage(renderedMessage, pendingQuests)
        const heartbeatWithSubagents = appendSubAgentResultsToHeartbeat(
          heartbeatInstruction,
          completedSubAgentEntries,
        )
        const built = await agent.buildTaskPickupSystemPrompt(
          baseSystemPrompt,
          {
            currentTask: toPromptIssue(session),
            recentConversation: [],
          },
        )
        return `${built.systemPrompt}\n\n${heartbeatWithSubagents}`
      }

      // After server restart reconciliation we may have an active stream session
      // without a rebuilt in-process runtime object. Heartbeats still run via
      // ACTIVE_COMMANDER_SESSIONS to avoid orphaning survived sessions.
      if (runtime) {
        const heartbeatMode = chooseHeartbeatMode(runtime, session, activeAgentSession)

        if (heartbeatMode === 'fat') {
          const workflow = await resolveCommanderWorkflow(
            commanderId,
            session.cwd,
            options.memoryBasePath,
          )
          runtime.baseSystemPrompt = resolveEffectiveBasePrompt(workflow.workflow)
          const completedSubAgentEntries = consumeCompletedSubAgentEntries(runtime)
          heartbeatMessage = await buildFatHeartbeatMessage(
            runtime.baseSystemPrompt,
            runtime.agent,
            completedSubAgentEntries,
          )
          const enriched = await appendHeartbeatChecklist(
            heartbeatMessage,
            commanderId,
            options.memoryBasePath,
          )
          if (enriched) heartbeatMessage = enriched
        } else {
          heartbeatMessage = THIN_HEARTBEAT_PROMPT
        }

        runtime.heartbeatCount += 1
        runtime.forceNextFatHeartbeat = false
        runtime.lastTaskState = heartbeatMessage
        runtime.pendingSpikeObservations = []
        void runtime.workingMemory.update({
          source: 'heartbeat',
          summary: normalizeHeartbeatSummary(heartbeatMessage),
          issueNumber: session.currentTask?.issueNumber ?? null,
          repo: toSessionRepo(session),
          tags: ['heartbeat'],
        }).catch((error) => {
          console.error(`[commanders] Failed to update working memory on heartbeat for "${commanderId}":`, error)
        })
      } else {
        const heartbeatMode = chooseHeartbeatMode(
          {
            heartbeatCount: session.heartbeatTickCount ?? 0,
            forceNextFatHeartbeat: false,
          },
          session,
          activeAgentSession,
        )

        if (heartbeatMode === 'fat') {
          const workflow = await resolveCommanderWorkflow(
            commanderId,
            session.cwd,
            options.memoryBasePath,
          )
          const baseSystemPrompt = resolveEffectiveBasePrompt(workflow.workflow)
          const fallbackAgent = new CommanderAgent(commanderId, options.memoryBasePath)
          heartbeatMessage = await buildFatHeartbeatMessage(baseSystemPrompt, fallbackAgent, [])
          const enriched = await appendHeartbeatChecklist(
            heartbeatMessage,
            commanderId,
            options.memoryBasePath,
          )
          if (enriched) heartbeatMessage = enriched
        } else {
          heartbeatMessage = THIN_HEARTBEAT_PROMPT
        }
      }

      const sent = await sessionsInterface.sendToSession(activeSession.sessionName, heartbeatMessage)
      if (!sent) {
        await appendHeartbeatLog(
          {
            firedAt: timestamp,
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage: 'stream session unavailable',
          },
          'session-unavailable',
        )
        heartbeatFiredAtByCommander.delete(commanderId)
        return false
      }

      const taskSnapshot = toHeartbeatLogTaskSnapshot(session)
      const outcome = taskSnapshot.questCount > 0 ? 'ok' : 'no-quests'
      await appendHeartbeatLog(
        {
          firedAt: timestamp,
          ...taskSnapshot,
          outcome,
        },
        'heartbeat-success',
      )
      return true
    },
    onHeartbeatSent: async ({ commanderId, timestamp }) => {
      await sessionStore.updateLastHeartbeat(commanderId, timestamp)
    },
    onHeartbeatError: ({ commanderId, error }) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      void (async () => {
        const session = await sessionStore.get(commanderId)
        try {
          await heartbeatLog.append(commanderId, {
            firedAt: heartbeatFiredAtByCommander.get(commanderId) ?? now().toISOString(),
            ...toHeartbeatLogTaskSnapshot(session),
            outcome: 'error',
            errorMessage,
          })
        } catch (appendError) {
          console.error(
            `[commanders] Failed to append heartbeat error log for "${commanderId}":`,
            appendError,
          )
        }
      })()
        .catch((appendError) => {
          console.error(
            `[commanders] Failed to append heartbeat error log for "${commanderId}":`,
            appendError,
          )
        })
    },
  })

  async function reconcileCommanderSessions(): Promise<void> {
    if (!sessionsInterface) {
      return
    }

    const persistedCommanderSessions = await readPersistedCommanderSessionNames(agentsSessionStorePath)
    const allCommanders = await sessionStore.list()
    const runningCommanders = allCommanders.filter((session) => session.state === 'running')
    for (const commander of runningCommanders) {
      const sessionName = toCommanderSessionName(commander.id)
      const liveSession = persistedCommanderSessions.has(sessionName)
        ? sessionsInterface.getSession(sessionName)
        : undefined
      if (liveSession) {
        const workflow = await resolveCommanderWorkflow(
          commander.id,
          commander.cwd,
          options.memoryBasePath,
        )
        warnInvalidWorkflowHeartbeatInterval(commander.id, workflow)
        const effectiveHeartbeat = resolveEffectiveHeartbeat(commander.heartbeat, workflow.workflow)
        ACTIVE_COMMANDER_SESSIONS.set(commander.id, {
          sessionName,
          startedAt: liveSession.createdAt ?? commander.created,
        })
        heartbeatManager.start(commander.id, effectiveHeartbeat)
        continue
      }

      await sessionStore.update(commander.id, (current) => ({
        ...current,
        state: 'idle',
      }))
    }
  }

  router.get('/', requireReadAccess, async (_req, res) => {
    const sessions = await sessionStore.list()
    res.json(sessions.map((session) => toCommanderSessionResponse(session)))
  })

  router.get('/:id', requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const runtime = runtimes.get(commanderId)
    res.json({
      ...toCommanderSessionResponse(session, runtime),
      subAgents: listSubAgentEntries(runtime),
    })
  })

  router.get('/:id/heartbeat-log', requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const entries = (await heartbeatLog.read(commanderId, 50))
      .slice()
      .sort((left, right) => right.firedAt.localeCompare(left.firedAt))
    res.json({ entries })
  })

  router.post('/remote/register', requireWriteAccess, async (req, res) => {
    const machineId = parseMachineId(req.body?.machineId)
    const label = parseLabel(req.body?.label)
    if (!machineId || !label) {
      res.status(400).json({ error: 'machineId and label are required' })
      return
    }

    const displayName = parseMessage(req.body?.displayName) ?? label
    const requestedCommanderId = req.body?.commanderId
    if (requestedCommanderId !== undefined && requestedCommanderId !== null) {
      const commanderId = parseSessionId(requestedCommanderId)
      if (!commanderId) {
        res.status(400).json({ error: 'commanderId is invalid' })
        return
      }

      const session = await sessionStore.get(commanderId)
      if (!session) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      const syncToken = randomUUID()
      const updated = await sessionStore.update(commanderId, (current) => ({
        ...current,
        remoteOrigin: {
          machineId,
          label,
          syncToken,
        },
      }))
      if (!updated) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      res.json({ commanderId: updated.id, syncToken })
      return
    }

    const syncToken = randomUUID()
    const session: CommanderSession = {
      id: randomUUID(),
      host: label,
      pid: null,
      state: 'idle',
      created: now().toISOString(),
      agentType: 'claude',
      heartbeat: createDefaultHeartbeatState(),
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
      remoteOrigin: {
        machineId,
        label,
        syncToken,
      },
    }

    try {
      const created = await sessionStore.create(session)
      await withNamesLock(commanderDataDir, (names) => { names[created.id] = displayName })
      res.status(201).json({ commanderId: created.id, syncToken })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to register remote commander',
      })
    }
  })

  router.post('/', requireWriteAccess, async (req, res) => {
    const host = parseHost(req.body?.host)
    if (!host) {
      res.status(400).json({ error: 'Invalid host' })
      return
    }

    const taskSource = req.body?.taskSource != null
      ? parseTaskSource(req.body.taskSource)
      : null
    if (req.body?.taskSource != null && !taskSource) {
      res.status(400).json({ error: 'Invalid taskSource' })
      return
    }

    const parsedContextConfig = parseOptionalHeartbeatContextConfig(req.body?.contextConfig)
    if (!parsedContextConfig.valid) {
      res.status(400).json({ error: 'Invalid contextConfig' })
      return
    }

    const existing = await sessionStore.list()
    if (existing.some((session) => session.host === host)) {
      res.status(409).json({ error: `Commander for host "${host}" already exists` })
      return
    }

    const displayName = parseMessage(req.body?.displayName) ?? host
    const cwd = parseMessage(req.body?.cwd) ?? undefined
    const avatarSeed = parseMessage(req.body?.avatarSeed) ?? undefined
    const persona = parseMessage(req.body?.persona) ?? undefined
    const defaultHeartbeat = createDefaultHeartbeatState()
    let heartbeat = defaultHeartbeat

    if (req.body?.heartbeat !== undefined) {
      const parsedHeartbeat = parseHeartbeatPatch(req.body.heartbeat)
      if (!parsedHeartbeat.ok) {
        res.status(400).json({ error: parsedHeartbeat.error })
        return
      }
      heartbeat = mergeHeartbeatState(defaultHeartbeat, parsedHeartbeat.value)
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      avatarSeed,
      persona,
      pid: null,
      state: 'idle',
      created: now().toISOString(),
      agentType: 'claude',
      heartbeat,
      lastHeartbeat: null,
      heartbeatTickCount: 0,
      contextConfig: parsedContextConfig.value,
      taskSource,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
      cwd,
    }

    try {
      const created = await sessionStore.create(session)
      await withNamesLock(commanderDataDir, (names) => { names[created.id] = displayName })
      res.status(201).json(created)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create commander session',
      })
    }
  })

  router.post('/:id/start', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }
    if (session.state === 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is already running` })
      return
    }

    const parsedCurrentTask = parseOptionalCurrentTask(req.body?.currentTask, now().toISOString())
    if (!parsedCurrentTask.valid) {
      res.status(400).json({ error: 'Invalid currentTask payload' })
      return
    }
    const parsedAgentType = parseOptionalCommanderAgentType(req.body?.agentType)
    if (parsedAgentType === null) {
      res.status(400).json({ error: 'agentType must be either "claude" or "codex"' })
      return
    }
    const selectedAgentType = parsedAgentType ?? resolveCommanderAgentType(session)

    try {
      await questStore.resetActiveToPending(commanderId)

      const manager = new CommanderManager(
        commanderId,
        options.memoryBasePath,
        {
          onSubagentLifecycleEvent: (event) => onSubagentLifecycleEvent(commanderId, event),
        },
      )
      await manager.init()
      const agent = new CommanderAgent(commanderId, options.memoryBasePath)
      const contextPressureBridge = createContextPressureBridge()
      const workflow = await resolveCommanderWorkflow(
        commanderId,
        session.cwd,
        options.memoryBasePath,
      )
      const effectiveBasePrompt = resolveEffectiveBasePrompt(workflow.workflow)
      const flusher = new EmergencyFlusher(
        commanderId,
        manager.journalWriter,
        {
          postIssueComment: async ({ repo, issueNumber, body }) => {
            const parsedRepo = parseRepoFullName(repo)
            if (!parsedRepo) {
              throw new Error(`Invalid repository reference: ${repo}`)
            }

            const response = await fetchImpl(
              `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}/issues/${issueNumber}/comments`,
              {
                method: 'POST',
                headers: {
                  ...buildGitHubHeaders(githubToken),
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ body }),
              },
            )

            if (!response.ok) {
              throw new Error(await readGitHubError(response))
            }
          },
        },
      )
      const workingMemory = new WorkingMemoryStore(commanderId, options.memoryBasePath)
      await workingMemory.ensure()

      const started = await sessionStore.update(commanderId, (current) => ({
        ...current,
        state: 'running',
        agentType: selectedAgentType,
        pid: null,
        heartbeatTickCount: 0,
        currentTask: parsedCurrentTask.value ?? current.currentTask,
      }))

      if (!started) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      warnInvalidWorkflowHeartbeatInterval(commanderId, workflow)
      const effectiveHeartbeat = resolveEffectiveHeartbeat(started.heartbeat, workflow.workflow)
      const contextBuildOptions: Parameters<CommanderAgent['buildTaskPickupSystemPrompt']>[1] = {
        currentTask: toPromptIssue(started),
        recentConversation: [],
      }
      const built = await agent.buildTaskPickupSystemPrompt(
        effectiveBasePrompt,
        contextBuildOptions,
      )

      if (!sessionsInterface) {
        throw new Error('sessionsInterface not configured — agents router bridge missing')
      }

      const sessionName = toCommanderSessionName(commanderId)
      sessionsInterface.deleteSession(sessionName)
      const commanderSessionParams: Parameters<CommanderSessionsInterface['createCommanderSession']>[0] = {
        name: sessionName,
        systemPrompt: built.systemPrompt,
        agentType: selectedAgentType,
        cwd: started.cwd ?? undefined,
        resumeSessionId: selectedAgentType === 'claude' ? started.claudeSessionId : undefined,
        resumeCodexThreadId: selectedAgentType === 'codex' ? started.codexThreadId : undefined,
        maxTurns: workflow.workflow?.maxTurns,
      }
      await sessionsInterface.createCommanderSession(commanderSessionParams)

      const initialStreamSession = sessionsInterface.getSession(sessionName)
      const initialInputTokens = (
        typeof initialStreamSession?.usage.inputTokens === 'number' &&
        Number.isFinite(initialStreamSession.usage.inputTokens)
      )
        ? initialStreamSession.usage.inputTokens
        : 0

      const runtime: CommanderRuntime = {
        manager,
        agent,
        baseSystemPrompt: effectiveBasePrompt,
        flusher,
        workingMemory,
        contextPressureBridge,
        lastTaskState: 'Commander started',
        heartbeatCount: 0,
        lastKnownInputTokens: initialInputTokens,
        forceNextFatHeartbeat: false,
        pendingSpikeObservations: [],
        pendingCollect: [],
        collectTimer: null,
        subAgents: new Map(),
      }

      let contextPressureTriggeredForTurn = false
      const unsubscribeEvents = sessionsInterface.subscribeToEvents(sessionName, (event) => {
        const eventType = typeof event.type === 'string' ? event.type : ''
        if (eventType === 'message_start') {
          contextPressureTriggeredForTurn = false
        }
        const streamSession = sessionsInterface.getSession(sessionName)
        const sessionInputTokens = (
          typeof streamSession?.usage.inputTokens === 'number' &&
          Number.isFinite(streamSession.usage.inputTokens)
        )
          ? streamSession.usage.inputTokens
          : 0

        if (
          !contextPressureTriggeredForTurn &&
          (
            isLegacyContextPressureEvent(event) ||
            isInputTokenContextPressureEvent(
              event,
              sessionInputTokens,
              contextPressureInputTokenThreshold,
            )
          )
        ) {
          contextPressureTriggeredForTurn = true
          void contextPressureBridge.trigger()
        }

        if (eventType === 'result') {
          if (
            runtime.lastKnownInputTokens > 0 &&
            sessionInputTokens > 0 &&
            sessionInputTokens < runtime.lastKnownInputTokens * 0.5
          ) {
            runtime.forceNextFatHeartbeat = true
          }
          runtime.lastKnownInputTokens = sessionInputTokens
          contextPressureTriggeredForTurn = false
        }
      })

      runtime.unsubscribeEvents = unsubscribeEvents

      manager.wirePreCompactionFlush(
        contextPressureBridge,
        flusher,
        () => buildFlushContext(started, runtime),
      )

      runtimes.set(commanderId, runtime)
      ACTIVE_COMMANDER_SESSIONS.set(commanderId, {
        sessionName,
        startedAt: now().toISOString(),
      })
      heartbeatManager.start(commanderId, effectiveHeartbeat)
      const startPrompt = parseMessage(req.body?.message) ?? STARTUP_PROMPT
      const startupMessage = startPrompt
      const sessionRepo = toSessionRepo(started)
      const startIssueNumber = started.currentTask?.issueNumber ?? null

      try {
        await Promise.all([
          workingMemory.update({
            source: 'start',
            summary: startPrompt,
            hypothesis: extractHypothesisFromMessage(startPrompt),
            files: extractFileMentionsFromMessage(startPrompt),
            issueNumber: startIssueNumber,
            repo: sessionRepo,
            tags: startIssueNumber != null ? ['startup', 'task-linked'] : ['startup'],
          }),
          manager.journalWriter.append({
            timestamp: now().toISOString(),
            issueNumber: startIssueNumber,
            repo: sessionRepo,
            outcome: 'Commander session started',
            durationMin: null,
            salience: startIssueNumber != null ? 'NOTABLE' : 'ROUTINE',
            body: [
              `- Session: \`${sessionName}\``,
              `- Fat pin interval: \`${resolveFatPinInterval(started.contextConfig?.fatPinInterval)}\` heartbeat(s)`,
              `- Start prompt: ${startPrompt}`,
              startIssueNumber != null
                ? `- Current task URL: ${started.currentTask?.issueUrl ?? '_unknown_'}`
                : '- Current task: _none_',
            ].join('\n'),
          }),
        ])
      } catch (memoryError) {
        console.error(`[commanders] Failed to persist startup memory for "${commanderId}":`, memoryError)
      }

      const startupSent = await sessionsInterface.sendToSession(sessionName, startupMessage)
      if (!startupSent) {
        console.warn(
          `[commanders] Startup message failed for "${commanderId}" (${selectedAgentType}); resetting runtime state`,
        )

        heartbeatManager.stop(commanderId)
        heartbeatFiredAtByCommander.delete(commanderId)
        if (runtime.collectTimer) {
          clearTimeout(runtime.collectTimer)
          runtime.collectTimer = null
        }
        runtime.pendingCollect = []
        runtime.unsubscribeEvents?.()
        runtimes.delete(commanderId)
        ACTIVE_COMMANDER_SESSIONS.delete(commanderId)
        sessionsInterface.deleteSession(sessionName)

        await sessionStore.update(commanderId, (current) => ({
          ...current,
          state: 'idle',
          pid: null,
        }))

        res.status(503).json({
          error: 'Commander startup message could not be delivered. Please retry start.',
        })
        return
      }

      res.json({
        id: started.id,
        state: started.state,
        started: true,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to start commander',
      })
    }
  })

  router.post('/:id/heartbeat', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (session.state !== 'running') {
      res.status(409).json({
        error: `Commander "${commanderId}" is not running (state: ${session.state})`,
      })
      return
    }

    if (!heartbeatManager.isRunning(commanderId)) {
      res.status(409).json({
        error: `Commander "${commanderId}" heartbeat loop is not active`,
      })
      return
    }

    if (heartbeatManager.isInFlight(commanderId)) {
      res.status(409).json({
        error: `Commander "${commanderId}" heartbeat is already in flight`,
      })
      return
    }

    const timestamp = now().toISOString()
    const sessionName = toCommanderSessionName(commanderId)
    const triggered = heartbeatManager.fireManual(commanderId, timestamp)
    if (!triggered) {
      res.status(409).json({
        error: `Commander "${commanderId}" heartbeat could not be triggered`,
      })
      return
    }

    res.json({
      runId: timestamp,
      timestamp,
      sessionName,
      triggered: true,
    })
  })

  router.post('/:id/stop', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    heartbeatManager.stop(commanderId)
    heartbeatFiredAtByCommander.delete(commanderId)
    const activeSession = ACTIVE_COMMANDER_SESSIONS.get(commanderId)
    const sessionName = activeSession?.sessionName ?? toCommanderSessionName(commanderId)

    const runtime = runtimes.get(commanderId)
    if (runtime) {
      if (runtime.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      runtime.pendingCollect = []
      const stopState = parseMessage(req.body?.state) ?? 'Commander stop requested'
      runtime.lastTaskState = stopState
      runtime.unsubscribeEvents?.()

      try {
        await Promise.all([
          runtime.workingMemory.update({
            source: 'stop',
            summary: stopState,
            issueNumber: session.currentTask?.issueNumber ?? null,
            repo: toSessionRepo(session),
            hypothesis: extractHypothesisFromMessage(stopState),
            files: extractFileMentionsFromMessage(stopState),
            tags: ['stop'],
          }),
          runtime.manager.journalWriter.append({
            timestamp: now().toISOString(),
            issueNumber: session.currentTask?.issueNumber ?? null,
            repo: toSessionRepo(session),
            outcome: 'Commander stop requested',
            durationMin: null,
            salience: 'NOTABLE',
            body: [
              `- Session: \`${sessionName}\``,
              `- State: ${stopState}`,
            ].join('\n'),
          }),
        ])
      } catch (memoryError) {
        console.error(`[commanders] Failed to persist stop memory for "${commanderId}":`, memoryError)
      }

      const agentSession = sessionsInterface?.getSession(sessionName)
      if (agentSession) {
        // Persist provider-specific resume identifiers and accumulate session cost.
        // session.usage.costUsd is the total cost for this stream session (set by result events).
        const sessionCostUsd = agentSession.usage?.costUsd ?? 0
        await sessionStore.update(commanderId, (current) => ({
          ...current,
          agentType: resolveCommanderAgentType(current),
          claudeSessionId: agentSession.claudeSessionId ?? current.claudeSessionId,
          codexThreadId: agentSession.codexThreadId ?? current.codexThreadId,
          totalCostUsd: current.totalCostUsd + sessionCostUsd,
        }))
      }

      const latestSession = (await sessionStore.get(commanderId)) ?? session
      try {
        await runtime.manager.flushBetweenTasksAndPickNext(
          runtime.flusher,
          () => buildFlushContext(latestSession, runtime),
          async () => {
            runtime.forceNextFatHeartbeat = true
          },
        )
      } catch (error) {
        const flushErrorEvent = {
          type: 'system',
          text: `Commander flush failed on stop: ${error instanceof Error ? error.message : String(error)}`,
        } satisfies StreamEvent
        console.error('[commanders] Failed to flush on stop:', flushErrorEvent.text)
      }

      runtimes.delete(commanderId)
    }

    ACTIVE_COMMANDER_SESSIONS.delete(commanderId)
    sessionsInterface?.deleteSession(sessionName)

    const stopped = await sessionStore.update(commanderId, (current) => ({
      ...current,
      state: 'stopped',
      pid: null,
      currentTask: null,
    }))

    if (!stopped) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    res.json({
      id: stopped.id,
      state: stopped.state,
      stopped: true,
    })
  })

  router.delete('/:id', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (session.state === 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is running. Stop it before deleting.` })
      return
    }

    heartbeatManager.stop(commanderId)
    heartbeatFiredAtByCommander.delete(commanderId)

    const runtime = runtimes.get(commanderId)
    if (runtime) {
      if (runtime.collectTimer) {
        clearTimeout(runtime.collectTimer)
        runtime.collectTimer = null
      }
      runtime.pendingCollect = []
      runtime.unsubscribeEvents?.()
      runtimes.delete(commanderId)
    }
    ACTIVE_COMMANDER_SESSIONS.delete(commanderId)
    sessionsInterface?.deleteSession(toCommanderSessionName(commanderId))

    await sessionStore.delete(commanderId)
    withNamesLock(commanderDataDir, (names) => { delete names[commanderId] }).catch(() => {})
    res.status(204).send()
  })

  router.patch('/:id/heartbeat', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const parsed = parseHeartbeatPatch(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const updated = await sessionStore.update(commanderId, (current) => {
      const heartbeat = mergeHeartbeatState(current.heartbeat, parsed.value)
      return {
        ...current,
        heartbeat,
      }
    })

    if (!updated) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (updated.state === 'running' && ACTIVE_COMMANDER_SESSIONS.has(commanderId)) {
      const workflow = await resolveCommanderWorkflow(
        commanderId,
        updated.cwd,
        options.memoryBasePath,
      )
      warnInvalidWorkflowHeartbeatInterval(commanderId, workflow)
      const effectiveHeartbeat = resolveEffectiveHeartbeat(updated.heartbeat, workflow.workflow)
      heartbeatManager.start(commanderId, effectiveHeartbeat)
    } else {
      heartbeatManager.stop(commanderId)
    }

    res.json({
      id: updated.id,
      heartbeat: updated.heartbeat,
      lastHeartbeat: updated.lastHeartbeat,
    })
  })

  router.post('/:id/message', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const message = parseMessage(req.body?.message)
    if (!message) {
      res.status(400).json({ error: 'Message must be a non-empty string' })
      return
    }
    const mode = parseMessageMode(req.query.mode)
    if (!mode) {
      res.status(400).json({ error: 'mode must be either "collect" or "followup"' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const runtime = runtimes.get(commanderId)
    if (!runtime || session.state !== 'running') {
      res.status(409).json({ error: `Commander "${commanderId}" is not running` })
      return
    }

    const spikes = parseOptionalStringArray(req.body?.pendingSpikeObservations)
    if (spikes === null) {
      res.status(400).json({ error: 'pendingSpikeObservations must be an array of strings' })
      return
    }

    runtime.lastTaskState = message
    runtime.pendingSpikeObservations = spikes

    if (!sessionsInterface) {
      res.status(500).json({ error: 'sessionsInterface not configured' })
      return
    }

    const sessionName = ACTIVE_COMMANDER_SESSIONS.get(commanderId)?.sessionName
      ?? toCommanderSessionName(commanderId)
    if (mode === 'followup') {
      const sent = await sessionsInterface.sendToSession(sessionName, message)
      if (!sent) {
        res.status(409).json({ error: `Commander "${commanderId}" stream session unavailable` })
        return
      }
    } else {
      runtime.pendingCollect.push(message)
      scheduleCollectSend(commanderId, runtime)
    }

    const issueNumber = session.currentTask?.issueNumber ?? null
    const repo = toSessionRepo(session)
    const salience = spikes.length > 0 ? 'SPIKE' : 'NOTABLE'
    const memoryTags = spikes.length > 0 ? ['instruction', 'spike'] : ['instruction']
    try {
      await Promise.all([
        runtime.workingMemory.update({
          source: 'message',
          summary: message,
          issueNumber,
          repo,
          hypothesis: extractHypothesisFromMessage(message),
          files: extractFileMentionsFromMessage(message),
          tags: memoryTags,
        }),
        runtime.manager.journalWriter.append({
          timestamp: now().toISOString(),
          issueNumber,
          repo,
          outcome: 'Commander instruction received',
          durationMin: null,
          salience,
          body: [
            '### Instruction',
            message,
            ...(spikes.length > 0
              ? ['', '### Pending Spike Observations', ...spikes.map((spike) => `- ${spike}`)]
              : []),
          ].join('\n'),
        }),
      ])
    } catch (memoryError) {
      console.error(`[commanders] Failed to persist message memory for "${commanderId}":`, memoryError)
    }
    res.json({ accepted: true })
  })

  router.get('/:id/quests/next', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    try {
      const quest = await questStore.claimNext(commanderId)
      res.json({ quest })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to claim next quest',
      })
    }
  })

  router.post('/:id/memory/journal', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    const date = parseIsoDateKey(req.body?.date)
    const entries = parseJournalEntries(req.body?.entries)
    if (!date || entries === null) {
      res.status(400).json({ error: 'date and entries are required' })
      return
    }

    try {
      const writer = new JournalWriter(commanderId, options.memoryBasePath)
      await writer.scaffold()
      const result = await writer.appendBatch(date, entries)
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to append journal entries',
      })
    }
  })

  router.put('/:id/memory/sync', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const memoryMdRaw = body.memoryMd
    if (memoryMdRaw !== undefined && typeof memoryMdRaw !== 'string') {
      res.status(400).json({ error: 'memoryMd must be a string when provided' })
      return
    }
    const memoryMd = typeof memoryMdRaw === 'string' ? memoryMdRaw : undefined

    const repos = parseStringMap(body.repos)
    if (repos === null) {
      res.status(400).json({ error: 'repos must be an object of string values' })
      return
    }

    const skills = parseStringMap(body.skills)
    if (skills === null) {
      res.status(400).json({ error: 'skills must be an object of string values' })
      return
    }

    const commanderPaths = resolveCommanderPaths(commanderId, options.memoryBasePath)
    const memoryRoot = commanderPaths.memoryRoot
    const reposRoot = path.join(memoryRoot, 'repos')
    const skillsRoot = commanderPaths.skillsRoot

    const repoTargets: Array<{ filePath: string; content: string }> = []
    for (const [relativePath, content] of Object.entries(repos)) {
      const filePath = resolveSafeRelativePath(reposRoot, relativePath)
      if (!filePath) {
        res.status(400).json({ error: `Invalid repo path "${relativePath}"` })
        return
      }
      repoTargets.push({ filePath, content })
    }

    const skillTargets: Array<{ filePath: string; content: string }> = []
    for (const [relativePath, content] of Object.entries(skills)) {
      const filePath = resolveSafeRelativePath(skillsRoot, relativePath)
      if (!filePath) {
        res.status(400).json({ error: `Invalid skill path "${relativePath}"` })
        return
      }
      skillTargets.push({ filePath, content })
    }

    try {
      await Promise.all([
        mkdir(memoryRoot, { recursive: true }),
        mkdir(reposRoot, { recursive: true }),
        mkdir(skillsRoot, { recursive: true }),
      ])

      let memoryUpdated = false
      if (memoryMd !== undefined) {
        const memoryPath = path.join(memoryRoot, 'MEMORY.md')
        let currentMemory = ''
        try {
          currentMemory = await readFile(memoryPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }

        if (shouldReplaceMemoryMd(currentMemory, memoryMd)) {
          await writeFile(memoryPath, memoryMd, 'utf8')
          memoryUpdated = true
        }
      }

      let reposUpdated = 0
      let reposSkipped = 0
      for (const target of repoTargets) {
        let current = ''
        let exists = true
        try {
          current = await readFile(target.filePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            exists = false
          } else {
            throw error
          }
        }

        if (!exists || target.content.length > current.length) {
          await mkdir(path.dirname(target.filePath), { recursive: true })
          await writeFile(target.filePath, target.content, 'utf8')
          reposUpdated += 1
        } else {
          reposSkipped += 1
        }
      }

      let skillsUpdated = 0
      let skillsSkipped = 0
      for (const target of skillTargets) {
        let current = ''
        let exists = true
        try {
          current = await readFile(target.filePath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            exists = false
          } else {
            throw error
          }
        }

        if (!exists || target.content.length > current.length) {
          await mkdir(path.dirname(target.filePath), { recursive: true })
          await writeFile(target.filePath, target.content, 'utf8')
          skillsUpdated += 1
        } else {
          skillsSkipped += 1
        }
      }

      res.json({
        memoryUpdated,
        repos: { updated: reposUpdated, skipped: reposSkipped },
        skills: { updated: skillsUpdated, skipped: skillsSkipped },
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to sync commander memory',
      })
    }
  })

  router.get('/:id/memory/export', async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const auth = authorizeRemoteSync(req, session)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    try {
      const commanderPaths = resolveCommanderPaths(commanderId, options.memoryBasePath)
      const memoryRoot = commanderPaths.memoryRoot
      const memoryPath = path.join(memoryRoot, 'MEMORY.md')
      const journalRoot = path.join(memoryRoot, 'journal')
      const reposRoot = path.join(memoryRoot, 'repos')

      let memoryMd = '# Commander Memory\n\n'
      try {
        memoryMd = await readFile(memoryPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      const journalFiles = await readSnapshotFiles(journalRoot)
      const journal: Record<string, string> = {}
      for (const [relativePath, content] of Object.entries(journalFiles)) {
        const normalized = relativePath.replace(/\.md$/i, '')
        journal[normalized] = content
      }

      const repos = await readSnapshotFiles(reposRoot)
      const skills = await readSnapshotFiles(commanderPaths.skillsRoot)

      res.json({
        memoryMd,
        journal,
        repos,
        skills,
      })
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to export commander memory',
      })
    }
  })

  router.get('/:id/quests', requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const quests = await questStore.list(commanderId)
      res.json(quests)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list quests',
      })
    }
  })

  router.post('/:id/quests', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const hasSource = Object.prototype.hasOwnProperty.call(body, 'source')
    const hasGitHubIssueUrl = Object.prototype.hasOwnProperty.call(body, 'githubIssueUrl')
    const hasNote = Object.prototype.hasOwnProperty.call(body, 'note')
    const hasArtifacts = Object.prototype.hasOwnProperty.call(body, 'artifacts')

    const githubIssue = hasGitHubIssueUrl ? parseGitHubIssueUrl(body.githubIssueUrl) : null
    if (hasGitHubIssueUrl && !githubIssue) {
      res.status(400).json({ error: 'githubIssueUrl must be a valid GitHub issue URL' })
      return
    }

    let source: CommanderQuestSource
    if (hasSource) {
      const parsedSource = parseQuestSource(body.source)
      if (!parsedSource) {
        res.status(400).json({ error: 'source is invalid' })
        return
      }
      source = parsedSource
    } else {
      source = githubIssue ? 'github-issue' : 'manual'
    }

    const contract = parseQuestContract(body.contract)
    if (!contract) {
      res.status(400).json({ error: 'contract is invalid' })
      return
    }

    let note: string | undefined
    if (hasNote) {
      const parsedNote = parseMessage(body.note)
      if (!parsedNote) {
        res.status(400).json({ error: 'note must be a non-empty string when provided' })
        return
      }
      note = parsedNote
    }

    let artifacts: QuestArtifact[] | undefined
    if (hasArtifacts) {
      const parsedArtifacts = parseQuestArtifacts(body.artifacts)
      if (!parsedArtifacts) {
        res.status(400).json({ error: 'artifacts must be an array of { type, label, href }' })
        return
      }
      artifacts = parsedArtifacts
    }

    let instruction = parseMessage(body.instruction)
    if (githubIssue) {
      try {
        const ghTasks = ghTasksFactory(`${githubIssue.owner}/${githubIssue.repo}`)
        const issue = await ghTasks.readTask(githubIssue.issueNumber)
        instruction = buildQuestInstructionFromGitHubIssue({
          title: issue.title,
          body: issue.body,
        })
      } catch (error) {
        res.status(502).json({
          error: error instanceof Error ? error.message : 'Failed to import GitHub issue',
        })
        return
      }
    }

    if (!instruction) {
      res.status(400).json({ error: 'instruction is required when githubIssueUrl is not provided' })
      return
    }

    try {
      const created = await questStore.create({
        commanderId,
        status: 'pending',
        source,
        instruction,
        ...(githubIssue ? { githubIssueUrl: githubIssue.normalizedUrl } : {}),
        ...(note ? { note } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
        contract,
      })
      res.status(201).json(created)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create quest',
      })
    }
  })

  router.patch('/:id/quests/:questId', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
    const hasNote = Object.prototype.hasOwnProperty.call(body, 'note')
    const hasArtifacts = Object.prototype.hasOwnProperty.call(body, 'artifacts')
    if (!hasStatus && !hasNote && !hasArtifacts) {
      res.status(400).json({ error: 'At least one of status, note, or artifacts is required' })
      return
    }

    const update: {
      status?: CommanderQuestStatus
      note?: string | null
      artifacts?: QuestArtifact[] | null
    } = {}
    if (hasStatus) {
      const status = parseQuestStatus(body.status)
      if (!status) {
        res.status(400).json({ error: 'status is invalid' })
        return
      }
      update.status = status
    }
    if (hasNote) {
      if (body.note === null) {
        update.note = null
      } else {
        const note = parseMessage(body.note)
        if (!note) {
          res.status(400).json({ error: 'note must be a non-empty string or null' })
          return
        }
        update.note = note
      }
    }
    if (hasArtifacts) {
      if (body.artifacts === null) {
        update.artifacts = null
      } else {
        const artifacts = parseQuestArtifacts(body.artifacts)
        if (!artifacts) {
          res.status(400).json({ error: 'artifacts must be an array of { type, label, href } or null' })
          return
        }
        update.artifacts = artifacts
      }
    }

    try {
      const updated = await questStore.update(commanderId, questId, update)
      if (!updated) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }
      res.json(updated)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to update quest',
      })
    }
  })

  router.post('/:id/quests/:questId/notes', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const note = parseMessage(body.note)
    if (!note) {
      res.status(400).json({ error: 'note must be a non-empty string' })
      return
    }

    try {
      const updated = await questStore.appendNote(commanderId, questId, note)
      if (!updated) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }
      res.json(updated)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to append quest note',
      })
    }
  })

  router.delete('/:id/quests/:questId', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const questId = parseQuestId(req.params.questId)
    if (!questId) {
      res.status(400).json({ error: 'Invalid quest id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const deleted = await questStore.delete(commanderId, questId)
      if (!deleted) {
        res.status(404).json({ error: `Quest "${questId}" not found` })
        return
      }
      res.status(204).send()
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete quest',
      })
    }
  })

  router.get('/:id/tasks', requireReadAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const state = typeof req.query.state === 'string' && req.query.state.trim().length > 0
      ? req.query.state.trim()
      : 'open'

    if (!session.taskSource || !session.taskSource.owner || !session.taskSource.repo) {
      res.json([])
      return
    }

    const params = new URLSearchParams({
      state,
      per_page: '100',
    })
    if (session.taskSource.label) {
      params.set('labels', session.taskSource.label)
    }

    const response = await fetchImpl(
      `https://api.github.com/repos/${session.taskSource.owner}/${session.taskSource.repo}/issues?${params.toString()}`,
      {
        method: 'GET',
        headers: buildGitHubHeaders(githubToken),
      },
    )

    if (!response.ok) {
      res.status(response.status).json({ error: await readGitHubError(response) })
      return
    }

    const payload = (await response.json()) as unknown
    const issues = Array.isArray(payload) ? payload : []
    const tasks = issues
      .filter(
        (issue): issue is GitHubIssueResponse =>
          isObject(issue) && !('pull_request' in issue),
      )
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        issueUrl: issue.html_url,
        state: issue.state,
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((label) => (typeof label?.name === 'string' ? label.name : null))
              .filter((name): name is string => Boolean(name))
          : [],
      }))

    res.json(tasks)
  })

  router.post('/:id/tasks', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const issueNumber = parseIssueNumber(req.body?.issueNumber)
    if (!issueNumber) {
      res.status(400).json({ error: 'issueNumber must be a positive integer' })
      return
    }

    const session = await sessionStore.get(commanderId)
    if (!session) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    if (!session.taskSource || !session.taskSource.owner || !session.taskSource.repo) {
      res.status(400).json({ error: 'No GitHub task source configured for this commander' })
      return
    }

    const label = typeof req.body?.label === 'string' && req.body.label.trim().length > 0
      ? req.body.label.trim()
      : session.taskSource.label

    if (!label) {
      res.status(400).json({ error: 'No task label configured for assignment' })
      return
    }

    const response = await fetchImpl(
      `https://api.github.com/repos/${session.taskSource.owner}/${session.taskSource.repo}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: {
          ...buildGitHubHeaders(githubToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          labels: [label],
        }),
      },
    )

    if (!response.ok) {
      res.status(response.status).json({ error: await readGitHubError(response) })
      return
    }

    const currentTask: CommanderCurrentTask = {
      issueNumber,
      issueUrl: `https://github.com/${session.taskSource.owner}/${session.taskSource.repo}/issues/${issueNumber}`,
      startedAt: now().toISOString(),
    }
    const previousIssueNumber = session.currentTask?.issueNumber ?? null

    const updated = await sessionStore.update(commanderId, (current) => ({
      ...current,
      currentTask,
    }))

    const runtime = runtimes.get(commanderId)
    if (runtime && previousIssueNumber !== issueNumber) {
      runtime.forceNextFatHeartbeat = true
    }

    res.status(201).json({
      assigned: true,
      currentTask: updated?.currentTask ?? currentTask,
    })
  })

  // --- Cron routes ---

  router.get('/:id/crons', requireReadAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    try {
      const taskRecords = await listCommanderCronTasksWithStores(commanderId)
      const taskIds = taskRecords.map((record) => record.task.id)
      const latestByStore = await Promise.all(
        listCommanderCronRunStores(commanderId).map((runStore) => runStore.listLatestRunsByTaskIds(taskIds)),
      )
      const response = taskRecords.map(({ task }) => {
        const latest = pickLatestWorkflowRun(latestByStore.map((runs) => runs.get(task.id)))
        const lastRunAt = latest?.completedAt ?? latest?.startedAt ?? null
        return toCommanderCronTask(task, commanderId, lastRunAt)
      })
      res.json(response)
    } catch {
      res.status(500).json({ error: 'Failed to list cron tasks' })
    }
  })

  router.post('/:id/crons', requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const schedule = parseSchedule(req.body?.schedule)
    if (!schedule) {
      res.status(400).json({ error: 'schedule is required' })
      return
    }

    const instruction = parseCronInstruction(req.body?.instruction)
    if (!instruction) {
      res.status(400).json({ error: 'instruction is required' })
      return
    }

    const enabled = parseOptionalEnabled(req.body?.enabled)
    if (enabled === null) {
      res.status(400).json({ error: 'enabled must be a boolean when provided' })
      return
    }

    if (!cron.validate(schedule)) {
      res.status(400).json({ error: 'Invalid cron expression' })
      return
    }

    const name = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : `commander-${commanderId}-cron`
    const agentType = req.body?.agentType === 'codex' ? 'codex' : 'claude'
    const sessionType = req.body?.sessionType === 'pty' ? 'pty' : req.body?.sessionType === 'stream' ? 'stream' : undefined
    const permissionMode = typeof req.body?.permissionMode === 'string' && req.body.permissionMode ? req.body.permissionMode as string : undefined
    const workDir = typeof req.body?.workDir === 'string' ? req.body.workDir.trim() : ''
    if (workDir && !workDir.startsWith('/')) {
      res.status(400).json({ error: 'workDir must be an absolute path when provided' })
      return
    }
    const machine = typeof req.body?.machine === 'string' ? req.body.machine.trim() : ''

    try {
      await commandRoomSchedulerInitialized
      const createInput: CreateCronTaskInput = {
        name,
        commanderId,
        schedule,
        machine,
        workDir,
        agentType,
        instruction,
        enabled: enabled ?? true,
        sessionType,
        permissionMode,
      }
      const created = commandRoomScheduler
        ? await commandRoomScheduler.createTask(createInput)
        : await getCommanderCronStores(commanderId).taskStore.createTask(createInput)
      res.status(201).json(toCommanderCronTask(created, commanderId))
    } catch {
      res.status(500).json({ error: 'Failed to create cron task' })
    }
  })

  router.patch('/:id/crons/:cronId', requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const cronTaskId = parseCronTaskId(req.params.cronId)
    if (!cronTaskId) {
      res.status(400).json({ error: 'Invalid cron task id' })
      return
    }

    const update: {
      schedule?: string
      instruction?: string
      enabled?: boolean
    } = {}

    if ('schedule' in (req.body ?? {})) {
      const schedule = parseSchedule(req.body?.schedule)
      if (!schedule) {
        res.status(400).json({ error: 'schedule must be a non-empty string' })
        return
      }
      update.schedule = schedule
    }

    if ('instruction' in (req.body ?? {})) {
      const instruction = parseCronInstruction(req.body?.instruction)
      if (!instruction) {
        res.status(400).json({ error: 'instruction must be a non-empty string' })
        return
      }
      update.instruction = instruction
    }

    if ('enabled' in (req.body ?? {})) {
      const enabled = parseOptionalEnabled(req.body?.enabled)
      if (enabled === null || enabled === undefined) {
        res.status(400).json({ error: 'enabled must be a boolean' })
        return
      }
      update.enabled = enabled
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'At least one of schedule, instruction, or enabled is required' })
      return
    }

    if (update.schedule && !cron.validate(update.schedule)) {
      res.status(400).json({ error: 'Invalid cron expression' })
      return
    }

    try {
      await commandRoomSchedulerInitialized
      const record = await findCommanderCronTaskWithStores(commanderId, cronTaskId)
      if (!record) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      let updated = commandRoomScheduler
        ? await commandRoomScheduler.updateTask(cronTaskId, update)
        : null
      if (!updated) {
        updated = await record.stores.taskStore.updateTask(cronTaskId, update)
      }
      if (!updated || updated.commanderId !== commanderId) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      res.json(toCommanderCronTask(updated, commanderId))
    } catch {
      res.status(500).json({ error: 'Failed to update cron task' })
    }
  })

  router.delete('/:id/crons/:cronId', requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const cronTaskId = parseCronTaskId(req.params.cronId)
    if (!cronTaskId) {
      res.status(400).json({ error: 'Invalid cron task id' })
      return
    }

    try {
      await commandRoomSchedulerInitialized
      const record = await findCommanderCronTaskWithStores(commanderId, cronTaskId)
      if (!record) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      const schedulerDeleted = commandRoomScheduler
        ? await commandRoomScheduler.deleteTask(cronTaskId)
        : false

      let deletedCount = 0
      for (const taskStore of listCommanderCronTaskStores(commanderId)) {
        deletedCount += await taskStore.deleteTaskEverywhere(cronTaskId, commanderId)
      }
      if (!schedulerDeleted && deletedCount === 0) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }
      await Promise.all(
        listCommanderCronRunStores(commanderId).map((runStore) => runStore.deleteRunsForTask(cronTaskId)),
      )

      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'Failed to delete cron task' })
    }
  })

  router.post('/:id/cron-trigger', requireWriteAccess, async (req, res) => {
    const commanderId = parseCommanderId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    const instruction = parseTriggerInstruction(req.body)
    if (!instruction) {
      res.status(200).json({ ok: true, triggered: false })
      return
    }

    try {
      const runtime = runtimes.get(commanderId)
      if (runtime && sessionsInterface) {
        const session = await sessionStore.get(commanderId)
        if (session && session.state === 'running') {
          runtime.lastTaskState = instruction
          runtime.pendingSpikeObservations = []
          const sent = await sessionsInterface.sendToSession(`commander-${commanderId}`, instruction)
          res.status(200).json({ ok: true, triggered: sent })
          return
        }
      }
      res.status(200).json({ ok: true, triggered: false })
    } catch {
      res.status(500).json({ error: 'Failed to trigger commander instruction' })
    }
  })

  // --- Memory CLI endpoints ---

  router.post('/:id/memory/compact', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    try {
      const consolidation = new NightlyConsolidation({
        basePath: options.memoryBasePath,
        now,
      })
      const report = await consolidation.run(commanderId)
      res.json(report)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to run memory consolidation',
      })
    }
  })

  router.post('/:id/memory/recall', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const cue = typeof body.cue === 'string' ? body.cue.trim() : ''
    if (!cue) {
      res.status(400).json({ error: 'cue is required' })
      return
    }

    const topK = typeof body.topK === 'number' && body.topK > 0 ? body.topK : undefined

    try {
      const recollection = new MemoryRecollection(commanderId, options.memoryBasePath)
      const result = await recollection.recall({ cue, topK })
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to recall memory',
      })
    }
  })

  router.post('/:id/memory/facts', requireWriteAccess, async (req, res) => {
    const commanderId = parseSessionId(req.params.id)
    if (!commanderId) {
      res.status(400).json({ error: 'Invalid commander id' })
      return
    }

    if (!(await sessionStore.get(commanderId))) {
      res.status(404).json({ error: `Commander "${commanderId}" not found` })
      return
    }

    const body = isObject(req.body) ? req.body : {}
    const facts = Array.isArray(body.facts)
      ? body.facts.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0)
      : []
    if (facts.length === 0) {
      res.status(400).json({ error: 'facts array with at least one non-empty string is required' })
      return
    }

    try {
      const commanderPaths = resolveCommanderPaths(commanderId, options.memoryBasePath)
      await mkdir(commanderPaths.memoryRoot, { recursive: true })
      const writer = new MemoryMdWriter(commanderPaths.memoryRoot)
      const result = await writer.updateFacts(facts)
      res.json(result)
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to save facts',
      })
    }
  })

  setTimeout(() => {
    void reconcileCommanderSessions().catch((error) => {
      console.error('[commanders] Startup reconciliation failed:', error)
    })
  }, 0)

  return { router }
}
