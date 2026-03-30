import { Router, type Response } from 'express'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import multer from 'multer'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { createAuth0Verifier } from '../../server/middleware/auth0.js'
import { bootstrapFactoryWorktree } from '../factory/worktree.js'
import { resolveCommanderDataDir, resolveCommanderNamesPath } from '../commanders/paths.js'
import { buildCommanderSessionSeed } from '../commanders/routes.js'
import { CommanderSessionStore, type CommanderSession } from '../commanders/store.js'
import {
  extractMessages,
  readCommanderTranscript,
  type MessageRoleFilter,
  type SessionMessagesResponse,
} from './session-messages.js'
import { JournalWriter, EmergencyFlusher } from '../commanders/memory/index.js'
import { KeyedAsyncQueue } from './message-queue.js'
import { QuestStore } from '../commanders/quest-store.js'
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  createWorkspaceUploadMiddleware,
  deleteWorkspaceEntry,
  initWorkspaceGit,
  listWorkspaceTree,
  readWorkspaceFilePreview,
  readWorkspaceGitLog,
  readWorkspaceGitStatus,
  renameWorkspaceEntry,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  resolveWorkspaceUploadDestination,
  saveWorkspaceTextFile,
  toWorkspaceError,
  WorkspaceError,
} from '../workspace/index.js'

const DEFAULT_MAX_SESSIONS = 10
const DEFAULT_TASK_DELAY_MS = 3000
const DEFAULT_WS_KEEPALIVE_INTERVAL_MS = 30000
const DEFAULT_AUTO_ROTATE_ENTRY_THRESHOLD = 500
const MAX_BUFFER_BYTES = 256 * 1024
const MAX_STREAM_EVENTS = 1000
const MAX_PENDING_SESSION_MESSAGES = 50
const HOTWASH_DEBRIEF_TIMEOUT_MS = 60_000
const AAR_DEBRIEF_TIMEOUT_MS = 180_000
const CODEX_TURN_COMPLETION_TIMEOUT_MS = 60_000
const LONG_SESSION_USER_TURN_THRESHOLD = 10
const LONG_SESSION_EVENT_THRESHOLD = 120
const LONG_SESSION_DURATION_MS = 45 * 60 * 1000
const PTY_DEBRIEF_POLL_INTERVAL_MS = 250
const PTY_DEBRIEF_COMPLETION_PATTERN = /\/clear\b/i
const SESSION_NAME_PATTERN = /^[\w-]+$/
const FILE_NAME_PATTERN = /^[a-zA-Z0-9._\- ]+$/
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const DEFAULT_SESSION_STORE_PATH = 'data/agents/stream-sessions.json'
const COMMAND_ROOM_SESSION_PREFIX = 'command-room-'
const FACTORY_SESSION_PREFIX = 'factory-'
const AGENT_SESSION_PREFIX = 'agent-'
const COMMANDER_SESSION_NAME_PREFIX = 'commander-'
const COMMANDER_ROTATION_CONTINUATION_PROMPT = 'Session rotated. Continuing as commander.'
const COMMANDER_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/
const COMMAND_ROOM_STALE_SESSION_TTL_MS = 15 * 60 * 1000
const COMMAND_ROOM_COMPLETED_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const DONE_WORKER_TTL_MS = 30 * 60 * 1000 // 30 minutes
const FACTORY_BRANCH_PATTERN = /^[\w-]+$/
const GITHUB_ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/issues\/(\d+)(?:[/?#].*)?$/
const GITHUB_REMOTE_URL_PATTERN = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const DEFAULT_COMPLETED_SESSIONS_STORE_PATH = 'data/agents/completed-sessions.json'
const DEFAULT_OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL?.trim() || 'http://localhost:18789'

const execFileAsync = promisify(execFile)

type ClaudePermissionMode = 'default' | 'acceptEdits' | 'dangerouslySkipPermissions'

type AgentType = 'claude' | 'codex' | 'openclaw'

function parseAgentType(raw: unknown): AgentType {
  if (raw === 'codex') return 'codex'
  if (raw === 'openclaw') return 'openclaw'
  return 'claude'
}

const CLAUDE_MODE_COMMANDS: Record<ClaudePermissionMode, string> = {
  default: 'unset CLAUDECODE && claude',
  acceptEdits: 'unset CLAUDECODE && claude --permission-mode acceptEdits',
  dangerouslySkipPermissions: 'unset CLAUDECODE && claude --dangerously-skip-permissions',
}

const CODEX_MODE_COMMANDS: Record<ClaudePermissionMode, string> = {
  default: 'codex',
  acceptEdits: 'codex --full-auto',
  dangerouslySkipPermissions: 'codex --dangerously-bypass-approvals-and-sandbox',
}

export interface AgentSession {
  name: string
  label?: string
  created: string
  pid: number
  processAlive?: boolean
  sessionType?: 'pty' | 'stream'
  agentType?: AgentType
  cwd?: string
  host?: string
  parentSession?: string
  spawnedWorkers?: string[]
  workerSummary?: WorkerSummary
}

type WorldAgentStatus = 'active' | 'idle' | 'stale' | 'completed'
type WorldAgentPhase = 'idle' | 'thinking' | 'tool_use' | 'blocked' | 'completed'
type WorldAgentRole = 'commander' | 'worker'

export interface WorldAgent {
  id: string
  agentType: AgentType
  sessionType: 'pty' | 'stream'
  status: WorldAgentStatus
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  task: string
  phase: WorldAgentPhase
  lastToolUse: string | null
  lastUpdatedAt: string
  role: WorldAgentRole
  channelMeta?: {
    provider: 'whatsapp' | 'telegram' | 'discord'
    displayName: string
    chatType: 'direct' | 'group' | 'channel' | 'forum-topic'
  }
}

export interface PtyHandle {
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pid: number
}

export interface PtySpawner {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: NodeJS.ProcessEnv
    },
  ): PtyHandle
}

interface PtySession {
  kind: 'pty'
  name: string
  agentType: AgentType
  cwd: string
  host?: string
  task?: string
  pty: PtyHandle
  buffer: string
  bufferBytesDropped: number
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
}

interface StreamJsonEvent {
  type: string
  [key: string]: unknown
}

interface StreamSession {
  kind: 'stream'
  name: string
  agentType: AgentType
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  parentSession?: string
  spawnedWorkers: string[]
  task?: string
  process: ChildProcess
  events: StreamJsonEvent[]
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  stdoutBuffer: string
  lastStderrSummary?: string
  stdinDraining: boolean
  lastTurnCompleted: boolean
  completedTurnAt?: string
  systemPrompt?: string
  maxTurns?: number
  messageQueue: KeyedAsyncQueue
  pendingMessageCount: number
  /** Normalized append-only entry metric (completed turns). */
  conversationEntryCount: number
  autoRotatePending: boolean
  turnCompletedEmitter: EventEmitter
  claudeSessionId?: string
  codexThreadId?: string
  finalResultEvent?: StreamJsonEvent
  /** True when this session was spawned during restore with no new task.
   * Used to skip the persist-write on exit so the file is not overwritten
   * with an empty list just because the idle resume process exited. */
  restoredIdle: boolean
}

interface OpenClawSession {
  kind: 'openclaw'
  name: string
  agentType: 'openclaw'
  cwd: string
  host?: string
  task?: string
  sessionKey: string
  gatewayUrl: string
  agentId: string
  gatewayWs: WebSocket | null
  events: StreamJsonEvent[]
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  pendingHookDispatches: number
  pendingTurnCount: number
  claudeSessionId?: string
}

interface CompletedSession {
  name: string
  completedAt: string
  subtype: string
  finalComment: string
  costUsd: number
}

type WorkerStatus = 'starting' | 'running' | 'down' | 'done'
type WorkerPhase = 'starting' | 'running' | 'exited'

interface WorkerState {
  name: string
  status: WorkerStatus
  phase: WorkerPhase
}

interface WorkerSummary {
  total: number
  starting: number
  running: number
  down: number
  done: number
}

interface ExitedStreamSessionState {
  phase: 'exited'
  hadResult: boolean
  exitedAt: number // Date.now() at exit — used for done-worker TTL
}

interface StreamSessionCreateOptions {
  resumeSessionId?: string
  systemPrompt?: string
  maxTurns?: number
  createdAt?: string
  parentSession?: string
  spawnedWorkers?: string[]
}

interface CodexSessionCreateOptions {
  createdAt?: string
  parentSession?: string
  spawnedWorkers?: string[]
  systemPrompt?: string
  maxTurns?: number
}

type AnySession = PtySession | StreamSession | OpenClawSession
type SessionLength = 'short' | 'long'
type DebriefMode = 'hotwash' | 'aar'

interface PreKillDebriefResult {
  attempted: boolean
  debriefed: boolean
  mode: DebriefMode
  sessionLength: SessionLength
  timeoutMs: number
  timedOut: boolean
  reason?: string
}

type DebriefStatus = 'pending' | 'completed' | 'timed-out' | 'none'

interface DebriefState {
  status: DebriefStatus
  startedAt: string
  timeoutMs: number
}

export interface AgentsRouterOptions {
  ptySpawner?: PtySpawner
  maxSessions?: number
  taskDelayMs?: number
  wsKeepAliveIntervalMs?: number
  autoRotateEntryThreshold?: number
  sessionStorePath?: string
  autoResumeSessions?: boolean
  machinesFilePath?: string
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  internalToken?: string
  commanderSessionStorePath?: string
  completedSessionsStorePath?: string
  questStore?: QuestStore
}

export interface AgentsRouterResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  sessionsInterface: CommanderSessionsInterface
}

export interface CommanderSessionsInterface {
  createCommanderSession(params: {
    name: string
    systemPrompt: string
    agentType: 'claude' | 'codex'
    cwd?: string
    resumeSessionId?: string
    resumeCodexThreadId?: string
    maxTurns?: number
  }): Promise<StreamSession>
  sendToSession(name: string, text: string): Promise<boolean>
  deleteSession(name: string): void
  getSession(name: string): StreamSession | undefined
  subscribeToEvents(name: string, handler: (event: StreamJsonEvent) => void): () => void
}

function parseSessionName(rawSessionName: unknown): string | null {
  if (typeof rawSessionName !== 'string') {
    return null
  }

  const sessionName = rawSessionName.trim()
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    return null
  }

  return sessionName
}

function parseQueryBoolean(rawValue: unknown): boolean {
  if (typeof rawValue === 'string') {
    const normalized = rawValue.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes'
  }
  if (Array.isArray(rawValue)) {
    return rawValue.some((value) => parseQueryBoolean(value))
  }
  return false
}

function parseClaudePermissionMode(rawMode: unknown): ClaudePermissionMode | null {
  if (typeof rawMode !== 'string') {
    return null
  }

  if (
    rawMode !== 'default' &&
    rawMode !== 'acceptEdits' &&
    rawMode !== 'dangerouslySkipPermissions'
  ) {
    return null
  }

  return rawMode
}

function parseOptionalTask(rawTask: unknown): string | null {
  if (rawTask === undefined || rawTask === null) {
    return ''
  }

  if (typeof rawTask !== 'string') {
    return null
  }

  return rawTask.trim()
}

function parseCwd(rawCwd: unknown): string | null | undefined {
  if (rawCwd === undefined || rawCwd === null || rawCwd === '') {
    return undefined // use default
  }

  if (typeof rawCwd !== 'string') {
    return null // invalid
  }

  const trimmed = rawCwd.trim()
  if (trimmed === '') {
    return undefined
  }

  if (!trimmed.startsWith('/')) {
    return null // must be absolute
  }

  // Normalize to prevent .. traversal
  return path.resolve(trimmed)
}

function parseFactoryBranch(rawBranch: unknown): string | null | undefined {
  if (rawBranch === undefined || rawBranch === null || rawBranch === '') {
    return undefined
  }

  if (typeof rawBranch !== 'string') {
    return null
  }

  const normalized = rawBranch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[\/\s]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!FACTORY_BRANCH_PATTERN.test(normalized)) {
    return null
  }

  return normalized
}

function parseDispatchWorkerType(rawWorkerType: unknown): 'factory' | 'agent' | null {
  if (rawWorkerType === undefined || rawWorkerType === null || rawWorkerType === '') {
    return 'factory'
  }

  if (typeof rawWorkerType !== 'string') {
    return null
  }

  const normalized = rawWorkerType.trim()
  if (normalized === 'factory' || normalized === 'agent') {
    return normalized
  }

  return null
}

function parseGitHubIssueUrl(
  rawIssueUrl: unknown,
): { owner: string; repo: string; issueNumber: string } | null | undefined {
  if (rawIssueUrl === undefined || rawIssueUrl === null || rawIssueUrl === '') {
    return undefined
  }

  if (typeof rawIssueUrl !== 'string') {
    return null
  }

  const match = rawIssueUrl.trim().match(GITHUB_ISSUE_URL_PATTERN)
  if (!match) {
    return null
  }

  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3],
  }
}

function parseGitHubRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.trim().match(GITHUB_REMOTE_URL_PATTERN)
  if (!match) {
    return null
  }

  return {
    owner: match[1],
    repo: match[2],
  }
}

async function resolveGitHubRepoFromCwd(cwd: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd })
    return parseGitHubRepoFromRemote(stdout)
  } catch {
    return null
  }
}

export interface MachineConfig {
  id: string
  label: string
  host: string | null
  user?: string
  port?: number
  cwd?: string
}

interface PersistedStreamSession {
  name: string
  agentType: AgentType
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  createdAt: string
  systemPrompt?: string
  maxTurns?: number
  claudeSessionId?: string
  codexThreadId?: string
  parentSession?: string
  spawnedWorkers?: string[]
  conversationEntryCount?: number
  events?: StreamJsonEvent[]
}

interface PersistedSessionsState {
  sessions: PersistedStreamSession[]
}

function parseOptionalHost(rawHost: unknown): string | null | undefined {
  if (rawHost === undefined || rawHost === null || rawHost === '') {
    return undefined
  }

  if (typeof rawHost !== 'string') {
    return null
  }

  const trimmed = rawHost.trim()
  if (!SESSION_NAME_PATTERN.test(trimmed)) {
    return null
  }

  return trimmed
}

function parseMachineRegistry(raw: unknown): MachineConfig[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid machines config: expected an object')
  }

  const machines = (raw as { machines?: unknown }).machines
  if (!Array.isArray(machines)) {
    throw new Error('Invalid machines config: expected "machines" array')
  }

  const seenIds = new Set<string>()
  const parsed: MachineConfig[] = []
  for (const machine of machines) {
    if (!machine || typeof machine !== 'object') {
      throw new Error('Invalid machines config: machine entry must be an object')
    }

    const id = (machine as { id?: unknown }).id
    const label = (machine as { label?: unknown }).label
    const host = (machine as { host?: unknown }).host
    const user = (machine as { user?: unknown }).user
    const port = (machine as { port?: unknown }).port
    const cwd = (machine as { cwd?: unknown }).cwd

    if (typeof id !== 'string' || !SESSION_NAME_PATTERN.test(id)) {
      throw new Error('Invalid machines config: machine id must match [a-zA-Z0-9_-]+')
    }
    if (seenIds.has(id)) {
      throw new Error(`Invalid machines config: duplicate machine id "${id}"`)
    }
    seenIds.add(id)

    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new Error(`Invalid machines config: machine "${id}" must include a label`)
    }
    if (host !== null && typeof host !== 'string') {
      throw new Error(`Invalid machines config: machine "${id}" host must be string or null`)
    }
    if (typeof user !== 'undefined' && typeof user !== 'string') {
      throw new Error(`Invalid machines config: machine "${id}" user must be string`)
    }
    if (typeof port !== 'undefined') {
      if (
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port <= 0 ||
        port > 65535
      ) {
        throw new Error(`Invalid machines config: machine "${id}" port must be 1-65535`)
      }
    }
    if (typeof cwd !== 'undefined') {
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
        throw new Error(`Invalid machines config: machine "${id}" cwd must be absolute`)
      }
    }

    parsed.push({
      id,
      label: label.trim(),
      host: typeof host === 'string' && host.trim().length > 0 ? host.trim() : null,
      user: typeof user === 'string' && user.trim().length > 0 ? user.trim() : undefined,
      port,
      cwd,
    })
  }

  return parsed
}

function isRemoteMachine(machine: MachineConfig | undefined): machine is MachineConfig & { host: string } {
  return Boolean(machine?.host)
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
}

function buildRemoteCommand(command: string, args: string[], cwd?: string): string {
  const base = [command, ...args].map(shellEscape).join(' ')
  if (cwd) {
    return `cd ${shellEscape(cwd)} && exec ${base}`
  }
  return `exec ${base}`
}

function buildSshDestination(machine: MachineConfig & { host: string }): string {
  if (machine.user) {
    return `${machine.user}@${machine.host}`
  }
  return machine.host
}

function buildSshArgs(
  machine: MachineConfig & { host: string },
  remoteCommand: string,
  forceTty: boolean,
): string[] {
  const args: string[] = []
  if (forceTty) {
    args.push('-tt')
  }
  if (machine.port) {
    args.push('-p', String(machine.port))
  }
  args.push(buildSshDestination(machine), remoteCommand)
  return args
}

type SessionType = 'pty' | 'stream'

function parseSessionType(raw: unknown): SessionType {
  if (raw === 'stream') return 'stream'
  return 'pty'
}

function parseMaxSessions(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SESSIONS
  }
  return parsed
}

function parseTaskDelayMs(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TASK_DELAY_MS
  }
  return parsed
}

function parseWsKeepAliveIntervalMs(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WS_KEEPALIVE_INTERVAL_MS
  }
  return parsed
}

function parseAutoRotateEntryThreshold(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTO_ROTATE_ENTRY_THRESHOLD
  }
  return parsed
}

function summarizeWorkerStates(workers: WorkerState[]): WorkerSummary {
  const summary: WorkerSummary = {
    total: workers.length,
    starting: 0,
    running: 0,
    down: 0,
    done: 0,
  }

  for (const worker of workers) {
    if (worker.status === 'starting') summary.starting += 1
    if (worker.status === 'running') summary.running += 1
    if (worker.status === 'down') summary.down += 1
    if (worker.status === 'done') summary.done += 1
  }

  return summary
}

function isWorkerOrchestrationComplete(summary: WorkerSummary): boolean {
  return (
    summary.total > 0
    && summary.done === summary.total
    && summary.running === 0
    && summary.starting === 0
    && summary.down === 0
  )
}

function parseFrontmatter(content: string): Record<string, string | boolean> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string | boolean> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let val = line.slice(colonIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (val === 'true') { result[key] = true }
    else if (val === 'false') { result[key] = false }
    else { result[key] = val }
  }
  return result
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  return value as Record<string, unknown>
}

function countCompletedTurnEntries(events: StreamJsonEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'result') {
      count += 1
    }
  }
  return count
}

function parsePersistedStreamSessionEntry(value: unknown): PersistedStreamSession | null {
  const raw = asObject(value)
  if (!raw) return null

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const mode = parseClaudePermissionMode(raw.mode)
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString()
  const host = typeof raw.host === 'string' && raw.host.trim().length > 0 ? raw.host.trim() : undefined
  const agentType = parseAgentType(raw.agentType)
  const claudeSessionId = typeof raw.claudeSessionId === 'string' && raw.claudeSessionId.trim().length > 0
    ? raw.claudeSessionId.trim()
    : undefined
  const codexThreadId = typeof raw.codexThreadId === 'string' && raw.codexThreadId.trim().length > 0
    ? raw.codexThreadId.trim()
    : undefined
  const systemPrompt = typeof raw.systemPrompt === 'string' && raw.systemPrompt.length > 0
    ? raw.systemPrompt
    : undefined
  const maxTurns = typeof raw.maxTurns === 'number' && raw.maxTurns > 0
    ? raw.maxTurns
    : undefined
  const parentSession = parseSessionName(raw.parentSession) ?? undefined
  const spawnedWorkers = Array.isArray(raw.spawnedWorkers)
    ? Array.from(
      new Set(
        raw.spawnedWorkers
          .map((workerName) => parseSessionName(workerName))
          .filter((workerName): workerName is string => workerName !== null),
      ),
    )
    : undefined
  const parsedConversationEntryCount = Number.parseInt(String(raw.conversationEntryCount ?? ''), 10)
  const conversationEntryCount = Number.isFinite(parsedConversationEntryCount) && parsedConversationEntryCount >= 0
    ? parsedConversationEntryCount
    : undefined

  if (!SESSION_NAME_PATTERN.test(name)) {
    return null
  }
  if (!mode) {
    return null
  }
  if (agentType === 'openclaw') {
    return null
  }
  if (!cwd.startsWith('/')) {
    return null
  }

  const parsedEvents = Array.isArray(raw.events)
    ? (raw.events as unknown[]).filter((e): e is StreamJsonEvent => !!asObject(e))
    : []

  return {
    name,
    mode,
    agentType,
    cwd: path.resolve(cwd),
    host,
    createdAt,
    systemPrompt,
    maxTurns,
    claudeSessionId,
    codexThreadId,
    parentSession,
    spawnedWorkers,
    conversationEntryCount: conversationEntryCount ?? countCompletedTurnEntries(parsedEvents),
    events: parsedEvents,
  }
}

function parsePersistedSessionsState(value: unknown): PersistedSessionsState {
  const raw = asObject(value)
  const source = Array.isArray(raw?.sessions) ? raw.sessions : []
  const sessions = source
    .map((entry) => parsePersistedStreamSessionEntry(entry))
    .filter((entry): entry is PersistedStreamSession => entry !== null)
  return { sessions }
}

async function getCommanderNames(commanderDataDir: string): Promise<Record<string, string>> {
  try {
    const namesPath = resolveCommanderNamesPath(commanderDataDir)
    const raw = await readFile(namesPath, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

async function getCommanderLabels(
  commanderDataDir: string,
  commanderSessionStorePath?: string,
): Promise<Record<string, string>> {
  const labels = await getCommanderNames(commanderDataDir)

  try {
    const commanderStore = commanderSessionStorePath !== undefined
      ? new CommanderSessionStore(commanderSessionStorePath)
      : new CommanderSessionStore()
    const commanderSessions = await commanderStore.list()
    for (const commanderSession of commanderSessions) {
      if (commanderSession.host.trim().length > 0) {
        labels[commanderSession.id] = commanderSession.host
      }
    }
  } catch {
    // Fall back to names.json when the commander session store is unavailable.
  }

  return labels
}

function getWorldAgentRole(sessionName: string): WorldAgentRole {
  return sessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX) ? 'commander' : 'worker'
}

function getCommanderWorldAgentId(commanderId: string): string {
  if (commanderId.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
    return commanderId
  }
  return `${COMMANDER_SESSION_NAME_PREFIX}${commanderId}`
}

function getCommanderWorldAgentStatus(session: CommanderSession): WorldAgentStatus {
  if (session.state === 'running') {
    return 'active'
  }
  return 'idle'
}

function getCommanderWorldAgentPhase(session: CommanderSession): WorldAgentPhase {
  if (session.state === 'running') {
    return 'thinking'
  }
  if (session.state === 'paused') {
    return 'blocked'
  }
  return 'idle'
}

function toCommanderWorldAgent(session: CommanderSession): WorldAgent {
  return {
    id: getCommanderWorldAgentId(session.id),
    agentType: session.agentType === 'codex' ? 'codex' : 'claude',
    sessionType: 'stream',
    status: getCommanderWorldAgentStatus(session),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: session.totalCostUsd,
    },
    task: session.currentTask ? `Issue #${session.currentTask.issueNumber}` : '',
    phase: getCommanderWorldAgentPhase(session),
    lastToolUse: null,
    lastUpdatedAt: session.lastHeartbeat ?? session.created,
    role: 'commander',
    ...(session.channelMeta
      ? {
          channelMeta: {
            provider: session.channelMeta.provider,
            displayName: session.channelMeta.displayName,
            chatType: session.channelMeta.chatType,
          },
        }
      : {}),
  }
}

function buildClaudeStreamArgs(
  mode: ClaudePermissionMode,
  resumeSessionId?: string,
  systemPrompt?: string,
  maxTurns?: number,
): string[] {
  // Claude CLI requires --verbose when using --print (-p) with stream-json output.
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-6']
  if (mode === 'acceptEdits') {
    args.push('--permission-mode', 'acceptEdits')
  } else if (mode === 'dangerouslySkipPermissions') {
    args.push('--dangerously-skip-permissions')
  }
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt)
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  }
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push('--max-turns', String(maxTurns))
  }
  return args
}

function extractClaudeSessionId(event: StreamJsonEvent): string | undefined {
  if (typeof event.session_id === 'string' && event.session_id.trim().length > 0) {
    return event.session_id.trim()
  }
  if (typeof event.sessionId === 'string' && event.sessionId.trim().length > 0) {
    return event.sessionId.trim()
  }
  return undefined
}

function isCommandRoomSessionName(name: string): boolean {
  return name.startsWith(COMMAND_ROOM_SESSION_PREFIX)
}

function isFactorySessionName(name: string): boolean {
  return name.startsWith(FACTORY_SESSION_PREFIX)
}

function isAgentWorkerSessionName(name: string): boolean {
  return name.startsWith(AGENT_SESSION_PREFIX)
}

function isWorkerSessionName(name: string): boolean {
  return isFactorySessionName(name) || isAgentWorkerSessionName(name)
}

function isOneShotStreamSessionName(name: string): boolean {
  return isCommandRoomSessionName(name) || isFactorySessionName(name) || isAgentWorkerSessionName(name)
}

/** Check if a PID is still alive via kill(0). */
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function toCompletedSession(sessionName: string, completedAt: string, event: StreamJsonEvent, costUsd: number): CompletedSession {
  const subtype = typeof event.subtype === 'string' && event.subtype.trim().length > 0
    ? event.subtype
    : 'success'

  return {
    name: sessionName,
    completedAt,
    subtype,
    finalComment: typeof event.result === 'string' ? event.result : '',
    costUsd,
  }
}

/** Build a synthetic completion when no result event was emitted.
 *  Lets cron-triggered command-room sessions complete even if the agent exits
 *  without emitting a result (e.g. crash, AskUserQuestion block, or Codex format). */
function toExitBasedCompletedSession(
  sessionName: string,
  event: StreamJsonEvent & { exitCode?: number; signal?: string; text?: string },
  costUsd: number,
): CompletedSession {
  const code = typeof event.exitCode === 'number' ? event.exitCode : -1
  const signal = typeof event.signal === 'string' ? event.signal : ''
  const text = typeof event.text === 'string' ? event.text : ''
  const subtype = code === 0 ? 'success' : 'failed'
  const finalComment = text || (signal ? `Process exited (signal: ${signal})` : `Process exited with code ${code}`)
  return {
    name: sessionName,
    completedAt: new Date().toISOString(),
    subtype,
    finalComment,
    costUsd,
  }
}

export function createAgentsRouter(options: AgentsRouterOptions = {}): AgentsRouterResult {
  const router = Router()
  const sessions = new Map<string, AnySession>()
  const sessionEventHandlers = new Map<string, Set<(event: StreamJsonEvent) => void>>()
  const debriefStateBySessionName = new Map<string, DebriefState>()
  const completedSessions = new Map<string, CompletedSession>()
  const completedSessionEvents = new Map<string, StreamJsonEvent[]>()
  const exitedStreamSessions = new Map<string, ExitedStreamSessionState>()
  const wss = new WebSocketServer({ noServer: true })
  const maxSessions = parseMaxSessions(options.maxSessions)
  const taskDelayMs = parseTaskDelayMs(options.taskDelayMs)
  const wsKeepAliveIntervalMs = parseWsKeepAliveIntervalMs(options.wsKeepAliveIntervalMs)
  const autoRotateEntryThreshold = parseAutoRotateEntryThreshold(
    options.autoRotateEntryThreshold ?? process.env.AGENTS_AUTO_ROTATE_ENTRY_THRESHOLD,
  )
  const autoResumeSessions = options.autoResumeSessions ?? true
  const sessionStorePath = options.sessionStorePath
    ? path.resolve(options.sessionStorePath)
    : path.resolve(process.cwd(), DEFAULT_SESSION_STORE_PATH)
  const machinesFilePath = options.machinesFilePath
    ? path.resolve(options.machinesFilePath)
    : path.resolve(process.cwd(), 'data/machines.json')
  const completedSessionsStorePath = options.completedSessionsStorePath
    ? path.resolve(options.completedSessionsStorePath)
    : path.resolve(process.cwd(), DEFAULT_COMPLETED_SESSIONS_STORE_PATH)
  const commanderDataDir = options.commanderSessionStorePath !== undefined
    ? path.dirname(path.resolve(options.commanderSessionStorePath))
    : resolveCommanderDataDir()
  const questStore = options.questStore ?? null

  let spawner: PtySpawner | null = options.ptySpawner ?? null
  let cachedMachines: MachineConfig[] | null = null
  let cachedMachinesMtimeMs = -1
  let persistSessionStateQueue = Promise.resolve()
  let persistCompletedSessionsQueue = Promise.resolve()
  const commanderTranscriptWriteQueues = new Map<string, Promise<void>>()
  const autoRotationQueues = new Map<string, Promise<StreamSession | null>>()

  function sanitizeTranscriptFileKey(raw: string): string {
    return raw
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  }

  function appendCommanderTranscriptEvent(session: StreamSession, event: StreamJsonEvent): void {
    if (!session.name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      return
    }

    const commanderId = session.name.slice(COMMANDER_SESSION_NAME_PREFIX.length).trim()
    if (!COMMANDER_PATH_SEGMENT_PATTERN.test(commanderId)) {
      return
    }

    const rawTranscriptId = session.claudeSessionId ?? session.codexThreadId ?? extractClaudeSessionId(event) ?? session.name
    const transcriptId = sanitizeTranscriptFileKey(rawTranscriptId)
    if (!transcriptId) {
      return
    }

    let line: string
    try {
      line = `${JSON.stringify(event)}\n`
    } catch {
      return
    }

    const transcriptPath = path.resolve(
      commanderDataDir,
      commanderId,
      'sessions',
      `${transcriptId}.jsonl`,
    )

    const previous = commanderTranscriptWriteQueues.get(transcriptPath) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(transcriptPath), { recursive: true })
        await appendFile(transcriptPath, line, 'utf8')
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[agents] Failed to append commander transcript "${transcriptPath}": ${message}`)
      })

    commanderTranscriptWriteQueues.set(transcriptPath, next)
    void next.finally(() => {
      if (commanderTranscriptWriteQueues.get(transcriptPath) === next) {
        commanderTranscriptWriteQueues.delete(transcriptPath)
      }
    })
  }

  function resolveWorkerState(workerSessionName: string): WorkerState {
    const active = sessions.get(workerSessionName)
    if (active?.kind === 'stream') {
      if (completedSessions.has(workerSessionName) || active.lastTurnCompleted) {
        return {
          name: workerSessionName,
          status: 'done',
          phase: 'exited',
        }
      }
      const phase: WorkerPhase = active.events.length === 0 ? 'starting' : 'running'
      return {
        name: workerSessionName,
        status: phase === 'starting' ? 'starting' : 'running',
        phase,
      }
    }

    const exited = exitedStreamSessions.get(workerSessionName)
    if (exited) {
      const status = exited.hadResult ? 'done' : 'down'
      // Auto-evict done workers after TTL
      if (status === 'done' && Date.now() - exited.exitedAt > DONE_WORKER_TTL_MS) {
        return { name: workerSessionName, status: 'down', phase: 'exited' }
      }
      return {
        name: workerSessionName,
        status,
        phase: exited.phase,
      }
    }

    if (completedSessions.has(workerSessionName)) {
      const completed = completedSessions.get(workerSessionName)!
      const completedAtMs = Date.parse(completed.completedAt)
      if (Number.isFinite(completedAtMs) && Date.now() - completedAtMs > DONE_WORKER_TTL_MS) {
        return { name: workerSessionName, status: 'down', phase: 'exited' }
      }
      return {
        name: workerSessionName,
        status: 'done',
        phase: 'exited',
      }
    }

    return {
      name: workerSessionName,
      status: 'down',
      phase: 'exited',
    }
  }

  function getWorkerStates(parentSessionName: string): WorkerState[] {
    const workerNames = new Set<string>()
    const parentSession = sessions.get(parentSessionName)
    if (parentSession?.kind === 'stream') {
      for (const workerName of parentSession.spawnedWorkers) {
        workerNames.add(workerName)
      }
    }

    for (const session of sessions.values()) {
      if (session.kind !== 'stream') continue
      if (session.parentSession === parentSessionName) {
        workerNames.add(session.name)
      }
    }

    const workers = [...workerNames]
      .map((workerName) => resolveWorkerState(workerName))
      .filter((worker) => worker.status !== 'down')
    workers.sort((left, right) => left.name.localeCompare(right.name))
    return workers
  }

  async function getSpawner(): Promise<PtySpawner> {
    if (spawner) {
      return spawner
    }

    const nodePty = await import('node-pty')
    spawner = {
      spawn: (file, args, opts) => nodePty.spawn(file, args, opts) as unknown as PtyHandle,
    }
    return spawner
  }

  async function readMachineRegistry(): Promise<MachineConfig[]> {
    let machinesStats: Awaited<ReturnType<typeof stat>>
    try {
      machinesStats = await stat(machinesFilePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        cachedMachines = []
        cachedMachinesMtimeMs = -1
        return []
      }
      throw err
    }

    if (cachedMachines && cachedMachinesMtimeMs === machinesStats.mtimeMs) {
      return cachedMachines
    }

    const contents = await readFile(machinesFilePath, 'utf8')
    const parsed = JSON.parse(contents) as unknown
    const machines = parseMachineRegistry(parsed)
    cachedMachines = machines
    cachedMachinesMtimeMs = machinesStats.mtimeMs
    return machines
  }

  function serializePersistedSessionsState(): PersistedSessionsState {
    const restoredSessions: PersistedStreamSession[] = []
    for (const session of sessions.values()) {
      if (session.kind !== 'stream') continue

      // One-shot sessions (command-room, factory/agent workers) should not be
      // restored after a completed turn because they are terminal jobs.
      if (isOneShotStreamSessionName(session.name) && session.lastTurnCompleted && session.finalResultEvent) continue

      if (session.agentType === 'claude' && (!session.claudeSessionId || !session.lastTurnCompleted)) continue
      if (session.agentType === 'codex' && !session.codexThreadId) continue

      restoredSessions.push({
        name: session.name,
        agentType: session.agentType,
        mode: session.mode,
        cwd: session.cwd,
        host: session.host,
        createdAt: session.createdAt,
        systemPrompt: session.systemPrompt,
        maxTurns: session.maxTurns,
        claudeSessionId: session.claudeSessionId,
        codexThreadId: session.codexThreadId,
        parentSession: session.parentSession,
        spawnedWorkers: session.spawnedWorkers.length > 0 ? [...session.spawnedWorkers] : undefined,
        conversationEntryCount: session.conversationEntryCount,
        events: session.events,
      })
    }

    restoredSessions.sort((left, right) => left.name.localeCompare(right.name))
    return { sessions: restoredSessions }
  }

  async function writePersistedSessionsState(): Promise<void> {
    const payload = serializePersistedSessionsState()
    await mkdir(path.dirname(sessionStorePath), { recursive: true })
    await writeFile(sessionStorePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  function schedulePersistedSessionsWrite(): void {
    persistSessionStateQueue = persistSessionStateQueue
      .catch(() => undefined)
      .then(async () => {
        await writePersistedSessionsState()
      })
  }

  // ── Completed sessions persistence ──────────────────────────────
  async function writeCompletedSessionsState(): Promise<void> {
    const entries = [...completedSessions.values()]
    await mkdir(path.dirname(completedSessionsStorePath), { recursive: true })
    await writeFile(completedSessionsStorePath, JSON.stringify(entries, null, 2), 'utf8')
  }

  function scheduleCompletedSessionsWrite(): void {
    persistCompletedSessionsQueue = persistCompletedSessionsQueue
      .catch(() => undefined)
      .then(async () => {
        await writeCompletedSessionsState()
      })
  }

  async function loadCompletedSessionsState(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(completedSessionsStorePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return
    }

    if (!Array.isArray(parsed)) {
      return
    }

    for (const entry of parsed) {
      if (
        typeof entry === 'object' && entry !== null &&
        typeof (entry as Record<string, unknown>).name === 'string' &&
        typeof (entry as Record<string, unknown>).completedAt === 'string'
      ) {
        const record = entry as CompletedSession
        if (!completedSessions.has(record.name)) {
          completedSessions.set(record.name, record)
        }
      }
    }
  }

  // Load completed sessions from disk on startup.
  loadCompletedSessionsState().catch(() => {
    // Ignore load failures — the map starts empty and will be populated as sessions complete.
  })

  async function readPersistedSessionsState(): Promise<PersistedSessionsState> {
    let raw: string
    try {
      raw = await readFile(sessionStorePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: [] }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return { sessions: [] }
    }

    return parsePersistedSessionsState(parsed)
  }

  function pruneStaleCommandRoomSessions(nowMs = Date.now()): void {
    let changed = false

    for (const [sessionName, session] of sessions) {
      if (session.kind !== 'stream') continue
      if (!isCommandRoomSessionName(sessionName)) continue
      const completionReferenceAt = session.lastTurnCompleted
        ? (session.completedTurnAt ?? session.createdAt)
        : session.createdAt
      const completionReferenceMs = Date.parse(completionReferenceAt)
      if (!Number.isFinite(completionReferenceMs)) continue
      if (nowMs - completionReferenceMs <= COMMAND_ROOM_STALE_SESSION_TTL_MS) continue

      // Defense-in-depth: command-room stream sessions are one-shot jobs.
      // Reap them after stale TTL whether or not they emitted a terminal
      // result event, and persist a completion record first.
      if (!completedSessions.has(sessionName)) {
        if (session.finalResultEvent) {
          completedSessions.set(
            sessionName,
            toCompletedSession(
              sessionName,
              session.completedTurnAt ?? new Date().toISOString(),
              session.finalResultEvent,
              session.usage.costUsd,
            ),
          )
        } else {
          const staleEvent: StreamJsonEvent = {
            type: 'exit',
            exitCode: -1,
            text: 'Command-room session exceeded stale-session TTL before emitting a final result event',
          }
          completedSessions.set(
            sessionName,
            toExitBasedCompletedSession(sessionName, staleEvent, session.usage.costUsd),
          )
        }
      }
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }
      session.process.kill('SIGTERM')
      sessions.delete(sessionName)
      changed = true
    }

    if (changed) {
      schedulePersistedSessionsWrite()
    }
  }

  function appendToBuffer(session: PtySession, data: string): void {
    session.buffer += data
    if (session.buffer.length > MAX_BUFFER_BYTES) {
      const dropped = session.buffer.length - MAX_BUFFER_BYTES
      session.buffer = session.buffer.slice(-MAX_BUFFER_BYTES)
      session.bufferBytesDropped += dropped
    }
  }

  function broadcastOutput(session: PtySession, data: string): void {
    const payload = Buffer.from(data)
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, { binary: true })
      }
    }
  }

  function resolveLastUpdatedAt(session: AnySession): string {
    if (session.lastEventAt && Number.isFinite(Date.parse(session.lastEventAt))) {
      return session.lastEventAt
    }
    return session.createdAt
  }

  function isCompletedOneShotStreamSession(session: StreamSession): boolean {
    return isOneShotStreamSessionName(session.name) && (
      completedSessions.has(session.name)
      || (session.lastTurnCompleted && Boolean(session.finalResultEvent))
    )
  }

  function countTrackedSessions(): number {
    let count = 0
    for (const session of sessions.values()) {
      if (session.kind === 'stream' && isCompletedOneShotStreamSession(session)) {
        continue
      }
      count += 1
    }
    return count
  }

  function getWorldAgentStatus(session: AnySession, nowMs: number): WorldAgentStatus {
    if (session.kind === 'stream' && session.lastTurnCompleted && session.completedTurnAt) {
      // Commanders are long-lived; turn completion ≠ session completion
      if (!session.name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        return 'completed'
      }
    }

    const lastUpdatedAt = resolveLastUpdatedAt(session)
    const ageMs = nowMs - Date.parse(lastUpdatedAt)
    if (!Number.isFinite(ageMs) || ageMs < 60_000) {
      return 'active'
    }
    if (ageMs <= 5 * 60_000) {
      return 'idle'
    }
    return 'stale'
  }

  function getToolUses(event: StreamJsonEvent): Array<{ id: string | null; name: string }> {
    const uses: Array<{ id: string | null; name: string }> = []
    const addToolUse = (rawBlock: unknown) => {
      const block = asObject(rawBlock)
      if (!block || block.type !== 'tool_use') {
        return
      }
      if (typeof block.name !== 'string' || block.name.trim().length === 0) {
        return
      }
      const id = typeof block.id === 'string' && block.id.trim().length > 0
        ? block.id.trim()
        : null
      uses.push({ id, name: block.name.trim() })
    }

    if (event.type === 'tool_use') {
      const directName = typeof event.name === 'string' ? event.name.trim() : ''
      if (directName.length > 0) {
        const directId = typeof event.id === 'string' && event.id.trim().length > 0
          ? event.id.trim()
          : null
        uses.push({ id: directId, name: directName })
      }
    }

    addToolUse(event.content_block)

    const message = asObject(event.message)
    if (Array.isArray(message?.content)) {
      for (const item of message.content) {
        addToolUse(item)
      }
    }

    return uses
  }

  function getToolResultIds(event: StreamJsonEvent): string[] {
    const ids: string[] = []
    const addToolResult = (rawBlock: unknown) => {
      const block = asObject(rawBlock)
      if (!block || block.type !== 'tool_result') {
        return
      }
      if (typeof block.tool_use_id !== 'string' || block.tool_use_id.trim().length === 0) {
        return
      }
      ids.push(block.tool_use_id.trim())
    }

    if (event.type === 'tool_result' && typeof event.tool_use_id === 'string' && event.tool_use_id.trim().length > 0) {
      ids.push(event.tool_use_id.trim())
    }

    addToolResult(event.content_block)

    const message = asObject(event.message)
    if (Array.isArray(message?.content)) {
      for (const item of message.content) {
        addToolResult(item)
      }
    }

    return ids
  }

  function getLastToolUse(session: StreamSession | OpenClawSession): string | null {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const toolUses = getToolUses(session.events[i])
      for (let j = toolUses.length - 1; j >= 0; j -= 1) {
        return toolUses[j].name
      }
    }
    return null
  }

  function hasPendingAskUserQuestion(session: StreamSession | OpenClawSession): boolean {
    const answeredToolIds = new Set<string>()
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const event = session.events[i]
      for (const toolResultId of getToolResultIds(event)) {
        answeredToolIds.add(toolResultId)
      }

      const toolUses = getToolUses(event)
      for (let j = toolUses.length - 1; j >= 0; j -= 1) {
        const toolUse = toolUses[j]
        if (toolUse.name !== 'AskUserQuestion') {
          continue
        }
        if (!toolUse.id) {
          return true
        }
        if (!answeredToolIds.has(toolUse.id)) {
          return true
        }
      }
    }
    return false
  }

  function getWorldAgentPhase(session: AnySession): WorldAgentPhase {
    if (session.kind === 'pty') return 'idle'

    if (session.kind === 'stream' && session.lastTurnCompleted && session.completedTurnAt) {
      // Commanders are long-lived; turn completion ≠ session completion
      if (!session.name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        return 'completed'
      }
    }

    if (hasPendingAskUserQuestion(session)) {
      return 'blocked'
    }

    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const event = session.events[i]
      const toolUses = getToolUses(event)
      if (toolUses.length > 0) {
        return 'tool_use'
      }

      if (getToolResultIds(event).length > 0) {
        return 'thinking'
      }

      if (
        event.type === 'message_start' ||
        event.type === 'assistant' ||
        event.type === 'message_delta' ||
        event.type === 'content_block_start' ||
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop' ||
        event.type === 'user'
      ) {
        return 'thinking'
      }
    }

    return 'idle'
  }

  function getWorldAgentUsage(session: AnySession): {
    inputTokens: number
    outputTokens: number
    costUsd: number
  } {
    if (session.kind === 'stream') {
      return session.usage
    }
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  }

  function getWorldAgentTask(session: AnySession): string {
    if (typeof session.task === 'string') {
      return session.task
    }
    return ''
  }

  function toWorldAgent(session: AnySession, nowMs: number): WorldAgent {
    return {
      id: session.name,
      agentType: session.agentType,
      sessionType: session.kind === 'pty' ? 'pty' : 'stream',
      status: getWorldAgentStatus(session, nowMs),
      usage: getWorldAgentUsage(session),
      task: getWorldAgentTask(session),
      phase: getWorldAgentPhase(session),
      lastToolUse: session.kind === 'pty' ? null : getLastToolUse(session),
      lastUpdatedAt: resolveLastUpdatedAt(session),
      role: getWorldAgentRole(session.name),
    }
  }

  function attachWebSocketKeepAlive(
    ws: WebSocket,
    onStale: () => void,
  ): () => void {
    let waitingForPong = false
    let stopped = false

    const stop = () => {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(interval)
      ws.off('pong', onPong)
      ws.off('close', onCloseOrError)
      ws.off('error', onCloseOrError)
    }

    const onPong = () => {
      waitingForPong = false
    }

    const onCloseOrError = () => {
      stop()
    }

    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }

      if (waitingForPong) {
        onStale()
        ws.terminate()
        stop()
        return
      }

      waitingForPong = true
      ws.ping()
    }, wsKeepAliveIntervalMs)

    ws.on('pong', onPong)
    ws.on('close', onCloseOrError)
    ws.on('error', onCloseOrError)

    return stop
  }

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })
  // dispatch-worker calls bootstrapFactoryWorktree — requires factory scope in addition to agents scope
  const requireDispatchWorkerAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write', 'factory:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    internalToken: options.internalToken,
  })

  function sendWorkspaceError(
    res: Response,
    error: unknown,
  ): void {
    const workspaceError = toWorkspaceError(error)
    res.status(workspaceError.statusCode).json({ error: workspaceError.message })
  }

  async function resolveAgentWorkspace(
    rawSessionName: unknown,
  ) {
    const sessionName = parseSessionName(rawSessionName)
    if (!sessionName) {
      throw new WorkspaceError(400, 'Invalid session name')
    }

    const session = sessions.get(sessionName)
    if (!session) {
      throw new WorkspaceError(404, `Session "${sessionName}" not found`)
    }

    return resolveWorkspaceRoot({
      rootPath: session.cwd,
      source: {
        kind: 'agent-session',
        id: session.name,
        label: session.name,
        host: session.host,
      },
    })
  }

  router.get('/directories', requireReadAccess, async (req, res) => {
    const rawPath = req.query.path
    const rawHost = req.query.host

    // Remote host: SSH to list directories
    if (typeof rawHost === 'string' && rawHost.trim().length > 0) {
      try {
        const machines = await readMachineRegistry()
        const machine = machines.find((m) => m.id === rawHost.trim())
        if (!machine || !isRemoteMachine(machine)) {
          res.status(400).json({ error: 'Unknown or local machine' })
          return
        }

        // List directories on the remote host via SSH
        const targetPath = typeof rawPath === 'string' && rawPath.trim().startsWith('/')
          ? shellEscape(rawPath.trim())
          : '"$HOME"'
        const remoteScript = [
          `cd ${targetPath} 2>/dev/null || exit 1`,
          'echo "$PWD"',
          'find . -maxdepth 1 -mindepth 1 -type d ! -name ".*" | sort | while read -r d; do echo "$PWD/${d#./}"; done',
        ].join('; ')
        const sshArgs = buildSshArgs(machine, remoteScript, false)

        const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
          const procEmitter = proc as unknown as NodeJS.EventEmitter
          procEmitter.on('close', (code: number | null) => { resolve({ stdout, stderr, code: code ?? 1 }) })
          setTimeout(() => { proc.kill(); resolve({ stdout: '', stderr: 'timeout', code: 1 }) }, 10000)
        })

        if (result.code !== 0) {
          res.status(400).json({ error: result.stderr.trim() || 'Cannot read directory' })
          return
        }

        const lines = result.stdout.trim().split('\n').filter(Boolean)
        const parent = lines[0] ?? '~'
        const directories = lines.slice(1)

        res.json({ parent, directories })
      } catch {
        res.status(400).json({ error: 'Cannot read remote directory' })
      }
      return
    }

    // Local directory listing
    const homeBase = homedir()
    let targetDir: string

    if (typeof rawPath === 'string' && rawPath.trim().startsWith('/')) {
      targetDir = path.resolve(rawPath.trim())
    } else {
      targetDir = homeBase
    }

    // Confine browsing to the user's home directory
    if (!targetDir.startsWith(homeBase + '/') && targetDir !== homeBase) {
      res.status(403).json({ error: 'Path must be within the home directory' })
      return
    }

    try {
      const entries = await readdir(targetDir, { withFileTypes: true })
      const directories: string[] = []

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const fullPath = path.join(targetDir, entry.name)

        directories.push(fullPath)
      }

      directories.sort((a, b) => a.localeCompare(b))

      res.json({ parent: targetDir, directories })
    } catch {
      res.status(400).json({ error: 'Cannot read directory' })
    }
  })

  router.get('/skills', requireReadAccess, async (_req, res) => {
    const skillsDirs = [
      path.join(homedir(), '.claude', 'skills'),
      path.join(homedir(), '.codex', 'skills'),
      path.join(homedir(), '.openclaw', 'skills'),
    ]
    const seen = new Set<string>()
    const skills: Array<{ name: string; description: string; userInvocable: boolean; argumentHint?: string }> = []

    for (const skillsDir of skillsDirs) {
      let entries
      try {
        entries = await readdir(skillsDir, { withFileTypes: true })
      } catch {
        continue // directory doesn't exist — skip
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md')
        try {
          const content = await readFile(skillMd, 'utf-8')
          const fm = parseFrontmatter(content)
          if (fm['user-invocable'] === true || fm['user-invocable'] === 'true') {
            seen.add(entry.name)
            skills.push({
              name: (typeof fm.name === 'string' ? fm.name : entry.name),
              description: typeof fm.description === 'string' ? fm.description : '',
              userInvocable: true,
              argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined,
            })
          }
        } catch {
          // Skip skills without valid SKILL.md
        }
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name))
    res.json(skills)
  })

  router.get('/openclaw/agents', requireReadAccess, async (_req, res) => {
    try {
      const response = await fetch(`${DEFAULT_OPENCLAW_GATEWAY_URL}/agents`)
      if (!response.ok) {
        res.json({ agents: [{ id: 'main' }] })
        return
      }
      const data = await response.json() as unknown
      res.json(data)
    } catch {
      res.json({ agents: [{ id: 'main' }] })
    }
  })

  router.get('/openclaw/gateway-info', requireReadAccess, async (_req, res) => {
    const url = DEFAULT_OPENCLAW_GATEWAY_URL
    const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
    const authEnabled = Boolean(token)
    const headers: Record<string, string> = {}
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    let reachable = false
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), 2000)

    try {
      const response = await fetch(`${url}/agents`, {
        headers,
        signal: controller.signal,
      })
      reachable = response.ok || response.status === 401
    } catch {
      reachable = false
    } finally {
      clearTimeout(timeoutHandle)
    }

    res.json({ url, authEnabled, reachable })
  })

  router.get('/files', requireReadAccess, async (req, res) => {
    const rawPath = req.query.path
    const homeBase = homedir()
    let targetDir: string

    if (typeof rawPath === 'string' && rawPath.trim().startsWith('/')) {
      targetDir = path.resolve(rawPath.trim())
    } else {
      targetDir = homeBase
    }

    if (!targetDir.startsWith(homeBase + '/') && targetDir !== homeBase) {
      res.status(403).json({ error: 'Path must be within the home directory' })
      return
    }

    try {
      const entries = await readdir(targetDir, { withFileTypes: true })
      const files: Array<{ name: string; isDirectory: boolean }> = []

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isSymbolicLink()) continue
        files.push({ name: entry.name, isDirectory: entry.isDirectory() })
      }

      files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      res.json({ path: targetDir, files })
    } catch {
      res.status(400).json({ error: 'Cannot read directory' })
    }
  })

  router.post('/upload', requireWriteAccess, async (req, res) => {
    const rawCwd = req.query.cwd
    if (typeof rawCwd !== 'string' || !rawCwd.startsWith('/')) {
      res.status(400).json({ error: 'cwd query parameter required (absolute path)' })
      return
    }

    let targetDir: string
    try {
      targetDir = await realpath(path.resolve(rawCwd as string))
    } catch {
      res.status(400).json({ error: 'Upload path does not exist' })
      return
    }
    const homeBase = homedir()
    if (!targetDir.startsWith(homeBase + '/') && targetDir !== homeBase) {
      res.status(403).json({ error: 'Upload path must be within the home directory' })
      return
    }

    const dynamicUpload = multer({
      storage: multer.diskStorage({
        destination: (_r, _f, cb) => cb(null, targetDir),
        filename: (_r, file, cb) => {
          if (!FILE_NAME_PATTERN.test(file.originalname)) {
            cb(new Error('Invalid filename'), '')
            return
          }
          cb(null, file.originalname)
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    })

    dynamicUpload.array('files', 5)(req, res, (err) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Upload failed'
        res.status(400).json({ error: message })
        return
      }

      const uploaded = (req.files as Express.Multer.File[])?.map(f => f.filename) ?? []
      res.json({ uploaded, path: targetDir })
    })
  })

  router.get('/sessions/:name/workspace/tree', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const tree = await listWorkspaceTree(
        workspace,
        typeof req.query.path === 'string' ? req.query.path : '',
      )
      res.json(tree)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/expand', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const tree = await listWorkspaceTree(
        workspace,
        typeof req.query.path === 'string' ? req.query.path : '',
      )
      res.json(tree)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/file', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        throw new WorkspaceError(400, 'path query parameter is required')
      }
      const preview = await readWorkspaceFilePreview(workspace, req.query.path)
      res.json(preview)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.put('/sessions/:name/workspace/file', requireWriteAccess, async (req, res) => {
    try {
      if (typeof req.body?.path !== 'string' || !req.body.path.trim()) {
        throw new WorkspaceError(400, 'path is required')
      }
      if (typeof req.body?.content !== 'string') {
        throw new WorkspaceError(400, 'content must be a string')
      }
      const workspace = await resolveAgentWorkspace(req.params.name)
      const result = await saveWorkspaceTextFile(workspace, req.body.path, req.body.content)
      res.json(result)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/download', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        throw new WorkspaceError(400, 'path query parameter is required')
      }
      const { absolutePath } = await resolveWorkspacePath(workspace, req.query.path, {
        expectFile: true,
      })
      res.download(absolutePath)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/sessions/:name/workspace/upload', requireWriteAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const destination = await resolveWorkspaceUploadDestination(
        workspace,
        typeof req.query.path === 'string' ? req.query.path : '',
      )
      const upload = createWorkspaceUploadMiddleware(destination.absolutePath)
      upload.array('files', 5)(req, res, (error) => {
        if (error) {
          sendWorkspaceError(res, error)
          return
        }

        const uploaded = (req.files as Express.Multer.File[] | undefined)?.map((file) => file.filename) ?? []
        res.json({
          workspace,
          path: destination.relativePath,
          uploaded,
        })
      })
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/sessions/:name/workspace/new-file', requireWriteAccess, async (req, res) => {
    try {
      if (typeof req.body?.path !== 'string' || !req.body.path.trim()) {
        throw new WorkspaceError(400, 'path is required')
      }
      const workspace = await resolveAgentWorkspace(req.params.name)
      const result = await createWorkspaceFile(workspace, req.body.path)
      res.status(201).json(result)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/sessions/:name/workspace/new-folder', requireWriteAccess, async (req, res) => {
    try {
      if (typeof req.body?.path !== 'string' || !req.body.path.trim()) {
        throw new WorkspaceError(400, 'path is required')
      }
      const workspace = await resolveAgentWorkspace(req.params.name)
      const result = await createWorkspaceFolder(workspace, req.body.path)
      res.status(201).json(result)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/sessions/:name/workspace/rename', requireWriteAccess, async (req, res) => {
    try {
      if (typeof req.body?.fromPath !== 'string' || !req.body.fromPath.trim()) {
        throw new WorkspaceError(400, 'fromPath is required')
      }
      if (typeof req.body?.toPath !== 'string' || !req.body.toPath.trim()) {
        throw new WorkspaceError(400, 'toPath is required')
      }
      const workspace = await resolveAgentWorkspace(req.params.name)
      const result = await renameWorkspaceEntry(workspace, req.body.fromPath, req.body.toPath)
      res.json(result)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.delete('/sessions/:name/workspace/path', requireWriteAccess, async (req, res) => {
    try {
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        throw new WorkspaceError(400, 'path query parameter is required')
      }
      const workspace = await resolveAgentWorkspace(req.params.name)
      const result = await deleteWorkspaceEntry(workspace, req.query.path)
      res.json(result)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/git/status', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const status = await readWorkspaceGitStatus(workspace)
      res.json(status)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/git/log', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15
      const log = await readWorkspaceGitLog(workspace, Number.isFinite(limit) ? limit : 15)
      res.json(log)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.post('/sessions/:name/workspace/git/init', requireWriteAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentWorkspace(req.params.name)
      const output = await initWorkspaceGit(workspace)
      res.status(201).json({ workspace, output })
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/machines', requireReadAccess, async (_req, res) => {
    try {
      const machines = await readMachineRegistry()
      res.json(machines)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read machines registry'
      res.status(500).json({ error: message })
    }
  })

  router.get('/world', requireReadAccess, async (_req, res) => {
    pruneStaleCommandRoomSessions()

    const nowMs = Date.now()
    const worldAgentsById = new Map<string, WorldAgent>()
    for (const session of sessions.values()) {
      if (session.kind === 'stream' && isCompletedOneShotStreamSession(session)) {
        continue
      }
      const worldAgent = toWorldAgent(session, nowMs)
      worldAgentsById.set(worldAgent.id, worldAgent)
    }

    try {
      const commanderStore = options.commanderSessionStorePath !== undefined
        ? new CommanderSessionStore(options.commanderSessionStorePath)
        : new CommanderSessionStore()
      const commanderSessions = await commanderStore.list()
      for (const commanderSession of commanderSessions) {
        if (commanderSession.state === 'stopped') {
          continue
        }
        const worldAgent = toCommanderWorldAgent(commanderSession)
        if (!worldAgentsById.has(worldAgent.id)) {
          worldAgentsById.set(worldAgent.id, worldAgent)
        }
      }
    } catch {
      // Ignore commander store failures and fall back to live agent sessions.
    }

    res.json([...worldAgentsById.values()])
  })

  router.post('/sessions/dispatch-worker', requireDispatchWorkerAccess, async (req, res) => {
    const parentSessionName = parseSessionName(req.body?.parentSession)
    if (!parentSessionName) {
      res.status(400).json({ error: 'Invalid parentSession' })
      return
    }

    const parentSession = sessions.get(parentSessionName)
    if (!parentSession || parentSession.kind !== 'stream') {
      res.status(404).json({ error: `Stream parent session "${parentSessionName}" not found` })
      return
    }

    const workerType = parseDispatchWorkerType(req.body?.workerType)
    if (workerType === null) {
      res.status(400).json({ error: 'Invalid workerType. Expected "factory" or "agent"' })
      return
    }

    const requestedMachine = parseOptionalHost(req.body?.machine)
    if (requestedMachine === null) {
      res.status(400).json({ error: 'Invalid machine: expected machine ID string' })
      return
    }

    if (countTrackedSessions() >= maxSessions) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    const targetMachineId = requestedMachine ?? parentSession.host
    let targetMachine: MachineConfig | undefined
    if (targetMachineId !== undefined) {
      try {
        const machines = await readMachineRegistry()
        targetMachine = machines.find((entry) => entry.id === targetMachineId)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to read machines registry'
        res.status(500).json({ error: message })
        return
      }

      if (!targetMachine) {
        res.status(400).json({ error: `Unknown host machine "${targetMachineId}"` })
        return
      }
    }

    const parsedIssueUrl = parseGitHubIssueUrl(req.body?.issueUrl)
    if (parsedIssueUrl === null) {
      res.status(400).json({ error: 'Invalid issueUrl. Expected a GitHub issue URL' })
      return
    }

    const rawTask = typeof req.body?.task === 'string' ? req.body.task.trim() : ''
    const prefab = req.body?.prefab === 'legion-implement' ? 'legion-implement' : null

    const parsedBranch = parseFactoryBranch(req.body?.branch)
    if (parsedBranch === null) {
      res.status(400).json({ error: 'Invalid branch. Use letters, numbers, underscores, or dashes' })
      return
    }

    const requestedCwd = parseCwd(req.body?.cwd)
    if (requestedCwd === null) {
      res.status(400).json({ error: 'Invalid cwd: must be an absolute path' })
      return
    }
    const sourceCwd = requestedCwd
      ?? (targetMachine ? targetMachine.cwd : undefined)
      ?? parentSession.cwd
    const branch = workerType === 'factory'
      ? (parsedBranch ?? (parsedIssueUrl ? `feat-${parsedIssueUrl.issueNumber}` : undefined))
      : undefined
    if (workerType === 'factory' && !branch) {
      res.status(400).json({ error: 'Provide branch or issueUrl' })
      return
    }

    let resolvedTask = rawTask
    if (prefab === 'legion-implement' && parsedIssueUrl) {
      const issueUrl = `https://github.com/${parsedIssueUrl.owner}/${parsedIssueUrl.repo}/issues/${parsedIssueUrl.issueNumber}`
      resolvedTask = `/legion-implement ${issueUrl}${rawTask ? `\n\n${rawTask}` : ''}`
    }

    const timestamp = Date.now()
    const sessionNameBase = workerType === 'agent'
      ? `${AGENT_SESSION_PREFIX}${timestamp}`
      : `${FACTORY_SESSION_PREFIX}${branch}-${timestamp}`
    let workerSessionName = sessionNameBase
    let suffix = 1
    while (sessions.has(workerSessionName)) {
      workerSessionName = `${sessionNameBase}-${suffix}`
      suffix += 1
    }

    try {
      const requestedAgentType = req.body?.agentType
      const workerAgentType: 'claude' | 'codex' = requestedAgentType === 'codex'
        ? 'codex'
        : requestedAgentType === 'claude'
          ? 'claude'
          : parentSession.agentType === 'codex'
            ? 'codex'
            : 'claude'

      let workerSession: StreamSession
      const responsePayload: {
        name: string
        branch?: string
        worktree?: string
        cwd?: string
        workerType: 'factory' | 'agent'
      } = {
        name: workerSessionName,
        workerType,
      }

      if (workerType === 'agent') {
        workerSession = workerAgentType === 'codex'
          ? await createCodexAppServerSession(
            workerSessionName,
            parentSession.mode,
            resolvedTask,
            sourceCwd,
            { parentSession: parentSessionName },
          )
          : createStreamSession(
            workerSessionName,
            parentSession.mode,
            resolvedTask,
            sourceCwd,
            targetMachine,
            workerAgentType,
            { parentSession: parentSessionName },
          )
        responsePayload.cwd = sourceCwd
      } else {
        const factoryBranch = branch
        if (!factoryBranch) {
          res.status(400).json({ error: 'Provide branch or issueUrl' })
          return
        }

        const repoFromIssue = parsedIssueUrl
          ? { owner: parsedIssueUrl.owner, repo: parsedIssueUrl.repo }
          : null
        const repo = repoFromIssue ?? await resolveGitHubRepoFromCwd(sourceCwd)
        if (!repo) {
          res.status(400).json({
            error: 'Unable to resolve GitHub owner/repo. Provide issueUrl or use a git repo cwd.',
          })
          return
        }

        const worktree = await bootstrapFactoryWorktree({
          owner: repo.owner,
          repo: repo.repo,
          feature: factoryBranch,
          machine: targetMachine,
        })

        // Write a Claude Code Stop hook into the worktree so that when the
        // agent finishes, it POSTs to the hammurabi API to mark the session
        // as completed.  This is the primary completion signal.
        try {
          const hookApiBase = process.env.HAMBROS_API_URL?.trim() || `http://127.0.0.1:${process.env.PORT || '4200'}`
          const hookApiKey = process.env.HAMBROS_INTERNAL_TOKEN?.trim() || ''
          const hookUrl = `${hookApiBase}/api/agents/sessions/${encodeURIComponent(workerSessionName)}/complete`
          const curlCmd = [
            'curl -s -X POST',
            `-H "Content-Type: application/json"`,
            hookApiKey ? `-H "x-hammurabi-api-key: ${hookApiKey}"` : '',
            `-d '{"status":"success","comment":"Stop hook fired"}'`,
            `"${hookUrl}"`,
          ].filter(Boolean).join(' ')
          const hookSettings = {
            hooks: {
              Stop: [
                {
                  matcher: '',
                  hooks: [
                    {
                      type: 'command',
                      command: `bash -c '${curlCmd.replace(/'/g, `'\\''`)}'`,
                    },
                  ],
                },
              ],
            },
          }
          const claudeDir = path.join(worktree.path, '.claude')
          await mkdir(claudeDir, { recursive: true })
          await writeFile(
            path.join(claudeDir, 'settings.local.json'),
            JSON.stringify(hookSettings, null, 2),
            'utf8',
          )
        } catch {
          // Non-fatal — PID liveness and exit handler are fallbacks.
        }

        workerSession = workerAgentType === 'codex'
          ? await createCodexAppServerSession(
            workerSessionName,
            parentSession.mode,
            resolvedTask,
            worktree.path,
            { parentSession: parentSessionName },
          )
          : createStreamSession(
            workerSessionName,
            parentSession.mode,
            resolvedTask,
            worktree.path,
            targetMachine,
            workerAgentType,
            { parentSession: parentSessionName },
          )
        responsePayload.branch = worktree.branch
        responsePayload.worktree = worktree.path
      }

      sessions.set(workerSessionName, workerSession)
      if (!parentSession.spawnedWorkers.includes(workerSessionName)) {
        parentSession.spawnedWorkers.push(workerSessionName)
      }
      schedulePersistedSessionsWrite()

      // Transition matching quests from pending → active when a worker is dispatched.
      if (questStore && parsedIssueUrl && parentSessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        const commanderId = parentSessionName.slice(COMMANDER_SESSION_NAME_PREFIX.length)
        const issueUrl = `https://github.com/${parsedIssueUrl.owner}/${parsedIssueUrl.repo}/issues/${parsedIssueUrl.issueNumber}`
        questStore.list(commanderId).then((quests) => {
          for (const quest of quests) {
            if (quest.status === 'pending' && quest.githubIssueUrl === issueUrl) {
              questStore.update(commanderId, quest.id, { status: 'active' }).catch(() => {
                // Non-fatal — quest status is a UX improvement, not a hard requirement.
              })
            }
          }
        }).catch(() => {
          // Non-fatal — quest store may not be available.
        })
      }

      res.status(202).json(responsePayload)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to dispatch worker'
      if (message.includes('already exists')) {
        res.status(409).json({ error: message })
        return
      }
      res.status(500).json({ error: message })
    }
  })

  router.get('/sessions/:name/workers', requireReadAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const parentSession = sessions.get(sessionName)
    if (!parentSession || parentSession.kind !== 'stream') {
      res.status(404).json({ error: `Stream session "${sessionName}" not found` })
      return
    }

    res.json(getWorkerStates(sessionName))
  })

  // ── Factory worker completion hook endpoint ─────────────────────
  // Called by Claude Code Stop hook (or externally) to mark a factory
  // worker session as completed.
  router.post('/sessions/:name/complete', requireWriteAccess, (req, res) => {
    const name = parseSessionName(req.params.name)
    if (!name) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    // Already completed — idempotent success.
    if (completedSessions.has(name)) {
      res.json({ name, completed: true, status: completedSessions.get(name)!.subtype })
      return
    }

    const rawStatus = typeof req.body?.status === 'string' ? req.body.status.trim() : 'success'
    const rawComment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : ''
    const rawCostUsd = typeof req.body?.costUsd === 'number' ? req.body.costUsd : 0

    const active = sessions.get(name)
    if (active && active.kind === 'stream') {
      const completed: CompletedSession = {
        name,
        completedAt: new Date().toISOString(),
        subtype: rawStatus || 'success',
        finalComment: rawComment,
        costUsd: rawCostUsd || active.usage.costUsd,
      }
      completedSessions.set(name, completed)
      scheduleCompletedSessionsWrite()
      exitedStreamSessions.set(name, { phase: 'exited', hadResult: true, exitedAt: Date.now() })

      // Kill the process if still alive so exit handler fires cleanup.
      const pid = active.process.pid ?? 0
      if (pid > 0 && isPidAlive(pid)) {
        active.process.kill('SIGTERM')
      }

      res.json({ name, completed: true, status: completed.subtype })
      return
    }

    // Session not in active map — create completion entry from request body.
    const completed: CompletedSession = {
      name,
      completedAt: new Date().toISOString(),
      subtype: rawStatus || 'success',
      finalComment: rawComment,
      costUsd: rawCostUsd,
    }
    completedSessions.set(name, completed)
    scheduleCompletedSessionsWrite()
    exitedStreamSessions.set(name, { phase: 'exited', hadResult: true, exitedAt: Date.now() })
    res.json({ name, completed: true, status: completed.subtype })
  })

  router.delete('/sessions/:name/workers/done', requireWriteAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const parentSession = sessions.get(sessionName)
    if (!parentSession || parentSession.kind !== 'stream') {
      res.status(404).json({ error: `Stream session "${sessionName}" not found` })
      return
    }

    // Identify done workers and remove them
    const doneWorkers: string[] = []
    for (const workerName of parentSession.spawnedWorkers) {
      const state = resolveWorkerState(workerName)
      if (state.status === 'done' || state.status === 'down') {
        doneWorkers.push(workerName)
      }
    }

    parentSession.spawnedWorkers = parentSession.spawnedWorkers.filter(
      (name) => !doneWorkers.includes(name),
    )
    for (const workerName of doneWorkers) {
      sessions.delete(workerName)
      completedSessions.delete(workerName)
      exitedStreamSessions.delete(workerName)
    }

    if (doneWorkers.length > 0) {
      schedulePersistedSessionsWrite()
    }

    res.json({
      cleared: doneWorkers.length,
      workers: getWorkerStates(sessionName),
    })
  })

  router.get('/sessions/:name', requireReadAccess, (req, res) => {
    pruneStaleCommandRoomSessions()

    const name = parseSessionName(req.params.name)
    if (!name) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const active = sessions.get(name)
    if (active) {
      if (
        active.kind === 'stream' &&
        isCompletedOneShotStreamSession(active)
      ) {
        const completed = completedSessions.get(name) ?? toCompletedSession(
          name,
          active.completedTurnAt ?? new Date().toISOString(),
          active.finalResultEvent!,
          active.usage.costUsd,
        )
        completedSessions.set(name, completed)
        res.json({
          name,
          completed: true,
          status: completed.subtype,
          result: {
            status: completed.subtype,
            finalComment: completed.finalComment,
            costUsd: completed.costUsd,
            completedAt: completed.completedAt,
          },
        })
        return
      }

      // PID liveness fallback: if a worker's PID is dead but the process
      // exit handler hasn't fired yet, synthesize completion now.
      if (active.kind === 'stream' && isWorkerSessionName(name)) {
        const workerPid = active.process.pid ?? 0
        if (workerPid > 0 && !isPidAlive(workerPid)) {
          const exitEvent: StreamJsonEvent = { type: 'exit', exitCode: -1, text: 'Process not found (PID liveness check)' }
          const completed = active.finalResultEvent
            ? toCompletedSession(name, active.completedTurnAt ?? new Date().toISOString(), active.finalResultEvent, active.usage.costUsd)
            : toExitBasedCompletedSession(name, exitEvent, active.usage.costUsd)
          completedSessions.set(name, completed)
          scheduleCompletedSessionsWrite()
          exitedStreamSessions.set(name, { phase: 'exited', hadResult: Boolean(active.finalResultEvent), exitedAt: Date.now() })
          sessions.delete(name)
          schedulePersistedSessionsWrite()
          res.json({
            name,
            completed: true,
            status: completed.subtype,
            result: {
              status: completed.subtype,
              finalComment: completed.finalComment,
              costUsd: completed.costUsd,
              completedAt: completed.completedAt,
            },
          })
          return
        }
      }

      const pid = active.kind === 'pty'
        ? active.pty.pid
        : (active.kind === 'stream' ? (active.process.pid ?? 0) : 0)
      const workerStates = active.kind === 'stream' ? getWorkerStates(name) : []
      res.json({
        name,
        completed: false,
        status: 'running',
        pid,
        sessionType: active.kind === 'pty' ? 'pty' : 'stream',
        agentType: active.agentType,
        cwd: active.cwd,
        host: active.host,
        parentSession: active.kind === 'stream' ? active.parentSession : undefined,
        spawnedWorkers: active.kind === 'stream' ? [...active.spawnedWorkers] : undefined,
        workerSummary: active.kind === 'stream' ? summarizeWorkerStates(workerStates) : undefined,
      })
      return
    }

    const completed = completedSessions.get(name)
    if (completed) {
      res.json({
        name,
        completed: true,
        status: completed.subtype,
        result: {
          status: completed.subtype,
          finalComment: completed.finalComment,
          costUsd: completed.costUsd,
          completedAt: completed.completedAt,
        },
      })
      return
    }

    res.status(404).json({ error: 'Session not found' })
  })

  // -----------------------------------------------------------------------
  // GET /sessions/:name/messages — peek at normalized messages
  // -----------------------------------------------------------------------

  router.get('/sessions/:name/messages', requireReadAccess, async (req, res) => {
    const name = parseSessionName(req.params.name)
    if (!name) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    // Parse query params
    const rawLast = req.query.last
    let last: number | undefined
    if (rawLast !== undefined) {
      const parsed = Number(rawLast)
      if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
        res.status(400).json({ error: 'Invalid last parameter: expected positive integer' })
        return
      }
      last = parsed
    }

    const rawRole = req.query.role
    let roleFilter: MessageRoleFilter = 'all'
    if (rawRole !== undefined) {
      if (rawRole !== 'user' && rawRole !== 'assistant' && rawRole !== 'all') {
        res.status(400).json({ error: 'Invalid role parameter: expected user, assistant, or all' })
        return
      }
      roleFilter = rawRole as MessageRoleFilter
    }

    // 1) Check active in-memory sessions (stream + openclaw have events[])
    const active = sessions.get(name)
    if (active) {
      const events = (active.kind === 'stream' || active.kind === 'openclaw')
        ? active.events
        : []

      const messages = extractMessages(events, roleFilter, last)
      const response: SessionMessagesResponse = {
        session: name,
        messages,
        source: 'live',
        totalEvents: events.length,
      }
      res.json(response)
      return
    }

    // 2) Check commander sessions — resolve transcript JSONL
    if (name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      const commanderId = name.slice(COMMANDER_SESSION_NAME_PREFIX.length).trim()
      const dataDir = commanderDataDir

      try {
        const commanderStore = options.commanderSessionStorePath !== undefined
          ? new CommanderSessionStore(options.commanderSessionStorePath)
          : new CommanderSessionStore()
        const commanderSession = await commanderStore.get(commanderId)

        if (commanderSession) {
          // Resolve the primary transcript ID — prefer claudeSessionId, then
          // codexThreadId (P2-1), then fall back to the bare commander ID.
          const primaryId = sanitizeTranscriptFileKey(
            commanderSession.claudeSessionId ?? commanderSession.codexThreadId ?? commanderId,
          )

          // Pre-init events may be written under the session name before the
          // init event sets claudeSessionId/codexThreadId (P2-3).  Build a
          // de-duplicated list of transcript IDs to read & merge.
          const preInitId = sanitizeTranscriptFileKey(name)
          const transcriptIds = primaryId
            ? (preInitId && preInitId !== primaryId ? [preInitId, primaryId] : [primaryId])
            : (preInitId ? [preInitId] : [])

          let allEvents: StreamJsonEvent[] = []
          for (const tid of transcriptIds) {
            const events = await readCommanderTranscript(commanderId, tid, dataDir)
            if (events) {
              allEvents = allEvents.concat(events)
            }
          }

          if (allEvents.length > 0) {
            const messages = extractMessages(allEvents, roleFilter, last)
            const response: SessionMessagesResponse = {
              session: name,
              messages,
              source: 'transcript',
              totalEvents: allEvents.length,
            }
            res.json(response)
            return
          }
        }
      } catch {
        // Fall through to 404 if commander store is unavailable
      }
    }

    // 3) Check completed sessions — serve snapshotted events when available (P2-5)
    const completed = completedSessions.get(name)
    if (completed) {
      const snapshotEvents = completedSessionEvents.get(name) ?? []
      const messages = extractMessages(snapshotEvents, roleFilter, last)
      const response: SessionMessagesResponse = {
        session: name,
        messages,
        source: 'live',
        totalEvents: snapshotEvents.length,
      }
      res.json(response)
      return
    }

    res.status(404).json({ error: 'Session not found' })
  })

  /** Prune stream sessions whose PID is no longer alive. */
  function pruneDeadStreamSessions(): void {
    let removedCount = 0
    let completedChanged = false
    for (const [sessionName, session] of sessions) {
      if (session.kind !== 'stream') continue
      const pid = session.process.pid ?? 0
      if (pid <= 0 || isPidAlive(pid)) continue

      const alreadyMarkedExited = exitedStreamSessions.has(sessionName)
      if (!alreadyMarkedExited) {
        exitedStreamSessions.set(sessionName, { phase: 'exited', hadResult: Boolean(session.finalResultEvent), exitedAt: Date.now() })
      }
      if (isOneShotStreamSessionName(sessionName)) {
        const exitEvent: StreamJsonEvent = { type: 'exit', exitCode: -1, text: 'Process not found (PID liveness check)' }
        const completed = session.finalResultEvent
          ? toCompletedSession(sessionName, session.completedTurnAt ?? new Date().toISOString(), session.finalResultEvent, session.usage.costUsd)
          : toExitBasedCompletedSession(sessionName, exitEvent, session.usage.costUsd)
        completedSessions.set(sessionName, completed)
        if (session.events.length > 0) {
          completedSessionEvents.set(sessionName, session.events.slice())
        }
        completedChanged = true
        sessions.delete(sessionName)
        removedCount += 1
        continue
      }

      // Keep non-one-shot sessions in the map so resumable session state is not discarded.
      // We only mark them exited for worker-state resolution and UI processAlive rendering.
    }

    if (completedChanged) scheduleCompletedSessionsWrite()
    if (removedCount > 0) schedulePersistedSessionsWrite()
  }

  router.get('/sessions', requireReadAccess, async (_req, res) => {
    pruneStaleCommandRoomSessions()
    pruneDeadStreamSessions()

    const result: AgentSession[] = []
    const commanderLabels = await getCommanderLabels(
      commanderDataDir,
      options.commanderSessionStorePath,
    )
    for (const [name, session] of sessions) {
      if (
        session.kind === 'stream' &&
        isCompletedOneShotStreamSession(session)
      ) {
        continue
      }

      const pid = session.kind === 'pty'
        ? session.pty.pid
        : (session.kind === 'stream' ? (session.process.pid ?? 0) : 0)
      const workerStates = session.kind === 'stream' ? getWorkerStates(name) : []
      const workerSummary = session.kind === 'stream' ? summarizeWorkerStates(workerStates) : undefined
      const processAlive = isPidAlive(pid)

      if (session.kind === 'stream' && workerSummary && isWorkerOrchestrationComplete(workerSummary) && !processAlive) {
        continue
      }

      let label: string | undefined
      if (name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        const commanderId = name.slice(COMMANDER_SESSION_NAME_PREFIX.length)
        label = commanderLabels[commanderId]
      }

      result.push({
        name,
        label,
        created: session.createdAt,
        pid,
        processAlive,
        sessionType: session.kind === 'pty' ? 'pty' : 'stream',
        agentType: session.agentType,
        cwd: session.cwd,
        host: session.host,
        parentSession: session.kind === 'stream' ? session.parentSession : undefined,
        spawnedWorkers: session.kind === 'stream' ? [...session.spawnedWorkers] : undefined,
        workerSummary,
      })
    }
    res.json(result)
  })

  // ── Stream session helpers ──────────────────────────────────────
  function supportsAutoRotation(sessionName: string, session: StreamSession): boolean {
    if (isOneShotStreamSessionName(sessionName)) {
      return false
    }
    return session.agentType === 'claude' || session.agentType === 'codex'
  }

  function createAutoRotationEvent(
    session: StreamSession,
    fromBackingId: string | undefined,
    toBackingId: string | undefined,
  ): StreamJsonEvent {
    const backingLabel = session.agentType === 'codex' ? 'thread' : 'session'
    const from = fromBackingId ?? null
    const to = toBackingId ?? null
    return {
      type: 'system',
      subtype: 'session_rotated',
      reason: 'auto-entry-threshold',
      entryCount: session.conversationEntryCount,
      threshold: autoRotateEntryThreshold,
      fromBackingId: from,
      toBackingId: to,
      text: `Session auto-rotated after ${session.conversationEntryCount} entries (${backingLabel}: ${from ?? 'unknown'} -> ${to ?? 'pending'}).`,
    }
  }

  async function buildSeededSystemPrompt(
    sessionName: string,
    session: Pick<StreamSession, 'cwd' | 'systemPrompt'>,
  ): Promise<string | undefined> {
    if (!sessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      return session.systemPrompt
    }

    const commanderId = sessionName.slice(COMMANDER_SESSION_NAME_PREFIX.length).trim()
    if (!commanderId) {
      return session.systemPrompt
    }

    try {
      const commanderStore = options.commanderSessionStorePath !== undefined
        ? new CommanderSessionStore(options.commanderSessionStorePath)
        : new CommanderSessionStore()
      const commanderSession = await commanderStore.get(commanderId)
      const built = await buildCommanderSessionSeed({
        commanderId,
        cwd: commanderSession?.cwd ?? session.cwd,
        currentTask: commanderSession?.currentTask ?? null,
        taskSource: commanderSession?.taskSource ?? null,
        memoryBasePath: commanderDataDir,
      })
      return built.systemPrompt
    } catch {
      return session.systemPrompt
    }
  }

  async function sendTextToStreamSession(session: StreamSession, text: string): Promise<boolean> {
    if (session.agentType === 'codex') {
      if (!session.codexThreadId) {
        return false
      }
      const completed = await waitForTurnCompletionWithTimeout(
        session,
        CODEX_TURN_COMPLETION_TIMEOUT_MS,
      )
      if (!completed) {
        return false
      }
      return startCodexTurn(session, text)
    }

    const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    const sent = writeToStdin(session, userMsg + '\n')
    if (sent) {
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: text },
      } as unknown as StreamJsonEvent
      appendStreamEvent(session, userEvent)
      broadcastStreamEvent(session, userEvent)
    }
    return sent
  }

  async function createReplacementStreamSession(
    sessionName: string,
    session: StreamSession,
    options: { preserveMaxTurns?: boolean; resumeSessionId?: string } = {},
  ): Promise<StreamSession> {
    const systemPrompt = await buildSeededSystemPrompt(sessionName, session)
    const commonOptions = {
      createdAt: session.createdAt,
      parentSession: session.parentSession,
      spawnedWorkers: session.spawnedWorkers,
      systemPrompt,
      maxTurns: options.preserveMaxTurns ? session.maxTurns : undefined,
    }

    if (session.agentType === 'codex') {
      return createCodexAppServerSession(
        sessionName,
        session.mode,
        systemPrompt ?? '',
        session.cwd,
        commonOptions,
      )
    }

    let machine: MachineConfig | undefined
    if (session.host) {
      const machines = await readMachineRegistry()
      machine = machines.find((entry) => entry.id === session.host)
      if (!machine) {
        throw new Error(`Host machine "${session.host}" is unavailable for session replacement`)
      }
    }

    return createStreamSession(
      sessionName,
      session.mode,
      '',
      session.cwd,
      machine,
      'claude',
      {
        ...commonOptions,
        resumeSessionId: options.resumeSessionId,
      },
    )
  }

  async function createRotatedStreamSession(sessionName: string, session: StreamSession): Promise<StreamSession> {
    return createReplacementStreamSession(sessionName, session)
  }

  async function rotateStreamSessionIfNeeded(
    sessionName: string,
    options: { allowPendingCount?: number } = {},
  ): Promise<StreamSession | null> {
    const allowPendingCount = options.allowPendingCount ?? 0
    const current = sessions.get(sessionName)
    if (!current || current.kind !== 'stream') {
      return null
    }
    if (!current.autoRotatePending) {
      return current
    }
    if (!supportsAutoRotation(sessionName, current)) {
      current.autoRotatePending = false
      return current
    }
    if (current.pendingMessageCount > allowPendingCount) {
      return current
    }

    await waitForTurnCompletion(current)

    const live = sessions.get(sessionName)
    if (!live || live.kind !== 'stream') {
      return null
    }
    if (!live.autoRotatePending) {
      return live
    }
    if (!supportsAutoRotation(sessionName, live)) {
      live.autoRotatePending = false
      return live
    }
    if (live.pendingMessageCount > allowPendingCount || !live.lastTurnCompleted) {
      return live
    }

    try {
      const rotated = await createRotatedStreamSession(sessionName, live)
      const fromBackingId = live.agentType === 'codex' ? live.codexThreadId : live.claudeSessionId
      const toBackingId = rotated.agentType === 'codex' ? rotated.codexThreadId : rotated.claudeSessionId
      const rotationEvent = createAutoRotationEvent(live, fromBackingId, toBackingId)

      appendStreamEvent(live, rotationEvent)
      broadcastStreamEvent(live, rotationEvent)

      rotated.events = live.events.slice()
      rotated.usage = { ...live.usage }
      rotated.lastEventAt = live.lastEventAt
      rotated.pendingMessageCount = live.pendingMessageCount
      rotated.conversationEntryCount = 0
      rotated.autoRotatePending = false

      for (const client of live.clients) {
        rotated.clients.add(client)
      }
      live.clients.clear()

      sessions.set(sessionName, rotated)
      cleanupStreamMessageQueue(live)
      live.process.kill('SIGTERM')
      if (sessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        await sendTextToStreamSession(rotated, COMMANDER_ROTATION_CONTINUATION_PROMPT)
      }
      schedulePersistedSessionsWrite()
      return rotated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failureEvent: StreamJsonEvent = {
        type: 'system',
        subtype: 'session_rotation_failed',
        reason: 'auto-entry-threshold',
        text: `Session auto-rotation failed: ${message}`,
      }
      appendStreamEvent(live, failureEvent)
      broadcastStreamEvent(live, failureEvent)
      schedulePersistedSessionsWrite()
      return live
    }
  }

  function scheduleAutoRotationIfNeeded(sessionName: string): void {
    const existing = autoRotationQueues.get(sessionName)
    if (existing) {
      void existing.finally(() => {
        const live = sessions.get(sessionName)
        if (
          live &&
          live.kind === 'stream' &&
          live.autoRotatePending &&
          live.pendingMessageCount === 0 &&
          !autoRotationQueues.has(sessionName)
        ) {
          scheduleAutoRotationIfNeeded(sessionName)
        }
      })
      return
    }

    const task = rotateStreamSessionIfNeeded(sessionName)
      .catch(() => null)
      .finally(() => {
        if (autoRotationQueues.get(sessionName) === task) {
          autoRotationQueues.delete(sessionName)
        }
      })

    autoRotationQueues.set(sessionName, task)
  }

  function appendStreamEvent(session: StreamSession, event: StreamJsonEvent): void {
    session.lastEventAt = new Date().toISOString()
    session.events.push(event)
    if (session.events.length > MAX_STREAM_EVENTS) {
      session.events = session.events.slice(-MAX_STREAM_EVENTS)
    }

    // Track usage from message_delta and result events.
    //
    // message_delta.usage contains per-message token counts (cumulative within
    // that single message, not across the session). Across multiple turns we
    // must *accumulate* (`+=`) to build session totals. The `result` event at
    // the end carries session-level cumulative totals and overrides directly.
    const evtType = event.type as string
    if (evtType === 'message_start') {
      const wasCompleted = session.lastTurnCompleted
      // One-shot sessions are terminal jobs. Once a `result` event has been
      // stored, a subsequent `message_start` from stdout (for example, newer
      // Claude envelope ordering) must not clear the completed state.
      if (!isCompletedOneShotStreamSession(session)) {
        session.lastTurnCompleted = false
        session.completedTurnAt = undefined
        session.finalResultEvent = undefined
        session.restoredIdle = false
      }
      if (wasCompleted && session.agentType === 'claude') {
        schedulePersistedSessionsWrite()
      }
    }
    if (evtType === 'result') {
      const wasCompleted = session.lastTurnCompleted
      session.lastTurnCompleted = true
      session.completedTurnAt = new Date().toISOString()
      session.finalResultEvent = event
      if (!wasCompleted) {
        session.conversationEntryCount += 1
      }
      session.turnCompletedEmitter.emit('done')
      if (!wasCompleted && session.agentType === 'claude') {
        schedulePersistedSessionsWrite()
      }
      if (!wasCompleted && session.agentType === 'codex') {
        schedulePersistedSessionsWrite()
      }
      if (
        supportsAutoRotation(session.name, session) &&
        session.conversationEntryCount >= autoRotateEntryThreshold
      ) {
        session.autoRotatePending = true
        scheduleAutoRotationIfNeeded(session.name)
      }
    }
    if (evtType === 'message_delta' && event.usage) {
      const u = event.usage as { input_tokens?: number; output_tokens?: number }
      if (codexUsageIsTotal(event)) {
        if (u.input_tokens !== undefined) session.usage.inputTokens = u.input_tokens
        if (u.output_tokens !== undefined) session.usage.outputTokens = u.output_tokens
      } else {
        if (u.input_tokens !== undefined) session.usage.inputTokens += u.input_tokens
        if (u.output_tokens !== undefined) session.usage.outputTokens += u.output_tokens
      }
    }
    if (evtType === 'result') {
      const totalCost = event.total_cost_usd as number | undefined
      const cost = event.cost_usd as number | undefined
      if (typeof totalCost === 'number') {
        session.usage.costUsd = totalCost
      } else if (typeof cost === 'number') {
        session.usage.costUsd = cost
      }
    }
    if (evtType === 'result' && event.usage) {
      // result.usage is session-level cumulative — override accumulated totals
      const u = event.usage as { input_tokens?: number; output_tokens?: number }
      session.usage.inputTokens = u.input_tokens ?? session.usage.inputTokens
      session.usage.outputTokens = u.output_tokens ?? session.usage.outputTokens
    }

    if (session.agentType === 'claude') {
      const sessionId = extractClaudeSessionId(event)
      if (sessionId && session.claudeSessionId !== sessionId) {
        session.claudeSessionId = sessionId
        schedulePersistedSessionsWrite()
      }
    }

    appendCommanderTranscriptEvent(session, event)
  }

  function broadcastStreamEvent(session: StreamSession | OpenClawSession, event: StreamJsonEvent): void {
    const payload = JSON.stringify(event)
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }

    const handlers = sessionEventHandlers.get(session.name)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch {
          // Ignore handler failures to avoid interrupting stream delivery.
        }
      }
    }
  }

  function normalizeOpenClawEvent(rawEvent: unknown): StreamJsonEvent | null {
    const event = asObject(rawEvent)
    if (!event) return null
    const type = typeof event.type === 'string' ? event.type : ''
    if (!type) return null

    // Pass-through events whose shape already matches StreamJsonEvent.
    const passthrough = new Set(['content_block_start', 'content_block_stop', 'tool_use', 'result'])
    if (passthrough.has(type)) {
      return event as StreamJsonEvent
    }

    switch (type) {
      case 'content_block_delta': {
        // Only pass through when a delta object is present — matches plan mapping.
        const delta = asObject(event.delta)
        return delta ? event as StreamJsonEvent : null
      }
      case 'thinking_delta': {
        // Map OpenClaw thinking_delta → content_block_delta with thinking_delta.
        const delta = asObject(event.delta)
        const thinking = typeof event.thinking === 'string'
          ? event.thinking
          : (typeof delta?.thinking === 'string' ? delta.thinking : '')
        if (!thinking) return null
        return {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking },
        } as StreamJsonEvent
      }
      case 'thinking_start': {
        // Map OpenClaw thinking_start → content_block_delta with thinking_delta.
        const thinking = typeof event.thinking === 'string' ? event.thinking : ''
        if (!thinking) return null
        return {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking },
        } as StreamJsonEvent
      }
      case 'done': {
        // Map OpenClaw done → result event.
        const result = typeof event.result === 'string' ? event.result : ''
        return { type: 'result', result } as StreamJsonEvent
      }
      default:
        return null
    }
  }

  async function dispatchOpenClawHook(session: OpenClawSession, message: string, signal?: AbortSignal): Promise<boolean> {
    const text = message.trim()
    if (text.length === 0) return false

    session.pendingHookDispatches += 1
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const response = await fetch(`${session.gatewayUrl}/hooks/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: text,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
        }),
        signal,
      })
      if (response.status === 401) {
        const unauthorizedEvent: StreamJsonEvent = {
          type: 'system',
          text: 'OpenClaw gateway returned 401 — check OPENCLAW_GATEWAY_TOKEN env var on the server',
        }
        session.lastEventAt = new Date().toISOString()
        session.events.push(unauthorizedEvent)
        if (session.events.length > MAX_STREAM_EVENTS) {
          session.events = session.events.slice(-MAX_STREAM_EVENTS)
        }
        broadcastStreamEvent(session, unauthorizedEvent)
        return false
      }
      if (response.ok) {
        session.pendingTurnCount += 1
      }
      return response.ok
    } catch {
      return false
    } finally {
      session.pendingHookDispatches = Math.max(0, session.pendingHookDispatches - 1)
    }
  }

  function createOpenClawSession(
    sessionName: string,
    task: string,
    gatewayUrl: string = DEFAULT_OPENCLAW_GATEWAY_URL,
    agentId: string = 'main',
    cwd?: string,
  ): OpenClawSession {
    const initializedAt = new Date().toISOString()
    const sessionCwd = cwd || process.env.HOME || '/tmp'
    const normalizedGatewayUrl = gatewayUrl.replace(/\/+$/, '')
    const sessionKey = `hammurabi-${sessionName}`
    const wsUrl = normalizedGatewayUrl.replace(/^http/i, 'ws') + '/ws'
    const ws = new WebSocket(wsUrl)

    const session: OpenClawSession = {
      kind: 'openclaw',
      name: sessionName,
      agentType: 'openclaw',
      cwd: sessionCwd,
      task: task.length > 0 ? task : undefined,
      sessionKey,
      gatewayUrl: normalizedGatewayUrl,
      agentId,
      gatewayWs: null,
      events: [],
      clients: new Set(),
      createdAt: initializedAt,
      lastEventAt: initializedAt,
      pendingHookDispatches: 0,
      pendingTurnCount: 0,
    }

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', sessionKey }))
      } catch {
        // Ignore subscribe failures; we still filter by sessionKey client-side.
      }

      if (task.length > 0) {
        void dispatchOpenClawHook(session, task)
      }
    })

    ws.on('message', (data: RawData) => {
      let raw: unknown
      try {
        const payload = typeof data === 'string'
          ? data
          : (Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : (Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')))
        raw = JSON.parse(payload) as unknown
      } catch {
        return
      }

      const parsed = asObject(raw)
      if (!parsed) {
        return
      }
      if (parsed.sessionKey !== session.sessionKey) {
        return
      }

      const normalized = normalizeOpenClawEvent(parsed)
      if (!normalized) return
      if (normalized.type === 'result' && session.pendingTurnCount > 0) {
        session.pendingTurnCount -= 1
      }
      // Save event to replay buffer (openclaw sessions don't use usage tracking).
      session.lastEventAt = new Date().toISOString()
      session.events.push(normalized)
      if (session.events.length > MAX_STREAM_EVENTS) {
        session.events = session.events.slice(-MAX_STREAM_EVENTS)
      }
      broadcastStreamEvent(session, normalized)
    })

    ws.on('close', () => {
      session.gatewayWs = null
    })

    ws.on('error', () => {
      session.gatewayWs = null
    })

    session.gatewayWs = ws
    return session
  }

  /** Write to a stream session's stdin with backpressure awareness.
   *  If the previous write has not drained yet, this write is dropped
   *  and a system event is broadcast so the client knows the message
   *  was not delivered. Returns true if the write was accepted. */
  function writeToStdin(session: StreamSession, data: string): boolean {
    const stdin = session.process.stdin
    if (!stdin?.writable) return false
    if (session.stdinDraining) {
      const dropEvent: StreamJsonEvent = {
        type: 'system',
        text: 'Input dropped — process stdin is busy. Try again shortly.',
      }
      broadcastStreamEvent(session, dropEvent)
      return false
    }
    try {
      const ok = stdin.write(data)
      if (!ok) {
        session.stdinDraining = true
        stdin.once('drain', () => {
          session.stdinDraining = false
        })
      }
      return true
    } catch {
      // stdin closed — the process 'error'/'exit' handler will notify clients.
      return false
    }
  }

  function cleanupStreamMessageQueue(session: StreamSession): void {
    session.turnCompletedEmitter.emit('done')
    session.turnCompletedEmitter.removeAllListeners('done')
    session.messageQueue.clear(session.name)
    session.pendingMessageCount = 0
  }

  function stopSessionRuntime(
    session: PtySession | StreamSession | OpenClawSession,
    options: { closeClients?: boolean; closeReason?: string } = {},
  ): void {
    const shouldCloseClients = options.closeClients !== false
    if (shouldCloseClients) {
      for (const client of session.clients) {
        client.close(1000, options.closeReason ?? 'Session ended')
      }
      session.clients.clear()
    }

    if (session.kind === 'stream') {
      cleanupStreamMessageQueue(session)
      session.process.kill('SIGTERM')
      return
    }

    if (session.kind === 'openclaw') {
      session.gatewayWs?.close()
      session.gatewayWs = null
      return
    }

    session.pty.kill()
  }

  function waitForTurnCompletion(session: StreamSession): Promise<void> {
    if (session.lastTurnCompleted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const onDone = () => {
        if (!session.lastTurnCompleted) {
          return
        }
        session.turnCompletedEmitter.off('done', onDone)
        resolve()
      }
      session.turnCompletedEmitter.on('done', onDone)
      if (session.lastTurnCompleted) {
        session.turnCompletedEmitter.off('done', onDone)
        resolve()
      }
    })
  }

  function toTimestampMs(value: string): number | null {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function countUserTurnEvents(events: StreamJsonEvent[]): number {
    let count = 0
    for (const event of events) {
      if (event.type === 'user' || event.type === 'human') {
        count += 1
        continue
      }
      const message = asObject(event.message)
      if (message?.role === 'user') {
        count += 1
      }
    }
    return count
  }

  function estimateSessionLengthFromStats(
    createdAt: string,
    lastEventAt: string,
    userTurns: number,
    eventCount: number,
  ): SessionLength {
    const createdAtMs = toTimestampMs(createdAt)
    const lastEventAtMs = toTimestampMs(lastEventAt)
    const sessionSpanMs = (createdAtMs !== null && lastEventAtMs !== null)
      ? Math.max(0, lastEventAtMs - createdAtMs)
      : 0

    if (
      userTurns >= LONG_SESSION_USER_TURN_THRESHOLD ||
      eventCount >= LONG_SESSION_EVENT_THRESHOLD ||
      sessionSpanMs >= LONG_SESSION_DURATION_MS
    ) {
      return 'long'
    }
    return 'short'
  }

  function estimateSessionLength(session: AnySession): SessionLength {
    if (session.kind === 'stream' || session.kind === 'openclaw') {
      const events = session.events
      const userTurns = countUserTurnEvents(events)
      return estimateSessionLengthFromStats(
        session.createdAt,
        session.lastEventAt,
        userTurns,
        events.length,
      )
    }
    return estimateSessionLengthFromStats(session.createdAt, session.lastEventAt, 0, 0)
  }

  function getDebriefModeForSessionLength(sessionLength: SessionLength): DebriefMode {
    return sessionLength === 'long' ? 'aar' : 'hotwash'
  }

  function getDebriefTimeoutMs(mode: DebriefMode): number {
    return mode === 'aar' ? AAR_DEBRIEF_TIMEOUT_MS : HOTWASH_DEBRIEF_TIMEOUT_MS
  }

  function supportsPreKillDebrief(session: AnySession): session is PtySession | StreamSession {
    return session.kind !== 'openclaw'
  }

  function waitForTurnCompletionWithTimeout(session: StreamSession, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return Promise.resolve(false)
    }
    if (session.lastTurnCompleted) {
      return Promise.resolve(true)
    }

    return new Promise((resolve) => {
      let settled = false
      const onDone = () => {
        if (settled || !session.lastTurnCompleted) {
          return
        }
        settled = true
        clearTimeout(timeoutHandle)
        session.turnCompletedEmitter.off('done', onDone)
        resolve(true)
      }

      const timeoutHandle = setTimeout(() => {
        if (settled) return
        settled = true
        session.turnCompletedEmitter.off('done', onDone)
        resolve(false)
      }, timeoutMs)

      session.turnCompletedEmitter.on('done', onDone)
      if (session.lastTurnCompleted) {
        onDone()
      }
    })
  }

  function waitForPromiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
    return new Promise((resolve) => {
      let settled = false
      const timeoutHandle = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ timedOut: true })
      }, timeoutMs)

      promise
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutHandle)
          resolve({ timedOut: false, value })
        })
        .catch(() => {
          if (settled) return
          settled = true
          clearTimeout(timeoutHandle)
          resolve({ timedOut: false })
        })
    })
  }

  function waitForResultEventWithTimeout(
    sessionName: string,
    fromEventIndex: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return Promise.resolve(false)
    }

    const hasResultSince = (candidate: AnySession): boolean => {
      if (candidate.kind === 'pty') {
        return false
      }
      for (let idx = Math.max(0, fromEventIndex); idx < candidate.events.length; idx += 1) {
        if (candidate.events[idx]?.type === 'result') {
          return true
        }
      }
      return false
    }

    const initial = sessions.get(sessionName)
    if (!initial || initial.kind === 'pty') {
      return Promise.resolve(false)
    }
    if (hasResultSince(initial)) {
      return Promise.resolve(true)
    }

    return new Promise((resolve) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timeoutHandle)
        const handlers = sessionEventHandlers.get(sessionName)
        if (!handlers) {
          return
        }
        handlers.delete(onEvent)
        if (handlers.size === 0) {
          sessionEventHandlers.delete(sessionName)
        }
      }

      const onEvent = (event: StreamJsonEvent) => {
        if (settled || event.type !== 'result') {
          return
        }
        settled = true
        cleanup()
        resolve(true)
      }

      let handlers = sessionEventHandlers.get(sessionName)
      if (!handlers) {
        handlers = new Set()
        sessionEventHandlers.set(sessionName, handlers)
      }
      handlers.add(onEvent)

      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(false)
      }, timeoutMs)

      const liveSession = sessions.get(sessionName)
      if (!liveSession || liveSession.kind === 'pty') {
        settled = true
        cleanup()
        resolve(false)
        return
      }
      if (hasResultSince(liveSession)) {
        settled = true
        cleanup()
        resolve(true)
      }
    })
  }

  async function waitForPtyDebriefCompletion(
    sessionName: string,
    session: PtySession,
    fromBufferLength: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false
    }

    const deadlineMs = Date.now() + timeoutMs
    let offset = Math.max(0, fromBufferLength)
    let lastSeenDropped = session.bufferBytesDropped
    let rollingOutput = ''
    while (Date.now() < deadlineMs) {
      if (sessions.get(sessionName) !== session) {
        return false
      }

      const currentBuffer = session.buffer
      const droppedNow = session.bufferBytesDropped
      let appended = ''
      if (droppedNow !== lastSeenDropped || currentBuffer.length < offset) {
        // Buffer was capped since last poll; re-scan what remains.
        appended = currentBuffer
        offset = currentBuffer.length
        lastSeenDropped = droppedNow
      } else if (currentBuffer.length > offset) {
        appended = currentBuffer.slice(offset)
        offset = currentBuffer.length
      }

      if (appended.length > 0) {
        rollingOutput = (rollingOutput + appended).slice(-512)
        if (PTY_DEBRIEF_COMPLETION_PATTERN.test(rollingOutput)) {
          return true
        }
      }

      const remainingMs = Math.max(0, deadlineMs - Date.now())
      if (remainingMs <= 0) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(PTY_DEBRIEF_POLL_INTERVAL_MS, remainingMs)))
    }

    return false
  }

  async function triggerPreKillDebriefForStreamSession(
    sessionName: string,
    session: StreamSession,
    mode: DebriefMode,
    timeoutMs: number,
    sessionLength: SessionLength,
  ): Promise<PreKillDebriefResult> {
    const command = session.agentType === 'codex'
      ? `$debrief ${mode}`
      : `/debrief ${mode}`
    const deadlineMs = Date.now() + timeoutMs

    const debriefTask = session.messageQueue.enqueue(session.name, async () => {
      if (sessions.get(sessionName) !== session) {
        return false
      }

      const readyForDebrief = await waitForTurnCompletionWithTimeout(
        session,
        Math.max(0, deadlineMs - Date.now()),
      )
      if (!readyForDebrief) {
        return false
      }
      if (sessions.get(sessionName) !== session) {
        return false
      }

      const previousLastTurnCompleted = session.lastTurnCompleted
      const previousCompletedTurnAt = session.completedTurnAt
      session.lastTurnCompleted = false
      session.completedTurnAt = undefined

      let sent = false
      if (session.agentType === 'codex' && session.codexThreadId) {
        sent = await startCodexTurn(session, command, { reportFailure: false })
      } else {
        const userMsg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: command },
        })
        sent = writeToStdin(session, userMsg + '\n')
      }

      if (!sent) {
        session.lastTurnCompleted = previousLastTurnCompleted
        session.completedTurnAt = previousCompletedTurnAt
        return false
      }

      return waitForTurnCompletionWithTimeout(
        session,
        Math.max(0, deadlineMs - Date.now()),
      )
    })

    const settled = await waitForPromiseWithTimeout(debriefTask, timeoutMs)
    if (settled.timedOut) {
      return {
        attempted: true,
        debriefed: false,
        mode,
        sessionLength,
        timeoutMs,
        timedOut: true,
        reason: 'timeout',
      }
    }

    if (settled.value === true) {
      return {
        attempted: true,
        debriefed: true,
        mode,
        sessionLength,
        timeoutMs,
        timedOut: false,
      }
    }

    return {
      attempted: true,
      debriefed: false,
      mode,
      sessionLength,
      timeoutMs,
      timedOut: false,
      reason: 'not-completed',
    }
  }

  async function triggerPreKillDebriefForPtySession(
    sessionName: string,
    session: PtySession,
    mode: DebriefMode,
    timeoutMs: number,
    sessionLength: SessionLength,
  ): Promise<PreKillDebriefResult> {
    const command = session.agentType === 'codex'
      ? `$debrief ${mode}`
      : `/debrief ${mode}`
    const baselineBufferLength = session.buffer.length

    try {
      session.pty.write(command + '\r')
    } catch {
      return {
        attempted: true,
        debriefed: false,
        mode,
        sessionLength,
        timeoutMs,
        timedOut: false,
        reason: 'not-sent',
      }
    }

    const debriefed = await waitForPtyDebriefCompletion(
      sessionName,
      session,
      baselineBufferLength,
      timeoutMs,
    )
    if (debriefed) {
      return {
        attempted: true,
        debriefed: true,
        mode,
        sessionLength,
        timeoutMs,
        timedOut: false,
      }
    }

    return {
      attempted: true,
      debriefed: false,
      mode,
      sessionLength,
      timeoutMs,
      timedOut: true,
      reason: 'timeout',
    }
  }

  async function triggerPreKillDebrief(sessionName: string, session: AnySession): Promise<PreKillDebriefResult> {
    const sessionLength = estimateSessionLength(session)
    const mode = getDebriefModeForSessionLength(sessionLength)
    const timeoutMs = getDebriefTimeoutMs(mode)

    if (!supportsPreKillDebrief(session)) {
      return {
        attempted: false,
        debriefed: false,
        mode,
        sessionLength,
        timeoutMs,
        timedOut: false,
        reason: 'unsupported-agent-type',
      }
    }

    if (session.kind === 'stream') {
      return triggerPreKillDebriefForStreamSession(sessionName, session, mode, timeoutMs, sessionLength)
    }

    if (session.kind === 'pty') {
      return triggerPreKillDebriefForPtySession(sessionName, session, mode, timeoutMs, sessionLength)
    }
    return {
      attempted: false,
      debriefed: false,
      mode,
      sessionLength,
      timeoutMs,
      timedOut: false,
      reason: 'unsupported-session-type',
    }
  }

  function createStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType: AgentType = 'claude',
    options: StreamSessionCreateOptions = {},
  ): StreamSession {
    exitedStreamSessions.delete(sessionName)

    const initializedAt = new Date().toISOString()
    const args = buildClaudeStreamArgs(mode, options.resumeSessionId, options.systemPrompt, options.maxTurns)

    const remote = isRemoteMachine(machine)
    const localSpawnCwd = process.env.HOME || '/tmp'
    const requestedCwd = cwd ?? machine?.cwd
    const sessionCwd = requestedCwd ?? localSpawnCwd
    const spawnCommand = remote ? 'ssh' : 'claude'
    // For remote stream sessions, wrap in an interactive login shell so PATH
    // from shell init files includes user-local tool installs (Homebrew/nvm/etc).
    const remoteClaude = ['claude', ...args].map(shellEscape).join(' ')
    const remoteStreamCmd = requestedCwd
      ? `cd ${shellEscape(requestedCwd)} && exec $SHELL -lic ${shellEscape(remoteClaude)}`
      : `exec $SHELL -lic ${shellEscape(remoteClaude)}`
    const spawnArgs = remote
      ? buildSshArgs(machine, remoteStreamCmd, false)
      : args
    const spawnCwd = remote ? localSpawnCwd : sessionCwd

    const childProcess: ChildProcess = spawn(spawnCommand, spawnArgs, {
      cwd: spawnCwd,
      env: { ...process.env, CLAUDECODE: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: StreamSession = {
      kind: 'stream',
      name: sessionName,
      agentType,
      mode,
      cwd: sessionCwd,
      host: remote ? machine.id : undefined,
      parentSession: options.parentSession,
      spawnedWorkers: options.spawnedWorkers ? [...options.spawnedWorkers] : [],
      task: task.length > 0 ? task : undefined,
      process: childProcess,
      events: [],
      clients: new Set(),
      createdAt: options.createdAt ?? initializedAt,
      lastEventAt: initializedAt,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stdoutBuffer: '',
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      stdinDraining: false,
      lastTurnCompleted: true,
      messageQueue: new KeyedAsyncQueue(),
      pendingMessageCount: 0,
      conversationEntryCount: 0,
      autoRotatePending: false,
      turnCompletedEmitter: new EventEmitter(),
      claudeSessionId: options.resumeSessionId,
      restoredIdle: Boolean(options.resumeSessionId) && task.length === 0,
    }

    // Prevent unhandled 'error' events on stdin from crashing the process.
    // This can fire if the child exits before stdin is fully drained.
    if (typeof childProcess.stdin?.on === 'function') {
      childProcess.stdin.on('error', () => {
        // Intentionally ignored — the process 'error'/'exit' handlers manage
        // client notification.
      })
    }

    // Parse NDJSON from stdout line-by-line
    childProcess.stdout?.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString()
      const lines = session.stdoutBuffer.split('\n')
      // Keep the last incomplete line in the buffer
      session.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as StreamJsonEvent
          // Skip plain user echoes from Claude's stdout — the server already
          // synthesizes user events when input is received and at session
          // creation. Keep tool_result envelopes so AskUserQuestion answers
          // still unblock phase/status tracking.
          if (event.type === 'user' && getToolResultIds(event).length === 0) continue
          appendStreamEvent(session, event)
          broadcastStreamEvent(session, event)
        } catch {
          // Skip unparseable lines
        }
      }
    })

    // Flush any remaining buffered data when stdout closes.  NDJSON lines
    // should always end with '\n', but if the process exits without a
    // trailing newline the last event (e.g. `result`) would stay in the
    // buffer.  Draining here ensures the `result` event is processed before
    // the 'exit' handler runs so `finalResultEvent` is set correctly.
    childProcess.stdout?.on('end', () => {
      const remaining = session.stdoutBuffer.trim()
      if (remaining) {
        try {
          const event = JSON.parse(remaining) as StreamJsonEvent
          if (event.type !== 'user' || getToolResultIds(event).length > 0) {
            appendStreamEvent(session, event)
            broadcastStreamEvent(session, event)
          }
        } catch {
          // Ignore unparseable trailing data
        }
      }
      session.stdoutBuffer = ''
    })

    // Capture stderr and relay as system events so auth failures, config
    // issues, and crash traces are visible to the user.
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (!text) return
      const lines = text
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : undefined
      if (lastLine) {
        session.lastStderrSummary = lastLine.length > 300
          ? `${lastLine.slice(0, 297)}...`
          : lastLine
      }
      const stderrEvent: StreamJsonEvent = {
        type: 'system',
        text: `stderr: ${text}`,
      }
      appendStreamEvent(session, stderrEvent)
      broadcastStreamEvent(session, stderrEvent)
    })

    // Use EventEmitter API via cast — @types/node v25 ChildProcess class
    // uses generic EventMap that doesn't expose direct on() overloads.
    const cpEmitter = childProcess as unknown as NodeJS.EventEmitter
    cpEmitter.on('exit', (code: number | null, signal: string | null) => {
      // Guard against duplicate cleanup — when 'error' fires first (e.g.
      // spawn ENOENT) it may be followed by 'exit'.  Also guards against the
      // respawn path where the session map entry has been replaced with a new
      // session before this old process exits.  Identity check covers both.
      if (sessions.get(sessionName) !== session) return

      // If the process exits mid-turn, avoid persisting --resume state that
      // would replay an assistant prefill unsupported by newer Claude models.
      if (session.agentType === 'claude' && !session.lastTurnCompleted) {
        session.claudeSessionId = undefined
      }

      const exitCode = code ?? -1
      const stderrSummary = session.lastStderrSummary
      const signalText = signal ?? undefined
      const baseText = signalText
        ? `Process exited (signal: ${signalText})`
        : `Process exited with code ${exitCode}`
      const exitEvent: StreamJsonEvent = {
        type: 'exit',
        exitCode,
        signal: signalText,
        stderr: stderrSummary,
        text: stderrSummary ? `${baseText}; stderr: ${stderrSummary}` : baseText,
      }
      appendStreamEvent(session, exitEvent)
      broadcastStreamEvent(session, exitEvent)
      // Close all WebSocket clients so they receive the exit event and
      // cleanly disconnect rather than discovering a deleted session later.
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }
      if (session.finalResultEvent) {
        const evt = session.finalResultEvent
        completedSessions.set(
          sessionName,
          toCompletedSession(
            sessionName,
            session.completedTurnAt ?? new Date().toISOString(),
            evt,
            session.usage.costUsd,
          ),
        )
        scheduleCompletedSessionsWrite()
      } else if (isCommandRoomSessionName(sessionName) || isWorkerSessionName(sessionName)) {
        // Command-room and worker sessions: process may exit
        // without emitting a result event. Synthesize completion so status
        // queries detect the session as finished.
        completedSessions.set(
          sessionName,
          toExitBasedCompletedSession(sessionName, exitEvent, session.usage.costUsd),
        )
        scheduleCompletedSessionsWrite()
      }

      exitedStreamSessions.set(sessionName, {
        phase: 'exited',
        hadResult: Boolean(session.finalResultEvent),
        exitedAt: Date.now(),
      })

      // Snapshot events before removing the session so the messages endpoint
      // can still serve conversation history for completed one-shot sessions (P2-5).
      if (session.events.length > 0 && (isCommandRoomSessionName(sessionName) || isWorkerSessionName(sessionName))) {
        completedSessionEvents.set(sessionName, session.events.slice())
      }

      cleanupStreamMessageQueue(session)
      sessions.delete(sessionName)

      // If this was an idle restore process that exited cleanly without doing
      // any new work, the file already contains the correct resumable state.
      // Skip the write to avoid overwriting the file with an empty list.
      const isIdleRestoreExit =
        session.restoredIdle &&
        session.lastTurnCompleted &&
        session.claudeSessionId !== undefined
      if (!isIdleRestoreExit) {
        schedulePersistedSessionsWrite()
      }
    })

    cpEmitter.on('error', (err: Error) => {
      // Guard against duplicate cleanup — see 'exit' handler comment above.
      // Identity check also guards against the respawn path.
      if (sessions.get(sessionName) !== session) return

      const errorEvent: StreamJsonEvent = {
        type: 'system',
        text: `Process error: ${err.message}`,
      }
      appendStreamEvent(session, errorEvent)
      broadcastStreamEvent(session, errorEvent)

      // On spawn failure (e.g. ENOENT), 'error' may fire without a
      // subsequent 'exit' event.  Clean up the session to prevent zombie
      // entries that never auto-clean.
      if ((isCommandRoomSessionName(sessionName) || isWorkerSessionName(sessionName)) && !session.finalResultEvent) {
        completedSessions.set(
          sessionName,
          toExitBasedCompletedSession(sessionName, errorEvent, session.usage.costUsd),
        )
        scheduleCompletedSessionsWrite()
      }
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }

      exitedStreamSessions.set(sessionName, {
        phase: 'exited',
        hadResult: Boolean(session.finalResultEvent),
        exitedAt: Date.now(),
      })
      cleanupStreamMessageQueue(session)
      sessions.delete(sessionName)
      schedulePersistedSessionsWrite()
    })

    // Send initial task as the first user message via stdin and persist
    // the user event for replay (stdout 'user' events are filtered out).
    if (task.length > 0) {
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: task },
      } as unknown as StreamJsonEvent
      const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: task } })
      if (writeToStdin(session, userMsg + '\n')) {
        appendStreamEvent(session, userEvent)
      }
    }

    return session
  }

  // ── Codex App-Server Sidecar ─────────────────────────────────────
  interface CodexSidecar {
    process: ChildProcess | null
    port: number
    ws: WebSocket | null
    requestId: number
    pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    notificationListeners: Map<string, Set<(method: string, params: unknown) => void>>
  }

  const codexSidecar: CodexSidecar = {
    process: null,
    port: 0,
    ws: null,
    requestId: 0,
    pendingRequests: new Map(),
    notificationListeners: new Map(),
  }

  async function ensureCodexSidecar(): Promise<void> {
    if (codexSidecar.ws?.readyState === WebSocket.OPEN) return

    if (!codexSidecar.process) {
      // Pick a free port
      const { createServer } = await import('node:net')
      const port = await new Promise<number>((resolve, reject) => {
        const srv = createServer()
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address()
          const p = typeof addr === 'object' && addr ? addr.port : 0
          srv.close(() => resolve(p))
        })
        const serverEmitter = srv as unknown as NodeJS.EventEmitter
        serverEmitter.on('error', reject)
      })
      codexSidecar.port = port

      const cp = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      codexSidecar.process = cp

      const cpEmitter = cp as unknown as NodeJS.EventEmitter
      cpEmitter.on('exit', () => {
        codexSidecar.process = null
        codexSidecar.ws = null
      })
      cpEmitter.on('error', () => {
        codexSidecar.process = null
        codexSidecar.ws = null
      })

      // Wait for sidecar to be ready (give it a moment to bind)
      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    // Connect WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${codexSidecar.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (err) => reject(err))
      setTimeout(() => reject(new Error('Codex sidecar connection timeout')), 5000)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
        if (msg.id !== undefined && codexSidecar.pendingRequests.has(msg.id)) {
          const pending = codexSidecar.pendingRequests.get(msg.id)!
          codexSidecar.pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(JSON.stringify(msg.error)))
          } else {
            pending.resolve(msg.result)
          }
        } else if (msg.method && msg.params) {
          // Notification — dispatch to listeners
          const threadId = (msg.params as Record<string, unknown>).threadId as string | undefined
          if (threadId) {
            const listeners = codexSidecar.notificationListeners.get(threadId)
            if (listeners) {
              for (const cb of listeners) {
                cb(msg.method, msg.params)
              }
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    })

    ws.on('close', () => {
      codexSidecar.ws = null
    })

    codexSidecar.ws = ws

    // Send initialize, then the required initialized notification
    await sendCodexRequest('initialize', {
      clientInfo: { name: 'hammurabi', version: '0.1.0' },
    })
    codexSidecar.ws!.send(JSON.stringify({ method: 'initialized', params: {} }))
  }

  function sendCodexRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!codexSidecar.ws || codexSidecar.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Codex sidecar not connected'))
        return
      }
      const id = ++codexSidecar.requestId
      codexSidecar.pendingRequests.set(id, { resolve, reject })
      codexSidecar.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (codexSidecar.pendingRequests.has(id)) {
          codexSidecar.pendingRequests.delete(id)
          reject(new Error(`Codex request ${method} timed out`))
        }
      }, 30000)
    })
  }

  function addCodexNotificationListener(threadId: string, cb: (method: string, params: unknown) => void): () => void {
    if (!codexSidecar.notificationListeners.has(threadId)) {
      codexSidecar.notificationListeners.set(threadId, new Set())
    }
    codexSidecar.notificationListeners.get(threadId)!.add(cb)
    return () => {
      const set = codexSidecar.notificationListeners.get(threadId)
      if (set) {
        set.delete(cb)
        if (set.size === 0) codexSidecar.notificationListeners.delete(threadId)
      }
    }
  }

  function codexUsageIsTotal(event: StreamJsonEvent): boolean {
    return (event as StreamJsonEvent & { usage_is_total?: boolean }).usage_is_total === true
  }

  async function startCodexTurn(
    session: StreamSession,
    text: string,
    options: { reportFailure?: boolean } = {},
  ): Promise<boolean> {
    if (!session.codexThreadId) {
      return false
    }

    const previousLastTurnCompleted = session.lastTurnCompleted
    const previousCompletedTurnAt = session.completedTurnAt
    if (session.lastTurnCompleted) {
      session.lastTurnCompleted = false
      session.completedTurnAt = undefined
    }

    try {
      await ensureCodexSidecar()
      await sendCodexRequest('turn/start', {
        threadId: session.codexThreadId,
        input: [{ type: 'text', text }],
      })
      return true
    } catch (error) {
      session.lastTurnCompleted = previousLastTurnCompleted
      session.completedTurnAt = previousCompletedTurnAt

      if (options.reportFailure !== false) {
        const message = error instanceof Error ? error.message : String(error)
        const event: StreamJsonEvent = {
          type: 'system',
          text: `Codex request failed: ${message}`,
        } as unknown as StreamJsonEvent
        appendStreamEvent(session, event)
        broadcastStreamEvent(session, event)
      }

      return false
    }
  }

  function normalizeCodexEvent(method: string, params: unknown): StreamJsonEvent | StreamJsonEvent[] | null {
    const p = params as Record<string, unknown>

    switch (method) {
      case 'thread/started':
        return { type: 'system', text: 'Codex session started' }
      case 'thread/tokenUsage/updated': {
        const tokenUsage = p.tokenUsage as {
          total?: { inputTokens?: number; outputTokens?: number }
        } | undefined
        const total = tokenUsage?.total
        if (!total) return null
        return {
          type: 'message_delta',
          usage: {
            input_tokens: total.inputTokens,
            output_tokens: total.outputTokens,
          },
          usage_is_total: true,
        } as unknown as StreamJsonEvent
      }
      case 'turn/started':
        return { type: 'message_start', message: { id: (p.turn as Record<string, unknown>)?.id as string ?? '', role: 'assistant' } }
      case 'turn/completed': {
        const turn = p.turn as Record<string, unknown> | undefined
        const status = turn?.status as string | undefined
        return {
          type: 'result',
          result: status === 'completed' ? 'Turn completed' : `Turn ${status ?? 'ended'}`,
          is_error: status === 'failed',
        }
      }
      case 'item/agentMessage/delta': {
        const text = (p.delta ?? p.text) as string | undefined
        if (!text) return null
        return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as StreamJsonEvent
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const text = (p as Record<string, unknown>).text as string | undefined
        if (!text) return null
        return { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } } as unknown as StreamJsonEvent
      }
      case 'item/started': {
        const item = p.item as Record<string, unknown>
        if (!item) return null
        const itemType = item.type as string
        if (itemType === 'userMessage') {
          // User messages are already synthesized when input is sent from the UI.
          // Re-emitting them from Codex notifications duplicates the prompt.
          return null
        }
        if (itemType === 'agentMessage') {
          return {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          } as unknown as StreamJsonEvent
        }
        if (itemType === 'reasoning') {
          return { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } as unknown as StreamJsonEvent
        }
        return null
      }
      case 'item/completed': {
        const item = p.item as Record<string, unknown>
        if (!item) return null
        const itemType = item.type as string
        const itemId = item.id as string ?? ''
        if (itemType === 'agentMessage') {
          return { type: 'content_block_stop', index: 0 } as unknown as StreamJsonEvent
        }
        if (itemType === 'reasoning') {
          return { type: 'content_block_stop', index: 0 } as unknown as StreamJsonEvent
        }
        if (itemType === 'commandExecution') {
          const events: StreamJsonEvent[] = []
          events.push({
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: itemId,
                name: 'Bash',
                input: { command: (item.command ?? item.input) as string ?? '' },
              }],
            },
          } as unknown as StreamJsonEvent)
          events.push({
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: itemId,
                content: (item.output ?? '') as string,
                is_error: (item.exitCode as number | undefined) !== 0,
              }],
            },
          } as unknown as StreamJsonEvent)
          return events
        }
        if (itemType === 'fileChange') {
          const events: StreamJsonEvent[] = []
          events.push({
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: itemId,
                name: 'Edit',
                input: { file_path: (item.filePath ?? item.file) as string ?? '', old_string: '', new_string: (item.content ?? item.patch ?? '') as string },
              }],
            },
          } as unknown as StreamJsonEvent)
          events.push({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: itemId, content: 'Applied' }],
            },
          } as unknown as StreamJsonEvent)
          return events
        }
        return null
      }
      default:
        return null
    }
  }

  async function createCodexSessionFromThread(
    sessionName: string,
    mode: ClaudePermissionMode,
    sessionCwd: string,
    threadId: string,
    task: string,
    options: CodexSessionCreateOptions = {},
  ): Promise<StreamSession> {
    exitedStreamSessions.delete(sessionName)

    const initializedAt = new Date().toISOString()
    // Create a virtual StreamSession backed by the codex sidecar.
    // We use a fake ChildProcess-like object since we're proxying through the sidecar.
    const fakeProcess = new (await import('node:events')).EventEmitter() as unknown as ChildProcess
    let removeListener = () => {}
    Object.assign(fakeProcess, {
      pid: codexSidecar.process?.pid ?? 0,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => {
        // Archive the thread
        void sendCodexRequest('thread/archive', { threadId }).catch(() => {})
        removeListener()
        return true
      },
    })

    const session: StreamSession = {
      kind: 'stream',
      name: sessionName,
      agentType: 'codex',
      mode,
      cwd: sessionCwd,
      parentSession: options.parentSession,
      spawnedWorkers: options.spawnedWorkers ? [...options.spawnedWorkers] : [],
      task: task.length > 0 ? task : undefined,
      process: fakeProcess,
      events: [],
      clients: new Set(),
      createdAt: options.createdAt ?? initializedAt,
      lastEventAt: initializedAt,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stdoutBuffer: '',
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      stdinDraining: false,
      lastTurnCompleted: true,
      messageQueue: new KeyedAsyncQueue(),
      pendingMessageCount: 0,
      conversationEntryCount: 0,
      autoRotatePending: false,
      turnCompletedEmitter: new EventEmitter(),
      codexThreadId: threadId,
      restoredIdle: false,
    }

    // Listen for codex notifications on this thread.
    removeListener = addCodexNotificationListener(threadId, (method, params) => {
      const normalized = normalizeCodexEvent(method, params)
      if (!normalized) return
      const events = Array.isArray(normalized) ? normalized : [normalized]
      for (const event of events) {
        appendStreamEvent(session, event)
        broadcastStreamEvent(session, event)
      }
    })

    // Send initial task and persist the user message for replay.
    if (task.length > 0) {
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: task },
      } as unknown as StreamJsonEvent
      appendStreamEvent(session, userEvent)
      broadcastStreamEvent(session, userEvent)

      void startCodexTurn(session, task)
    }

    return session
  }

  async function createCodexAppServerSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    options: CodexSessionCreateOptions = {},
  ): Promise<StreamSession> {
    await ensureCodexSidecar()

    const sessionCwd = cwd || process.env.HOME || '/tmp'

    // Map permission mode to codex sandbox mode
    let sandbox: string
    let approvalPolicy: string
    if (mode === 'dangerouslySkipPermissions') {
      sandbox = 'danger-full-access'
      approvalPolicy = 'never'
    } else if (mode === 'acceptEdits') {
      sandbox = 'workspace-write'
      approvalPolicy = 'never'
    } else {
      sandbox = 'workspace-write'
      approvalPolicy = 'on-failure'
    }

    const threadResult = await sendCodexRequest('thread/start', {
      cwd: sessionCwd,
      sandbox,
      approvalPolicy,
    }) as { thread: { id: string } }

    return createCodexSessionFromThread(
      sessionName,
      mode,
      sessionCwd,
      threadResult.thread.id,
      task,
      options,
    )
  }

  router.post('/sessions', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.body?.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const mode = parseClaudePermissionMode(req.body?.mode)
    if (!mode) {
      res.status(400).json({
        error: 'Invalid mode. Expected one of: default, acceptEdits, dangerouslySkipPermissions',
      })
      return
    }

    const task = parseOptionalTask(req.body?.task)
    if (task === null) {
      res.status(400).json({ error: 'Task must be a string' })
      return
    }

    const cwd = parseCwd(req.body?.cwd)
    if (cwd === null) {
      res.status(400).json({ error: 'Invalid cwd: must be an absolute path' })
      return
    }

    if (countTrackedSessions() >= maxSessions) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    if (sessions.has(sessionName)) {
      res.status(409).json({ error: `Session "${sessionName}" already exists` })
      return
    }

    const sessionType = parseSessionType(req.body?.sessionType)
    const agentType = parseAgentType(req.body?.agentType)
    const requestedHost = parseOptionalHost(req.body?.host)
    if (requestedHost === null) {
      res.status(400).json({ error: 'Invalid host: expected machine ID string' })
      return
    }

    let machine: MachineConfig | undefined
    if (requestedHost !== undefined) {
      try {
        const machines = await readMachineRegistry()
        machine = machines.find((entry) => entry.id === requestedHost)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to read machines registry'
        res.status(500).json({ error: message })
        return
      }

      if (!machine) {
        res.status(400).json({ error: `Unknown host machine "${requestedHost}"` })
        return
      }
    }

    const requestedMachineCwd = cwd ?? machine?.cwd
    const sessionCwd = requestedMachineCwd ?? process.env.HOME ?? '/tmp'
    const remoteMachine = isRemoteMachine(machine) ? machine : undefined

    if (agentType === 'openclaw') {
      const rawAgentId = req.body?.agentId
      const agentId = typeof rawAgentId === 'string' && rawAgentId.trim().length > 0 ? rawAgentId.trim() : 'main'
      try {
        const session = createOpenClawSession(
          sessionName,
          task ?? '',
          DEFAULT_OPENCLAW_GATEWAY_URL,
          agentId,
          requestedMachineCwd,
        )
        sessions.set(sessionName, session)
        schedulePersistedSessionsWrite()
        res.status(201).json({
          sessionName,
          mode: 'dangerouslySkipPermissions',
          sessionType: 'stream',
          agentType: 'openclaw',
          created: true,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create OpenClaw session'
        res.status(500).json({ error: message })
      }
      return
    }

    if (sessionType === 'stream') {
      if (remoteMachine && agentType === 'codex') {
        res.status(400).json({
          error: 'Remote stream sessions are currently supported for claude only',
        })
        return
      }

      const parentSessionName = parseSessionName(req.body?.parentSession) || undefined
      try {
        const session = agentType === 'codex'
          ? await createCodexAppServerSession(sessionName, mode, task ?? '', requestedMachineCwd, { parentSession: parentSessionName })
          : createStreamSession(sessionName, mode, task ?? '', requestedMachineCwd, machine, agentType, { parentSession: parentSessionName })
        sessions.set(sessionName, session)
        // If a parent session is specified, register this session as a spawned worker
        if (parentSessionName) {
          const parent = sessions.get(parentSessionName)
          if (parent?.kind === 'stream' && !parent.spawnedWorkers.includes(sessionName)) {
            parent.spawnedWorkers.push(sessionName)
          }
        }
        schedulePersistedSessionsWrite()
        res.status(201).json({
          sessionName,
          mode,
          sessionType: 'stream',
          agentType,
          host: session.host,
          created: true,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create stream session'
        res.status(500).json({ error: message })
      }
      return
    }

    // PTY session (default)
    try {
      const ptySpawner = await getSpawner()
      const localSpawnCwd = process.env.HOME || '/tmp'
      // Use the remote user's default login shell (e.g. zsh on macOS) instead
      // of hardcoding bash, so that shell profile (PATH, etc.) is loaded correctly.
      const remoteShellCommand = requestedMachineCwd
        ? `cd ${shellEscape(requestedMachineCwd)} && exec $SHELL -l`
        : 'exec $SHELL -l'
      const ptyCommand = remoteMachine ? 'ssh' : 'bash'
      const ptyArgs = remoteMachine
        ? buildSshArgs(remoteMachine, remoteShellCommand, true)
        : ['-l']
      const pty = ptySpawner.spawn(ptyCommand, ptyArgs, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: remoteMachine ? localSpawnCwd : sessionCwd,
      })
      const createdAt = new Date().toISOString()

      const session: PtySession = {
        kind: 'pty',
        name: sessionName,
        agentType,
        cwd: sessionCwd,
        host: remoteMachine?.id,
        task: task && task.length > 0 ? task : undefined,
        pty,
        buffer: '',
        bufferBytesDropped: 0,
        clients: new Set(),
        createdAt,
        lastEventAt: createdAt,
      }

      pty.onData((data) => {
        session.lastEventAt = new Date().toISOString()
        appendToBuffer(session, data)
        broadcastOutput(session, data)
      })

      pty.onExit(({ exitCode, signal }) => {
        const exitMsg = JSON.stringify({ type: 'exit', exitCode, signal })
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(exitMsg)
          }
        }
        sessions.delete(sessionName)
        schedulePersistedSessionsWrite()
      })

      sessions.set(sessionName, session)

      const modeCommands = agentType === 'codex' ? CODEX_MODE_COMMANDS : CLAUDE_MODE_COMMANDS
      pty.write(modeCommands[mode] + '\r')

      if (task && task.length > 0) {
        setTimeout(() => {
          if (sessions.has(sessionName)) {
            session.pty.write(task + '\r')
          }
        }, taskDelayMs)
      }

      res.status(201).json({
        sessionName,
        mode,
        sessionType: 'pty',
        agentType,
        host: session.host,
        created: true,
      })
    } catch (err) {
      if (remoteMachine) {
        const message = err instanceof Error ? err.message : 'SSH connection failed'
        res.status(500).json({ error: `Failed to create remote PTY session: ${message}` })
        return
      }
      res.status(500).json({ error: 'Failed to create PTY session' })
    }
  })

  router.post('/sessions/:name/send', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    let session = sessions.get(sessionName)
    if (!session || (session.kind !== 'stream' && session.kind !== 'openclaw')) {
      res.status(404).json({ error: `Stream session "${sessionName}" not found` })
      return
    }

    const text = typeof req.body?.text === 'string'
      ? req.body.text.trim()
      : (typeof req.body?.message === 'string' ? req.body.message.trim() : '')
    if (text.length === 0) {
      res.status(400).json({ error: 'text must be a non-empty string' })
      return
    }

    if (session.kind === 'openclaw') {
      const sent = await dispatchOpenClawHook(session, text)
      res.json({ sent })
      return
    }

    if (session.autoRotatePending) {
      await rotateStreamSessionIfNeeded(sessionName)
      const live = sessions.get(sessionName)
      if (!live || live.kind !== 'stream') {
        res.status(404).json({ error: `Stream session "${sessionName}" not found` })
        return
      }
      session = live
    }

    const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    const sent = session.codexThreadId
      ? await startCodexTurn(session, text)
      : writeToStdin(session, userMsg + '\n')
    if (sent) {
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: text },
      } as unknown as StreamJsonEvent
      appendStreamEvent(session, userEvent)
      broadcastStreamEvent(session, userEvent)
    }
    res.json({ sent })
  })

  router.post('/sessions/:name/message', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session || (session.kind !== 'stream' && session.kind !== 'openclaw')) {
      res.status(404).json({ error: `Stream session "${sessionName}" not found` })
      return
    }

    const text = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (text.length === 0) {
      res.status(400).json({ error: 'message required' })
      return
    }

    // /reset rotates the underlying Claude session for commander sessions
    // without removing the HTTP session entry.
    if (
      text === '/reset' &&
      sessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX) &&
      session.kind === 'stream'
    ) {
      await resetCommanderSession(sessionName)
      res.json({ reset: true })
      return
    }

    if (session.kind === 'openclaw') {
      void dispatchOpenClawHook(session, text)
      res.status(202).json({ queued: true, queueDepth: 0 })
      return
    }

    if (session.pendingMessageCount >= MAX_PENDING_SESSION_MESSAGES) {
      res.status(429).json({ error: 'Queue full' })
      return
    }

    session.pendingMessageCount += 1
    const queueDepth = session.pendingMessageCount

    void session.messageQueue.enqueue(session.name, async () => {
      try {
        let liveSession = sessions.get(sessionName)
        if (!liveSession || liveSession.kind !== 'stream') {
          return
        }

        await waitForTurnCompletion(liveSession)

        liveSession = sessions.get(sessionName)
        if (!liveSession || liveSession.kind !== 'stream') {
          return
        }

        if (liveSession.autoRotatePending) {
          await rotateStreamSessionIfNeeded(sessionName, { allowPendingCount: 1 })
          liveSession = sessions.get(sessionName)
          if (!liveSession || liveSession.kind !== 'stream') {
            return
          }
          await waitForTurnCompletion(liveSession)
        }

        if (liveSession.lastTurnCompleted && liveSession.agentType !== 'codex' && !isCommandRoomSessionName(sessionName)) {
          liveSession.lastTurnCompleted = false
          liveSession.completedTurnAt = undefined
        }

        if (liveSession.agentType === 'codex' && liveSession.codexThreadId) {
          await startCodexTurn(liveSession, text)
          return
        }

        const userMsg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text },
        })
        writeToStdin(liveSession, userMsg + '\n')
      } finally {
        const liveSession = sessions.get(sessionName)
        if (liveSession && liveSession.kind === 'stream') {
          liveSession.pendingMessageCount = Math.max(0, liveSession.pendingMessageCount - 1)
          if (liveSession.pendingMessageCount === 0 && liveSession.autoRotatePending) {
            scheduleAutoRotationIfNeeded(sessionName)
          }
        } else {
          session.pendingMessageCount = Math.max(0, session.pendingMessageCount - 1)
        }
      }
    }).catch(() => {})

    res.status(202).json({ queued: true, queueDepth })
  })

  // ── Session Reset (commander-only) ──────────────────────────────────
  // Rotates the underlying Claude process: flush journal, kill old process,
  // spawn new one (no --resume), transfer WS clients, broadcast system event.
  async function resetCommanderSession(sessionName: string): Promise<StreamSession> {
    const session = sessions.get(sessionName)
    if (!session || session.kind !== 'stream') {
      throw new Error(`Session "${sessionName}" not found`)
    }

    await waitForTurnCompletion(session)

    const live = sessions.get(sessionName)
    if (!live || live.kind !== 'stream') {
      throw new Error('Session disappeared during reset')
    }

    const commanderId = sessionName.slice(COMMANDER_SESSION_NAME_PREFIX.length)
    try {
      const journal = new JournalWriter(commanderId)
      const noOpGhClient = { postIssueComment: async () => {} }
      const flusher = new EmergencyFlusher(commanderId, journal, noOpGhClient)
      await flusher.betweenTaskFlush({
        currentIssue: null,
        taskState: 'Session reset by user',
        pendingSpikeObservations: [],
        trigger: 'between-task',
      })
    } catch {
      // Journal flush is best-effort — do not block reset on failure.
    }

    const oldClients = new Set(live.clients)
    const oldEvents = live.events.slice()
    const oldUsage = { ...live.usage }
    const oldLastEventAt = live.lastEventAt

    const rotated = await createReplacementStreamSession(sessionName, live)

    const rotationEvent: StreamJsonEvent = {
      type: 'system',
      subtype: 'session_reset',
      text: 'Session rotated — Claude context cleared, memory preserved.',
    }
    appendStreamEvent(live, rotationEvent)

    rotated.events = [...oldEvents, rotationEvent]
    rotated.usage = oldUsage
    rotated.lastEventAt = oldLastEventAt
    rotated.conversationEntryCount = 0
    rotated.autoRotatePending = false

    for (const client of oldClients) {
      rotated.clients.add(client)
    }
    live.clients.clear()

    sessions.set(sessionName, rotated)
    cleanupStreamMessageQueue(live)
    live.process.kill('SIGTERM')

    broadcastStreamEvent(rotated, rotationEvent)
    await sendTextToStreamSession(rotated, COMMANDER_ROTATION_CONTINUATION_PROMPT)
    schedulePersistedSessionsWrite()
    return rotated
  }

  router.post('/sessions/:name/reset', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    if (!sessionName.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
      res.status(400).json({ error: 'Reset is only supported for commander sessions' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session) {
      res.status(404).json({ error: `Session "${sessionName}" not found` })
      return
    }

    if (session.kind !== 'stream') {
      res.status(400).json({ error: 'Reset is only supported for stream sessions' })
      return
    }

    try {
      await resetCommanderSession(sessionName)
      res.json({ reset: true, sessionName })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: `Reset failed: ${message}` })
    }
  })

  router.post('/sessions/:name/pre-kill-debrief', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session) {
      res.status(404).json({ error: `Session "${sessionName}" not found` })
      return
    }

    // PTY sessions have no structured I/O — debrief is meaningless. Return immediately.
    if (session.kind === 'pty') {
      res.json({ debriefed: false, reason: 'pty-session' })
      return
    }

    if (!supportsPreKillDebrief(session)) {
      res.json({ debriefed: false, reason: 'unsupported-agent-type' })
      return
    }

    // Stream sessions: fire-and-forget debrief, return immediately to avoid 504.
    const sessionLength = estimateSessionLength(session)
    const mode = getDebriefModeForSessionLength(sessionLength)
    const timeoutMs = getDebriefTimeoutMs(mode)

    debriefStateBySessionName.set(sessionName, {
      status: 'pending',
      startedAt: new Date().toISOString(),
      timeoutMs,
    })

    void (async () => {
      try {
        const result = await triggerPreKillDebrief(sessionName, session)
        const state = debriefStateBySessionName.get(sessionName)
        if (state) {
          state.status = result.timedOut ? 'timed-out' : 'completed'
        }
      } catch {
        const state = debriefStateBySessionName.get(sessionName)
        if (state) {
          state.status = 'timed-out'
        }
      }
    })()

    res.json({ debriefStarted: true, timeoutMs })
  })

  router.get('/sessions/:name/debrief-status', requireWriteAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const state = debriefStateBySessionName.get(sessionName)
    if (!state) {
      res.json({ status: 'none' })
      return
    }

    res.json({ status: state.status })
  })

  router.delete('/sessions/:name', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session) {
      res.status(404).json({ error: `Session "${sessionName}" not found` })
      return
    }

    // Never block on debrief — DELETE returns immediately. Frontend must call
    // POST /pre-kill-debrief first and poll GET /debrief-status for stream sessions.

    // For command-room sessions that an executor may be monitoring, add a
    // synthetic completion so the executor detects termination instead of
    // timing out when it polls and gets 404 after the session is removed.
    if (isCommandRoomSessionName(sessionName) && session.kind === 'stream' && !completedSessions.has(sessionName)) {
      const killEvent: StreamJsonEvent = { type: 'system', text: 'Session killed by API request' }
      if (session.finalResultEvent) {
        completedSessions.set(
          sessionName,
          toCompletedSession(
            sessionName,
            session.completedTurnAt ?? new Date().toISOString(),
            session.finalResultEvent,
            session.usage.costUsd,
          ),
        )
      } else {
        completedSessions.set(
          sessionName,
          toExitBasedCompletedSession(sessionName, killEvent, session.usage.costUsd),
        )
      }
    }

    for (const client of session.clients) {
      client.close(1000, 'Session killed')
    }

    if (session.kind === 'pty') {
      session.pty.kill()
    } else if (session.kind === 'stream') {
      cleanupStreamMessageQueue(session)
      session.process.kill('SIGTERM')
    } else {
      session.gatewayWs?.close()
      session.gatewayWs = null
    }

    sessions.delete(sessionName)
    sessionEventHandlers.delete(sessionName)
    debriefStateBySessionName.delete(sessionName)
    schedulePersistedSessionsWrite()

    res.json({ killed: true })
  })

  async function restorePersistedSessions(): Promise<void> {
    const persisted = await readPersistedSessionsState()
    if (persisted.sessions.length === 0) return

    for (const entry of persisted.sessions) {
      if (countTrackedSessions() >= maxSessions) {
        break
      }
      if (sessions.has(entry.name)) {
        continue
      }

      try {
        if (entry.agentType === 'codex') {
          if (entry.host) {
            continue
          }
          const session = await createCodexAppServerSession(
            entry.name,
            entry.mode,
            '',
            entry.cwd,
            {
              createdAt: entry.createdAt,
              parentSession: entry.parentSession,
              spawnedWorkers: entry.spawnedWorkers,
            },
          )
          session.conversationEntryCount = entry.conversationEntryCount ?? 0
          session.autoRotatePending = session.conversationEntryCount >= autoRotateEntryThreshold
          sessions.set(entry.name, session)
          if (session.autoRotatePending) {
            scheduleAutoRotationIfNeeded(entry.name)
          }
          continue
        }

        if (!entry.claudeSessionId) {
          continue
        }

        let machine: MachineConfig | undefined
        if (entry.host) {
          const machines = await readMachineRegistry()
          machine = machines.find((m) => m.id === entry.host)
          if (!machine) {
            continue
          }
        }

        const session = createStreamSession(
          entry.name,
          entry.mode,
          '',
          entry.cwd,
          machine,
          'claude',
          {
            resumeSessionId: entry.claudeSessionId,
            createdAt: entry.createdAt,
            systemPrompt: entry.systemPrompt,
            maxTurns: entry.maxTurns,
          },
        )
        // Restore accumulated event history for WS replay and rebuild usage totals.
        if (entry.events && entry.events.length > 0) {
          session.events = entry.events
          for (const evt of session.events) {
            const evtType = evt.type as string
            if (evtType === 'message_delta' && evt.usage) {
              const u = evt.usage as { input_tokens?: number; output_tokens?: number }
              if (codexUsageIsTotal(evt)) {
                if (u.input_tokens !== undefined) session.usage.inputTokens = u.input_tokens
                if (u.output_tokens !== undefined) session.usage.outputTokens = u.output_tokens
              } else {
                if (u.input_tokens !== undefined) session.usage.inputTokens += u.input_tokens
                if (u.output_tokens !== undefined) session.usage.outputTokens += u.output_tokens
              }
            }
            if (evtType === 'result') {
              const totalCost = evt.total_cost_usd as number | undefined
              const cost = evt.cost_usd as number | undefined
              if (typeof totalCost === 'number') session.usage.costUsd = totalCost
              else if (typeof cost === 'number') session.usage.costUsd = cost
            }
            if (evtType === 'result' && evt.usage) {
              const u = evt.usage as { input_tokens?: number; output_tokens?: number }
              session.usage.inputTokens = u.input_tokens ?? session.usage.inputTokens
              session.usage.outputTokens = u.output_tokens ?? session.usage.outputTokens
            }
          }
        }
        session.conversationEntryCount = entry.conversationEntryCount ?? countCompletedTurnEntries(session.events)
        session.autoRotatePending = session.conversationEntryCount >= autoRotateEntryThreshold
        sessions.set(entry.name, session)
        if (session.autoRotatePending) {
          scheduleAutoRotationIfNeeded(entry.name)
        }
      } catch {
        // Ignore individual restore failures and continue restoring others.
      }
    }
    // Do NOT write here — the file already reflects the correct resumable
    // state.  Writing now would race against the idle restore processes
    // exiting and could overwrite good data with an empty list.
  }

  const auth0Verifier = createAuth0Verifier({
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  async function verifyWsAuth(req: IncomingMessage): Promise<boolean> {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const accessToken = url.searchParams.get('access_token')
    const apiKeyParam = url.searchParams.get('api_key')
    const apiKeyHeader = req.headers['x-hammurabi-api-key'] as string | undefined
    const token = accessToken ?? apiKeyParam ?? apiKeyHeader

    if (!token) {
      return false
    }

    // Try Auth0 JWT verification first
    if (auth0Verifier) {
      try {
        await auth0Verifier(token)
        return true
      } catch {
        // Not a valid Auth0 token, fall through to API key check
      }
    }

    // Fall back to API key verification
    if (options.apiKeyStore) {
      const result = await options.apiKeyStore.verifyKey(token, {
        requiredScopes: ['agents:write'],
      })
      return result.ok
    }

    return false
  }

  function extractSessionNameFromUrl(url: URL): string | null {
    // Expected path: /api/agents/sessions/:name/terminal (legacy)
    // or /api/agents/sessions/:name/ws (new commander usage).
    const match = url.pathname.match(/\/sessions\/([^/]+)\/(?:terminal|ws)$/)
    if (!match) {
      return null
    }

    let decoded: string
    try {
      decoded = decodeURIComponent(match[1])
    } catch {
      return null
    }
    return SESSION_NAME_PATTERN.test(decoded) ? decoded : null
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const sessionName = extractSessionNameFromUrl(url)

    if (!sessionName) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    void verifyWsAuth(req).then((authorized) => {
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const session = sessions.get(sessionName)
      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (session.kind === 'stream' || session.kind === 'openclaw') {
          // Stream session: send buffered events as JSON array for replay.
          // Include the accumulated usage so the client can set totals
          // directly rather than re-accumulating from individual deltas.
          if (session.events.length > 0) {
            ws.send(JSON.stringify({
              type: 'replay',
              events: session.events,
              ...(session.kind === 'stream' ? { usage: session.usage } : {}),
            }))
          }

          session.clients.add(ws)
          const stopKeepAlive = attachWebSocketKeepAlive(ws, () => {
            // Use live session — may differ from `session` if a respawn occurred.
            sessions.get(sessionName)?.clients.delete(ws)
          })

          ws.on('message', (data) => {
            // Look up the live session on every message — the map entry may have
            // been replaced by a respawn while this WS connection is still open.
            // Using the stale closed-over `session` after a respawn would write to
            // the dead process and trigger repeated respawn loops.
            const liveSession = sessions.get(sessionName)
            if (!liveSession || liveSession.kind === 'pty') {
              ws.close(4004, 'Session not found')
              return
            }

            try {
              const msg = JSON.parse(data.toString()) as {
                type: string
                text?: string
                images?: { mediaType: string; data: string }[]
                toolId?: string
                answers?: Record<string, string[]>
              }

              if (liveSession.kind === 'openclaw') {
                if (msg.type === 'input') {
                  const inputText = typeof msg.text === 'string' ? msg.text.trim() : ''
                  if (inputText) {
                    void dispatchOpenClawHook(liveSession, inputText)
                  }
                }
                return
              }

              if (msg.type === 'input') {
                const inputText = typeof msg.text === 'string' ? msg.text.trim() : ''

                // Validate attached images: allowed MIME types, max 20 MB each (≈26.67 MB base64), max 5 total
                const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
                const MAX_B64_LEN = Math.ceil(20 * 1024 * 1024 / 3) * 4
                const rawImages = Array.isArray(msg.images) ? msg.images : []
                const validImages = rawImages.filter(
                  (img) =>
                    img !== null &&
                    typeof img === 'object' &&
                    typeof img.mediaType === 'string' &&
                    ALLOWED_IMAGE_TYPES.has(img.mediaType) &&
                    typeof img.data === 'string' &&
                    img.data.length <= MAX_B64_LEN,
                ).slice(0, 5)

                if (rawImages.length > 0 && validImages.length === 0) {
                  const errEvent: StreamJsonEvent = {
                    type: 'system',
                    text: 'Image rejected: unsupported type, too large (max 20 MB each), or limit exceeded.',
                  }
                  broadcastStreamEvent(liveSession, errEvent)
                }

                if (inputText || validImages.length > 0) {
                  // For Codex sessions, send `turn/start` instead of stdin.
                  const codexThreadId = liveSession.codexThreadId
                  if (codexThreadId) {
                    if (validImages.length > 0 && !inputText) {
                      // Image-only sends cannot be forwarded to Codex — reject explicitly so the
                      // UI doesn't get stuck in a streaming state with no completion event.
                      const errEvent: StreamJsonEvent = {
                        type: 'system',
                        text: 'Image-only messages are not supported in Codex sessions. Please include text with your image.',
                      }
                      broadcastStreamEvent(liveSession, errEvent)
                    } else if (validImages.length > 0) {
                      console.warn(`[agents] Codex session ${sessionName}: ignoring ${validImages.length} image(s) — not yet supported`)
                    }
                    if (inputText) {
                      // Persist user message in session events for replay on reconnect.
                      const userEvent: StreamJsonEvent = {
                        type: 'user',
                        message: { role: 'user', content: inputText },
                      } as unknown as StreamJsonEvent
                      appendStreamEvent(liveSession, userEvent)
                      broadcastStreamEvent(liveSession, userEvent)

                      void startCodexTurn(liveSession, inputText)
                    }
                  } else {
                    // Clear completed state on new input so reusable sessions
                    // become active again. One-shot sessions remain completed.
                    if (liveSession.lastTurnCompleted && !isOneShotStreamSessionName(sessionName)) {
                      liveSession.lastTurnCompleted = false
                      liveSession.completedTurnAt = undefined
                    }

                  // Build content: array with text+image blocks when images present, plain string otherwise
                  const content = validImages.length > 0
                    ? [
                        ...(inputText ? [{ type: 'text', text: inputText }] : []),
                        ...validImages.map((img) => ({
                          type: 'image',
                          source: { type: 'base64', media_type: img.mediaType, data: img.data },
                        })),
                      ]
                    : inputText

                  // Persist user message in session events for replay on reconnect
                  // only after stdin accepts the write to avoid phantom history
                  const userEvent: StreamJsonEvent = {
                    type: 'user',
                    message: { role: 'user', content },
                  } as unknown as StreamJsonEvent

                  const userMsg = JSON.stringify({
                    type: 'user',
                    message: { role: 'user', content },
                  })
                  const wrote = writeToStdin(liveSession, userMsg + '\n')
                  if (wrote) {
                    appendStreamEvent(liveSession, userEvent)
                    broadcastStreamEvent(liveSession, userEvent)
                  } else if (!liveSession.process.stdin?.writable && liveSession.claudeSessionId) {
                    // Process exited after its last turn — respawn with --resume
                    // and relay the pending user message once the new process is ready.
                    const resumeId = liveSession.claudeSessionId
                    const pendingInput = userMsg + '\n'
                    void readMachineRegistry()
                      .then(async (machines) => {
                        const machine = liveSession.host
                          ? machines.find((m) => m.id === liveSession.host)
                          : undefined
                        if (liveSession.host && !machine) {
                          throw new Error(`Remote host "${liveSession.host}" unavailable for session respawn`)
                        }
                        const newSession = await createReplacementStreamSession(
                          sessionName,
                          liveSession,
                          {
                            resumeSessionId: resumeId,
                            preserveMaxTurns: true,
                          },
                        )
                        newSession.events = liveSession.events.slice()
                        newSession.usage = { ...liveSession.usage }
                        newSession.pendingMessageCount = liveSession.pendingMessageCount
                        newSession.conversationEntryCount = liveSession.conversationEntryCount
                        newSession.autoRotatePending = liveSession.autoRotatePending
                        // Transfer connected WebSocket clients before swapping the
                        // map entry so broadcasts from the new process reach them.
                        for (const client of liveSession.clients) {
                          newSession.clients.add(client)
                        }
                        liveSession.clients.clear()
                        sessions.set(sessionName, newSession)
                        schedulePersistedSessionsWrite()
                        const systemEvent: StreamJsonEvent = {
                          type: 'system',
                          text: 'Session resumed — replaying your command...',
                        }
                        appendStreamEvent(newSession, systemEvent)
                        broadcastStreamEvent(newSession, systemEvent)
                        // Write the pending input once the new process signals
                        // readiness via its first stdout chunk (message_start).
                        newSession.process.stdout?.once('data', () => {
                          setTimeout(() => {
                            if (writeToStdin(newSession, pendingInput)) {
                              appendStreamEvent(newSession, userEvent)
                              broadcastStreamEvent(newSession, userEvent)
                            }
                          }, 500)
                        })
                      })
                      .catch(() => {})
                  }
                  }
                } // end if (inputText || validImages.length > 0)
              } else if (msg.type === 'tool_answer' && msg.toolId && msg.answers && !liveSession.codexThreadId) {
                // Serialize string[] values to comma-separated strings
                // per the AskUserQuestion contract (answers: Record<string, string>)
                const serialized: Record<string, string> = {}
                for (const [key, val] of Object.entries(msg.answers)) {
                  serialized[key] = Array.isArray(val) ? val.join(', ') : String(val)
                }
                const toolResultPayload = {
                  type: 'user' as const,
                  message: {
                    role: 'user' as const,
                    content: [{
                      type: 'tool_result',
                      tool_use_id: msg.toolId,
                      content: JSON.stringify({ answers: serialized, annotations: {} }),
                    }],
                  },
                }
                // Persist tool answer in session events for replay on reconnect
                appendStreamEvent(liveSession, toolResultPayload as unknown as StreamJsonEvent)
                broadcastStreamEvent(liveSession, toolResultPayload as unknown as StreamJsonEvent)

                const ok = writeToStdin(liveSession, JSON.stringify(toolResultPayload) + '\n')
                if (ok) {
                  ws.send(JSON.stringify({ type: 'tool_answer_ack', toolId: msg.toolId }))
                } else {
                  ws.send(JSON.stringify({ type: 'tool_answer_error', toolId: msg.toolId }))
                }
              }
            } catch {
              // Ignore invalid messages
            }
          })

          ws.on('close', () => {
            stopKeepAlive()
            sessions.get(sessionName)?.clients.delete(ws)
          })

          ws.on('error', () => {
            stopKeepAlive()
            sessions.get(sessionName)?.clients.delete(ws)
          })
          return
        }

        // PTY session (unchanged)
        if (session.buffer.length > 0) {
          ws.send(Buffer.from(session.buffer), { binary: true })
        }

        session.clients.add(ws)
        const stopKeepAlive = attachWebSocketKeepAlive(ws, () => {
          session.clients.delete(ws)
        })

        ws.on('message', (data, isBinary) => {
          if (!sessions.has(sessionName)) {
            ws.close(4004, 'Session not found')
            return
          }

          if (isBinary) {
            session.pty.write(data.toString())
          } else {
            try {
              const msg = JSON.parse(data.toString()) as { type: string; cols?: number; rows?: number }
              if (
                msg.type === 'resize' &&
                typeof msg.cols === 'number' &&
                typeof msg.rows === 'number' &&
                Number.isFinite(msg.cols) &&
                Number.isFinite(msg.rows) &&
                msg.cols >= 1 &&
                msg.cols <= 500 &&
                msg.rows >= 1 &&
                msg.rows <= 500
              ) {
                session.pty.resize(msg.cols, msg.rows)
              }
            } catch {
              // Ignore invalid control messages
            }
          }
        })

        ws.on('close', () => {
          stopKeepAlive()
          session.clients.delete(ws)
        })

        ws.on('error', () => {
          stopKeepAlive()
          session.clients.delete(ws)
        })
      })
    })
  }

  if (autoResumeSessions) {
    void restorePersistedSessions().catch(() => undefined)
  }

  const sessionsInterface: CommanderSessionsInterface = {
    async createCommanderSession({
      name,
      systemPrompt,
      agentType,
      cwd,
      resumeSessionId,
      resumeCodexThreadId,
      maxTurns,
    }) {
      let session: StreamSession
      if (agentType === 'codex') {
        const sessionCwd = cwd ?? process.env.HOME ?? '/tmp'
        if (resumeCodexThreadId) {
          try {
            session = await createCodexSessionFromThread(
              name,
              'dangerouslySkipPermissions',
              sessionCwd,
              resumeCodexThreadId,
              '',
              { systemPrompt, maxTurns },
            )
          } catch {
            session = await createCodexAppServerSession(
              name,
              'dangerouslySkipPermissions',
              systemPrompt,
              sessionCwd,
              { systemPrompt, maxTurns },
            )
          }
        } else {
          session = await createCodexAppServerSession(
            name,
            'dangerouslySkipPermissions',
            systemPrompt,
            sessionCwd,
            { systemPrompt, maxTurns },
          )
        }
      } else {
        session = createStreamSession(
          name,
          'dangerouslySkipPermissions',
          '',
          cwd,
          undefined,
          'claude',
          { systemPrompt, resumeSessionId, maxTurns },
        )
      }

      const existing = sessions.get(name)
      if (existing) {
        for (const client of existing.clients) {
          session.clients.add(client)
        }
        existing.clients.clear()
      }

      sessions.set(name, session)
      if (existing) {
        stopSessionRuntime(existing, { closeClients: false })
      }
      schedulePersistedSessionsWrite()
      return session
    },
    async sendToSession(name, text) {
      const session = sessions.get(name)
      if (!session || session.kind !== 'stream') {
        return false
      }
      return sendTextToStreamSession(session, text)
    },
    deleteSession(name) {
      const session = sessions.get(name)
      if (!session) {
        return
      }

      sessions.delete(name)
      sessionEventHandlers.delete(name)
      stopSessionRuntime(session, { closeReason: 'Commander stopped' })
      schedulePersistedSessionsWrite()
    },
    getSession(name) {
      const session = sessions.get(name)
      return session?.kind === 'stream' ? session : undefined
    },
    subscribeToEvents(name, handler) {
      let handlers = sessionEventHandlers.get(name)
      if (!handlers) {
        handlers = new Set()
        sessionEventHandlers.set(name, handlers)
      }
      handlers.add(handler)
      return () => {
        const currentHandlers = sessionEventHandlers.get(name)
        if (!currentHandlers) {
          return
        }
        currentHandlers.delete(handler)
        if (currentHandlers.size === 0) {
          sessionEventHandlers.delete(name)
        }
      }
    },
  }

  return { router, handleUpgrade, sessionsInterface }
}
