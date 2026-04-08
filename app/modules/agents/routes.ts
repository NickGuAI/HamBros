import { Router } from 'express'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
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
import { resolveCommanderNamesPath } from '../commanders/paths.js'
import type { QuestStore } from '../commanders/quest-store.js'
import { CommanderSessionStore, type CommanderSession } from '../commanders/store.js'
import {
  listWorkspaceTree,
  readWorkspaceFilePreview,
  readWorkspaceGitLog,
  readWorkspaceGitStatus,
  resolveWorkspaceRoot,
  toWorkspaceError,
  WorkspaceError,
} from '../workspace/index.js'
import { normalizeCodexEvent } from './normalize-codex-event.js'

const DEFAULT_MAX_SESSIONS = 10
const DEFAULT_TASK_DELAY_MS = 3000
const DEFAULT_WS_KEEPALIVE_INTERVAL_MS = 30000
const DEFAULT_CODEX_TURN_WATCHDOG_TIMEOUT_MS = 60_000
const MAX_BUFFER_BYTES = 256 * 1024
const MAX_STREAM_EVENTS = 1000
const SESSION_NAME_PATTERN = /^[\w-]+$/
const FILE_NAME_PATTERN = /^[a-zA-Z0-9._\- ]+$/
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const DEFAULT_SESSION_STORE_PATH = 'data/agents/stream-sessions.json'
const COMMAND_ROOM_SESSION_PREFIX = 'command-room-'
const COMMANDER_SESSION_NAME_PREFIX = 'commander-'
const COMMANDER_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/
const COMMAND_ROOM_COMPLETED_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const FACTORY_BRANCH_PATTERN = /^[\w-]+$/
const GITHUB_ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/issues\/(\d+)(?:[/?#].*)?$/
const GITHUB_REMOTE_URL_PATTERN = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const DEFAULT_OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL?.trim() || 'http://localhost:18789'

const execFileAsync = promisify(execFile)
const CODEX_SIDECAR_LOG_TAIL_LIMIT = 20
const CODEX_SIDECAR_LOG_TEXT_LIMIT = 500

function truncateLogText(value: string, maxChars = CODEX_SIDECAR_LOG_TEXT_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

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
  sessionType?: 'pty' | 'stream' | 'external'
  agentType?: AgentType
  cwd?: string
  host?: string
  parentSession?: string
  spawnedWorkers?: string[]
  workerSummary?: WorkerSummary
  processAlive?: boolean
  hadResult?: boolean
  resumedFrom?: string
  status?: 'active' | 'idle' | 'stale' | 'completed' | 'exited'
  resumeAvailable?: boolean
}

type WorldAgentStatus = 'active' | 'idle' | 'stale' | 'completed'
type WorldAgentPhase = 'idle' | 'thinking' | 'tool_use' | 'blocked' | 'stale' | 'completed'
type WorldAgentRole = 'commander' | 'worker'

export interface WorldAgent {
  id: string
  agentType: AgentType
  sessionType: 'pty' | 'stream' | 'external'
  status: WorldAgentStatus
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  task: string
  phase: WorldAgentPhase
  lastToolUse: string | null
  lastUpdatedAt: string
  role: WorldAgentRole
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
  claudeSessionId?: string
  codexThreadId?: string
  resumedFrom?: string
  finalResultEvent?: StreamJsonEvent
  conversationEntryCount: number
  codexTurnWatchdogTimer?: NodeJS.Timeout
  codexTurnStaleAt?: string
  codexNotificationCleanup?: () => void
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
  claudeSessionId?: string
}

interface ExternalSession {
  kind: 'external'
  name: string
  agentType: AgentType
  machine: string
  cwd: string
  host?: string
  task?: string
  status: 'connected' | 'stale'
  lastHeartbeat: number
  events: StreamJsonEvent[]
  clients: Set<WebSocket>
  createdAt: string
  lastEventAt: string
  metadata?: Record<string, unknown>
}

const EXTERNAL_SESSION_STALE_MS = 60_000

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
  agentType: AgentType
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  parentSession?: string
  spawnedWorkers: string[]
  createdAt: string
  claudeSessionId?: string
  codexThreadId?: string
  resumedFrom?: string
  conversationEntryCount: number
  events: StreamJsonEvent[]
}

interface StreamSessionCreateOptions {
  resumeSessionId?: string
  systemPrompt?: string
  maxTurns?: number
  createdAt?: string
  parentSession?: string
  spawnedWorkers?: string[]
  resumedFrom?: string
}

interface CodexSessionCreateOptions {
  resumeSessionId?: string
  createdAt?: string
  parentSession?: string
  spawnedWorkers?: string[]
  systemPrompt?: string
  resumedFrom?: string
}

type AnySession = PtySession | StreamSession | OpenClawSession | ExternalSession

export interface AgentsRouterOptions {
  ptySpawner?: PtySpawner
  maxSessions?: number
  taskDelayMs?: number
  wsKeepAliveIntervalMs?: number
  codexTurnWatchdogTimeoutMs?: number
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

function parseOptionalSessionName(rawSessionName: unknown): string | null | undefined {
  if (rawSessionName === undefined || rawSessionName === null || rawSessionName === '') {
    return undefined
  }

  return parseSessionName(rawSessionName)
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

function parseWorkerDispatchType(rawWorkerType: unknown): 'factory' | 'agent' | null {
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

const MACHINE_TOOL_KEYS = ['claude', 'codex', 'git', 'node'] as const

type MachineToolKey = (typeof MACHINE_TOOL_KEYS)[number]

interface MachineToolStatus {
  ok: boolean
  version: string | null
  raw: string
}

interface MachineHealthReport {
  machineId: string
  mode: 'local' | 'ssh'
  ssh: {
    ok: boolean
    destination?: string
  }
  tools: Record<MachineToolKey, MachineToolStatus>
}

interface PersistedStreamSession {
  name: string
  agentType: AgentType
  mode: ClaudePermissionMode
  cwd: string
  host?: string
  createdAt: string
  claudeSessionId?: string
  codexThreadId?: string
  conversationEntryCount?: number
  events?: StreamJsonEvent[]
  parentSession?: string
  spawnedWorkers?: string[]
  resumedFrom?: string
  sessionState?: 'active' | 'exited'
  hadResult?: boolean
}

interface PersistedSessionsState {
  sessions: PersistedStreamSession[]
}

interface ResolvedResumableSessionSource {
  source: PersistedStreamSession
  liveSession?: StreamSession
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

function validateMachineConfig(
  rawMachine: unknown,
  options: { requireHost?: boolean } = {},
): MachineConfig {
  if (!rawMachine || typeof rawMachine !== 'object') {
    throw new Error('Invalid machines config: machine entry must be an object')
  }

  const id = (rawMachine as { id?: unknown }).id
  const label = (rawMachine as { label?: unknown }).label
  const host = (rawMachine as { host?: unknown }).host
  const user = (rawMachine as { user?: unknown }).user
  const port = (rawMachine as { port?: unknown }).port
  const cwd = (rawMachine as { cwd?: unknown }).cwd

  if (typeof id !== 'string' || !SESSION_NAME_PATTERN.test(id)) {
    throw new Error('Invalid machines config: machine id must match [a-zA-Z0-9_-]+')
  }

  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error(`Invalid machines config: machine "${id}" must include a label`)
  }

  if (host !== null && typeof host !== 'string') {
    throw new Error(`Invalid machines config: machine "${id}" host must be string or null`)
  }

  const normalizedHost = typeof host === 'string' && host.trim().length > 0 ? host.trim() : null
  if (options.requireHost && normalizedHost === null) {
    throw new Error(`Invalid machines config: machine "${id}" host must be string`)
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

  return {
    id,
    label: label.trim(),
    host: normalizedHost,
    user: typeof user === 'string' && user.trim().length > 0 ? user.trim() : undefined,
    port,
    cwd: typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined,
  }
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
    const parsedMachine = validateMachineConfig(machine)
    const id = parsedMachine.id
    if (seenIds.has(id)) {
      throw new Error(`Invalid machines config: duplicate machine id "${id}"`)
    }
    seenIds.add(id)
    parsed.push(parsedMachine)
  }

  return parsed
}

function isRemoteMachine(machine: MachineConfig | undefined): machine is MachineConfig & { host: string } {
  return Boolean(machine?.host)
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
}

function buildLoginShellCommand(script: string, cwd?: string): string {
  if (cwd) {
    return `cd ${shellEscape(cwd)} && exec /bin/bash -lc ${shellEscape(script)}`
  }
  return `exec /bin/bash -lc ${shellEscape(script)}`
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

function createMissingToolStatus(): MachineToolStatus {
  return {
    ok: false,
    version: null,
    raw: 'missing',
  }
}

function buildMachineProbeScript(): string {
  return [
    "printf 'ssh:ok\\n'",
    'probe() {',
    '  label="$1"',
    '  cmd="$2"',
    '  if command -v "$cmd" >/dev/null 2>&1; then',
    '    out="$("$cmd" --version 2>/dev/null | head -n 1 || true)"',
    '    if [ -n "$out" ]; then',
    '      printf "%s:%s\\n" "$label" "$out"',
    '    else',
    '      printf "%s:missing\\n" "$label"',
    '    fi',
    '  else',
    '    printf "%s:missing\\n" "$label"',
    '  fi',
    '}',
    'probe claude claude',
    'probe codex codex',
    'probe git git',
    'probe node node',
  ].join('\n')
}

function parseMachineHealthOutput(
  machine: MachineConfig,
  stdout: string,
): MachineHealthReport {
  const tools = Object.fromEntries(
    MACHINE_TOOL_KEYS.map((tool) => [tool, createMissingToolStatus()]),
  ) as Record<MachineToolKey, MachineToolStatus>

  let sshOk = machine.host === null
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line === 'ssh:ok') {
      sshOk = true
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex) as MachineToolKey
    if (!MACHINE_TOOL_KEYS.includes(key)) {
      continue
    }

    const rawValue = line.slice(separatorIndex + 1).trim()
    if (!rawValue || rawValue === 'missing') {
      tools[key] = createMissingToolStatus()
      continue
    }

    tools[key] = {
      ok: true,
      version: rawValue,
      raw: rawValue,
    }
  }

  return {
    machineId: machine.id,
    mode: machine.host === null ? 'local' : 'ssh',
    ssh: {
      ok: sshOk,
      destination: isRemoteMachine(machine) ? buildSshDestination(machine) : undefined,
    },
    tools,
  }
}

interface CapturedCommandResult {
  stdout: string
  stderr: string
  code: number
  signal: string | null
  timedOut: boolean
}

function runCapturedCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CapturedCommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let signal: string | null = null

    const finish = (result: CapturedCommandResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      resolve(result)
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('error', (error) => {
      if (timer) {
        clearTimeout(timer)
      }
      reject(error)
    })
    proc.on('close', (code, closeSignal) => {
      signal = closeSignal
      finish({
        stdout,
        stderr,
        code: code ?? 1,
        signal,
        timedOut,
      })
    })

    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
      }, options.timeoutMs)
      : null
  })
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

function parseCodexTurnWatchdogTimeoutMs(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CODEX_TURN_WATCHDOG_TIMEOUT_MS
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
  const parentSession = typeof raw.parentSession === 'string' && raw.parentSession.trim().length > 0
    ? raw.parentSession.trim()
    : undefined
  const resumedFrom = typeof raw.resumedFrom === 'string' && raw.resumedFrom.trim().length > 0
    ? raw.resumedFrom.trim()
    : undefined
  const sessionState = raw.sessionState === 'exited' ? 'exited' : 'active'
  const hadResult = typeof raw.hadResult === 'boolean' ? raw.hadResult : undefined
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
  if (parentSession && !SESSION_NAME_PATTERN.test(parentSession)) {
    return null
  }
  if (resumedFrom && !SESSION_NAME_PATTERN.test(resumedFrom)) {
    return null
  }

  const parsedEvents = Array.isArray(raw.events)
    ? (raw.events as unknown[]).filter((e): e is StreamJsonEvent => !!asObject(e))
    : []
  const parsedSpawnedWorkers = Array.isArray(raw.spawnedWorkers)
    ? (raw.spawnedWorkers as unknown[])
      .filter((entry): entry is string => typeof entry === 'string' && SESSION_NAME_PATTERN.test(entry.trim()))
      .map((entry) => entry.trim())
    : []

  return {
    name,
    mode,
    agentType,
    cwd: path.resolve(cwd),
    host,
    createdAt,
    claudeSessionId,
    codexThreadId,
    parentSession,
    spawnedWorkers: parsedSpawnedWorkers,
    resumedFrom,
    sessionState,
    hadResult,
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

async function getCommanderLabels(
  commanderSessionStorePath?: string,
): Promise<Record<string, string>> {
  const dataDir = commanderSessionStorePath
    ? path.dirname(path.resolve(commanderSessionStorePath))
    : undefined

  let labels: Record<string, string> = {}
  try {
    const namesPath = resolveCommanderNamesPath(dataDir)
    const raw = await readFile(namesPath, 'utf8')
    labels = JSON.parse(raw) as Record<string, string>
  } catch {
    labels = {}
  }

  try {
    const commanderStore = commanderSessionStorePath !== undefined
      ? new CommanderSessionStore(commanderSessionStorePath)
      : new CommanderSessionStore()
    const commanderSessions = await commanderStore.list()
    for (const commanderSession of commanderSessions) {
      const host = commanderSession.host.trim()
      if (host.length > 0) {
        labels[commanderSession.id] = host
      }
    }
  } catch {
    // Fall back to names.json when the commander store is unavailable.
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
    agentType: session.agentType ?? 'claude',
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
  }
}

function buildClaudeStreamArgs(
  mode: ClaudePermissionMode,
  resumeSessionId?: string,
  systemPrompt?: string,
  maxTurns?: number,
): string[] {
  // Claude CLI requires --verbose when using --print (-p) with stream-json output.
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json']
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
  const completedSessions = new Map<string, CompletedSession>()
  const exitedStreamSessions = new Map<string, ExitedStreamSessionState>()
  const wss = new WebSocketServer({ noServer: true })
  const maxSessions = parseMaxSessions(options.maxSessions)
  const taskDelayMs = parseTaskDelayMs(options.taskDelayMs)
  const wsKeepAliveIntervalMs = parseWsKeepAliveIntervalMs(options.wsKeepAliveIntervalMs)
  const codexTurnWatchdogTimeoutMs = parseCodexTurnWatchdogTimeoutMs(options.codexTurnWatchdogTimeoutMs)
  const autoResumeSessions = options.autoResumeSessions ?? true
  const sessionStorePath = options.sessionStorePath
    ? path.resolve(options.sessionStorePath)
    : path.resolve(process.cwd(), DEFAULT_SESSION_STORE_PATH)
  const machinesFilePath = options.machinesFilePath
    ? path.resolve(options.machinesFilePath)
    : path.resolve(process.cwd(), 'data/machines.json')
  const restorePersistedSessionsReady = autoResumeSessions
    ? restorePersistedSessions().catch(() => undefined)
    : Promise.resolve()

  router.use((_req, _res, next) => {
    restorePersistedSessionsReady.then(() => next(), next)
  })

  let spawner: PtySpawner | null = options.ptySpawner ?? null
  let cachedMachines: MachineConfig[] | null = null
  let cachedMachinesMtimeMs = -1
  let cachedMachinesSize = -1
  let machineRegistryWriteQueue = Promise.resolve()
  let persistSessionStateQueue = Promise.resolve()
  const commanderTranscriptWriteQueues = new Map<string, Promise<void>>()

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

    const rawTranscriptId = session.claudeSessionId ?? extractClaudeSessionId(event) ?? session.name
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
      process.cwd(),
      'data',
      'commanders',
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
      if (active.lastTurnCompleted) {
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
      return {
        name: workerSessionName,
        status: exited.hadResult ? 'done' : 'down',
        phase: exited.phase,
      }
    }

    if (completedSessions.has(workerSessionName)) {
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

  function invalidateMachineRegistryCache(): void {
    cachedMachines = null
    cachedMachinesMtimeMs = -1
  }

  function sendWorkspaceError(res: import('express').Response, error: unknown): void {
    const workspaceError = toWorkspaceError(error)
    res.status(workspaceError.statusCode).json({ error: workspaceError.message })
  }

  async function resolveAgentSessionWorkspace(rawSessionName: unknown) {
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
        id: sessionName,
        label: sessionName,
        host: session.host ?? (session.kind === 'external' ? session.machine : undefined),
      },
    })
  }

  async function writeMachineRegistry(machines: readonly MachineConfig[]): Promise<MachineConfig[]> {
    const validated = parseMachineRegistry({ machines })
    await mkdir(path.dirname(machinesFilePath), { recursive: true })
    await writeFile(
      machinesFilePath,
      `${JSON.stringify({ machines: validated }, null, 2)}\n`,
      'utf8',
    )
    invalidateMachineRegistryCache()
    return validated
  }

  async function withMachineRegistryWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = machineRegistryWriteQueue.then(operation, operation)
    machineRegistryWriteQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function serializePersistedSessionsState(): PersistedSessionsState {
    const sessionsByName = new Map<string, PersistedStreamSession>()
    for (const session of sessions.values()) {
      if (session.kind !== 'stream') continue

      // Command-room sessions are one-shot jobs. Once a turn is complete, keep
      // them out of persisted auto-resume state so they do not clutter agents.
      if (isCommandRoomSessionName(session.name) && session.lastTurnCompleted && session.finalResultEvent) continue

      if (session.agentType === 'claude' && (!session.claudeSessionId || !session.lastTurnCompleted)) continue
      if (session.agentType === 'codex' && !session.codexThreadId) continue

      sessionsByName.set(session.name, {
        name: session.name,
        agentType: session.agentType,
        mode: session.mode,
        cwd: session.cwd,
        host: session.host,
        createdAt: session.createdAt,
        claudeSessionId: session.claudeSessionId,
        codexThreadId: session.codexThreadId,
        parentSession: session.parentSession,
        spawnedWorkers: session.spawnedWorkers,
        resumedFrom: session.resumedFrom,
        sessionState: 'active',
        hadResult: Boolean(session.finalResultEvent),
        conversationEntryCount: session.conversationEntryCount,
        events: session.events,
      })
    }

    for (const [sessionName, exited] of exitedStreamSessions) {
      if (isCommandRoomSessionName(sessionName)) continue
      if (exited.agentType === 'claude' && !exited.claudeSessionId) continue
      if (exited.agentType === 'codex' && !exited.codexThreadId) continue

      sessionsByName.set(sessionName, {
        name: sessionName,
        agentType: exited.agentType,
        mode: exited.mode,
        cwd: exited.cwd,
        host: exited.host,
        createdAt: exited.createdAt,
        claudeSessionId: exited.claudeSessionId,
        codexThreadId: exited.codexThreadId,
        parentSession: exited.parentSession,
        spawnedWorkers: exited.spawnedWorkers,
        resumedFrom: exited.resumedFrom,
        sessionState: 'exited',
        hadResult: exited.hadResult,
        conversationEntryCount: exited.conversationEntryCount,
        events: exited.events,
      })
    }

    const restoredSessions = [...sessionsByName.values()]
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
      if (!session.lastTurnCompleted || !session.finalResultEvent) continue

      const completedAtMs = Date.parse(session.completedTurnAt ?? session.createdAt)
      if (!Number.isFinite(completedAtMs)) continue
      if (nowMs - completedAtMs <= COMMAND_ROOM_COMPLETED_SESSION_TTL_MS) continue

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
      session.buffer = session.buffer.slice(-MAX_BUFFER_BYTES)
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

  function getWorldAgentStatus(session: AnySession, nowMs: number): WorldAgentStatus {
    if (session.kind === 'stream' && session.lastTurnCompleted && session.completedTurnAt) {
      return 'completed'
    }

    if (session.kind === 'stream' && !session.lastTurnCompleted && session.codexTurnStaleAt) {
      return 'stale'
    }

    if (session.kind === 'external') {
      const heartbeatAge = nowMs - session.lastHeartbeat
      if (heartbeatAge > EXTERNAL_SESSION_STALE_MS) return 'stale'
      return 'active'
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

  function getLastToolUse(session: StreamSession | OpenClawSession | ExternalSession): string | null {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
      const toolUses = getToolUses(session.events[i])
      for (let j = toolUses.length - 1; j >= 0; j -= 1) {
        return toolUses[j].name
      }
    }
    return null
  }

  function hasPendingAskUserQuestion(session: StreamSession | OpenClawSession | ExternalSession): boolean {
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

  function getWorldAgentPhase(session: AnySession, nowMs: number): WorldAgentPhase {
    if (session.kind === 'pty') return 'idle'

    if (session.kind === 'stream' && session.lastTurnCompleted && session.completedTurnAt) {
      return 'completed'
    }

    if (session.kind === 'stream' && getWorldAgentStatus(session, nowMs) === 'stale') {
      return 'stale'
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
      sessionType: session.kind === 'external' ? 'external' : (session.kind === 'pty' ? 'pty' : 'stream'),
      status: getWorldAgentStatus(session, nowMs),
      usage: getWorldAgentUsage(session),
      task: getWorldAgentTask(session),
      phase: getWorldAgentPhase(session, nowMs),
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

  router.get('/machines', requireReadAccess, async (_req, res) => {
    try {
      const machines = await readMachineRegistry()
      res.json(machines)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read machines registry'
      res.status(500).json({ error: message })
    }
  })

  router.post('/machines', requireWriteAccess, async (req, res) => {
    let machine: MachineConfig
    try {
      machine = validateMachineConfig(req.body, { requireHost: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid machine payload'
      res.status(400).json({ error: message })
      return
    }

    try {
      const created = await withMachineRegistryWriteLock(async () => {
        const current = await readMachineRegistry()
        if (current.some((entry) => entry.id === machine.id)) {
          throw new Error(`Machine "${machine.id}" already exists`)
        }

        const next = await writeMachineRegistry([...current, machine])
        return next.find((entry) => entry.id === machine.id) ?? machine
      })
      res.status(201).json(created)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update machines registry'
      if (message.includes('already exists')) {
        res.status(409).json({ error: message })
        return
      }
      res.status(500).json({ error: message })
    }
  })

  router.delete('/machines/:id', requireWriteAccess, async (req, res) => {
    const machineId = parseSessionName(req.params.id)
    if (!machineId) {
      res.status(400).json({ error: 'Invalid machine ID' })
      return
    }

    try {
      await withMachineRegistryWriteLock(async () => {
        const current = await readMachineRegistry()
        const target = current.find((entry) => entry.id === machineId)
        if (!target) {
          throw new Error(`Machine "${machineId}" not found`)
        }
        if (target.host === null) {
          throw new Error(`Machine "${machineId}" is the local machine and cannot be removed`)
        }

        await writeMachineRegistry(current.filter((entry) => entry.id !== machineId))
      })
      res.status(204).end()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update machines registry'
      if (message.includes('cannot be removed')) {
        res.status(400).json({ error: message })
        return
      }
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
        return
      }
      res.status(500).json({ error: message })
    }
  })

  router.get('/machines/:id/health', requireReadAccess, async (req, res) => {
    const machineId = parseSessionName(req.params.id)
    if (!machineId) {
      res.status(400).json({ error: 'Invalid machine ID' })
      return
    }

    let machine: MachineConfig | undefined
    try {
      const machines = await readMachineRegistry()
      machine = machines.find((entry) => entry.id === machineId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read machines registry'
      res.status(500).json({ error: message })
      return
    }

    if (!machine) {
      res.status(404).json({ error: `Machine "${machineId}" not found` })
      return
    }

    const probeScript = buildMachineProbeScript()

    try {
      const result = isRemoteMachine(machine)
        ? await runCapturedCommand(
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=10',
            ...buildSshArgs(machine, buildLoginShellCommand(probeScript, machine.cwd), false),
          ],
          { timeoutMs: 12_000 },
        )
        : await runCapturedCommand(
          '/bin/bash',
          ['-lc', probeScript],
          { cwd: machine.cwd, timeoutMs: 12_000 },
        )

      if (result.code !== 0) {
        const detail = result.stderr.trim() || (result.timedOut ? 'Command timed out' : '')
        res.status(502).json({
          error: isRemoteMachine(machine)
            ? `Machine "${machine.id}" health check failed over SSH`
            : `Machine "${machine.id}" local health check failed`,
          detail: detail || undefined,
          exitCode: result.code,
          signal: result.signal ?? undefined,
        })
        return
      }

      res.json(parseMachineHealthOutput(machine, result.stdout))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Health check failed'
      res.status(502).json({
        error: isRemoteMachine(machine)
          ? `Machine "${machine.id}" health check failed over SSH`
          : `Machine "${machine.id}" local health check failed`,
        detail: message,
      })
    }
  })

  router.get('/world', requireReadAccess, async (_req, res) => {
    pruneStaleCommandRoomSessions()

    const nowMs = Date.now()
    const worldAgentsById = new Map<string, WorldAgent>()
    for (const session of sessions.values()) {
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
    const rawParentSession = req.body?.parentSession
    const hasParentSessionValue =
      rawParentSession !== undefined && rawParentSession !== null && rawParentSession !== ''
    const parentSessionName = hasParentSessionValue ? parseSessionName(rawParentSession) : undefined
    if (hasParentSessionValue && !parentSessionName) {
      res.status(400).json({ error: 'Invalid parentSession' })
      return
    }

    let parentSession: StreamSession | undefined
    if (parentSessionName) {
      const candidate = sessions.get(parentSessionName)
      if (!candidate || candidate.kind !== 'stream') {
        res.status(404).json({ error: `Stream parent session "${parentSessionName}" not found` })
        return
      }
      parentSession = candidate
    }

    const requestedMachine = parseOptionalHost(req.body?.machine)
    if (requestedMachine === null) {
      res.status(400).json({ error: 'Invalid machine: expected machine ID string' })
      return
    }

    if (sessions.size >= maxSessions) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    const workerType = parseWorkerDispatchType(req.body?.workerType)
    if (workerType === null) {
      res.status(400).json({ error: 'workerType must be either "factory" or "agent"' })
      return
    }
    if (workerType === 'agent' && !parentSessionName) {
      res.status(400).json({ error: 'Provide parentSession for agent workers' })
      return
    }

    const hasRequestedAgentType =
      typeof req.body?.agentType === 'string' && req.body.agentType.trim().length > 0
    const parsedAgentType = parseAgentType(req.body?.agentType)
    const workerAgentType: 'claude' | 'codex' = hasRequestedAgentType
      ? (parsedAgentType === 'codex' ? 'codex' : 'claude')
      : (parentSession?.agentType === 'codex' ? 'codex' : 'claude')
    const workerMode: ClaudePermissionMode = parentSession?.mode ?? 'default'

    const targetMachineId = requestedMachine ?? parentSession?.host
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

    let resolvedTask = rawTask
    if (prefab === 'legion-implement' && parsedIssueUrl) {
      const issueUrl = `https://github.com/${parsedIssueUrl.owner}/${parsedIssueUrl.repo}/issues/${parsedIssueUrl.issueNumber}`
      resolvedTask = `/legion-implement ${issueUrl}${rawTask ? `\n\n${rawTask}` : ''}`
    }

    const timestamp = Date.now()
    let workerSessionName = `${workerType}-${timestamp}`
    let suffix = 1
    while (sessions.has(workerSessionName)) {
      workerSessionName = `${workerType}-${timestamp}-${suffix}`
      suffix += 1
    }

    if (workerType === 'agent') {
      const workerCwd = requestedCwd ?? parentSession?.cwd
      const workerParentOptions = parentSessionName ? { parentSession: parentSessionName } : {}
      try {
        const workerSession = workerAgentType === 'codex'
          ? await createCodexAppServerSession(
            workerSessionName,
            workerMode,
            resolvedTask,
            workerCwd,
            workerParentOptions,
          )
          : createStreamSession(
            workerSessionName,
            workerMode,
            resolvedTask,
            workerCwd,
            targetMachine,
            workerAgentType,
            workerParentOptions,
          )

        sessions.set(workerSessionName, workerSession)
        if (parentSession && !parentSession.spawnedWorkers.includes(workerSessionName)) {
          parentSession.spawnedWorkers.push(workerSessionName)
        }
        schedulePersistedSessionsWrite()

        res.status(202).json({
          name: workerSessionName,
          workerType,
          cwd: workerSession.cwd,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to dispatch worker'
        res.status(500).json({ error: message })
      }
      return
    }

    const branch = parsedBranch ?? (parsedIssueUrl ? `feat-${parsedIssueUrl.issueNumber}` : undefined)
    if (!branch) {
      res.status(400).json({ error: 'Provide branch or issueUrl' })
      return
    }

    const repoFromIssue = parsedIssueUrl
      ? { owner: parsedIssueUrl.owner, repo: parsedIssueUrl.repo }
      : null
    const sourceCwd = requestedCwd ?? parentSession?.cwd ?? process.cwd()
    const repo = repoFromIssue ?? await resolveGitHubRepoFromCwd(sourceCwd)
    if (!repo) {
      res.status(400).json({
        error: 'Unable to resolve GitHub owner/repo. Provide issueUrl or use a git repo cwd.',
      })
      return
    }

    const sessionNameBase = `${workerType}-${branch}-${timestamp}`
    workerSessionName = sessionNameBase
    suffix = 1
    while (sessions.has(workerSessionName)) {
      workerSessionName = `${sessionNameBase}-${suffix}`
      suffix += 1
    }

    try {
      const worktree = await bootstrapFactoryWorktree({
        owner: repo.owner,
        repo: repo.repo,
        feature: branch,
        machine: targetMachine,
      })

      const workerParentOptions = parentSessionName ? { parentSession: parentSessionName } : {}
      const workerSession = workerAgentType === 'codex'
        ? await createCodexAppServerSession(
          workerSessionName,
          workerMode,
          resolvedTask,
          worktree.path,
          workerParentOptions,
        )
        : createStreamSession(
          workerSessionName,
          workerMode,
          resolvedTask,
          worktree.path,
          targetMachine,
          workerAgentType,
          workerParentOptions,
        )

      sessions.set(workerSessionName, workerSession)
      if (parentSession && !parentSession.spawnedWorkers.includes(workerSessionName)) {
        parentSession.spawnedWorkers.push(workerSessionName)
      }
      schedulePersistedSessionsWrite()

      res.status(202).json({
        name: workerSessionName,
        workerType,
        worktree: worktree.path,
        branch: worktree.branch,
      })
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

  router.get('/sessions/:name/workspace/tree', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentSessionWorkspace(req.params.name)
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
      const workspace = await resolveAgentSessionWorkspace(req.params.name)
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
      if (typeof req.query.path !== 'string' || !req.query.path.trim()) {
        throw new WorkspaceError(400, 'path query parameter is required')
      }
      const workspace = await resolveAgentSessionWorkspace(req.params.name)
      const preview = await readWorkspaceFilePreview(workspace, req.query.path)
      res.json(preview)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/git/status', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentSessionWorkspace(req.params.name)
      const status = await readWorkspaceGitStatus(workspace)
      res.json(status)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
  })

  router.get('/sessions/:name/workspace/git/log', requireReadAccess, async (req, res) => {
    try {
      const workspace = await resolveAgentSessionWorkspace(req.params.name)
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 15
      const log = await readWorkspaceGitLog(workspace, Number.isFinite(limit) ? limit : 15)
      res.json(log)
    } catch (error) {
      sendWorkspaceError(res, error)
    }
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
        (isCommandRoomSessionName(name) || active.parentSession) &&
        active.lastTurnCompleted &&
        active.finalResultEvent
      ) {
        const completed = toCompletedSession(
          name,
          active.completedTurnAt ?? new Date().toISOString(),
          active.finalResultEvent,
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

      const pid = active.kind === 'pty'
        ? active.pty.pid
        : (active.kind === 'stream' ? (active.process.pid ?? 0) : 0)
      const workerStates = active.kind === 'stream' ? getWorkerStates(name) : []
      res.json({
        name,
        completed: false,
        status: active.kind === 'external' ? active.status : 'running',
        pid,
        sessionType: active.kind === 'external' ? 'external' : (active.kind === 'pty' ? 'pty' : 'stream'),
        agentType: active.agentType,
        cwd: active.cwd,
        host: active.host ?? (active.kind === 'external' ? active.machine : undefined),
        parentSession: active.kind === 'stream' ? active.parentSession : undefined,
        spawnedWorkers: active.kind === 'stream' ? [...active.spawnedWorkers] : undefined,
        workerSummary: active.kind === 'stream' ? summarizeWorkerStates(workerStates) : undefined,
        ...(active.kind === 'external' ? { machine: active.machine, metadata: active.metadata } : {}),
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

  router.get('/sessions', requireReadAccess, async (_req, res) => {
    pruneStaleCommandRoomSessions()

    const result: AgentSession[] = []
    const nowMs = Date.now()
    const commanderLabels = await getCommanderLabels(options.commanderSessionStorePath)
    for (const [name, session] of sessions) {
      if (
        session.kind === 'stream' &&
        isCommandRoomSessionName(name) &&
        session.lastTurnCompleted &&
        session.finalResultEvent
      ) {
        continue
      }

      const pid = session.kind === 'pty'
        ? session.pty.pid
        : (session.kind === 'stream' ? (session.process.pid ?? 0) : 0)
      const workerStates = session.kind === 'stream' ? getWorkerStates(name) : []

      let label: string | undefined
      if (name.startsWith(COMMANDER_SESSION_NAME_PREFIX)) {
        const commanderId = name.slice(COMMANDER_SESSION_NAME_PREFIX.length)
        label = commanderLabels[commanderId]
      }

      const status = getWorldAgentStatus(session, nowMs)

      result.push({
        name,
        label,
        created: session.createdAt,
        pid,
        sessionType: session.kind === 'external' ? 'external' : (session.kind === 'pty' ? 'pty' : 'stream'),
        agentType: session.agentType,
        cwd: session.cwd,
        host: session.host ?? (session.kind === 'external' ? session.machine : undefined),
        parentSession: session.kind === 'stream' ? session.parentSession : undefined,
        spawnedWorkers: session.kind === 'stream' ? [...session.spawnedWorkers] : undefined,
        workerSummary: session.kind === 'stream' ? summarizeWorkerStates(workerStates) : undefined,
        processAlive: true,
        hadResult: session.kind === 'stream' ? Boolean(session.finalResultEvent) : undefined,
        resumedFrom: session.kind === 'stream' ? session.resumedFrom : undefined,
        status,
        resumeAvailable: session.kind === 'stream' ? canResumeLiveStreamSession(session) : false,
      })
    }

    for (const [name, exited] of exitedStreamSessions) {
      if (sessions.has(name)) {
        continue
      }
      if (isCommandRoomSessionName(name)) {
        continue
      }

      const persistedEntry = buildPersistedEntryFromExitedSession(name, exited)
      const resumeAvailable = await isExitedSessionResumeAvailable(persistedEntry)
      result.push({
        name,
        created: exited.createdAt,
        pid: 0,
        sessionType: 'stream',
        agentType: exited.agentType,
        cwd: exited.cwd,
        host: exited.host,
        parentSession: exited.parentSession,
        spawnedWorkers: [...exited.spawnedWorkers],
        processAlive: false,
        hadResult: exited.hadResult,
        resumedFrom: exited.resumedFrom,
        status: 'exited',
        resumeAvailable,
      })
    }
    res.json(result)
  })

  // ── Stream session helpers ──────────────────────────────────────
  function readFiniteNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined
    }
    return value
  }

  function readUsageNumber(usage: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = readFiniteNumber(usage[key])
      if (value !== undefined) {
        return value
      }
    }
    return undefined
  }

  function applyStreamUsageEvent(session: StreamSession, event: StreamJsonEvent): void {
    const evtType = event.type as string
    if (evtType === 'message_delta' && event.usage) {
      const usage = asObject(event.usage)
      if (!usage) {
        return
      }
      const usageIsTotal = event.usage_is_total === true
      const inputTokens = readUsageNumber(usage, ['input_tokens', 'inputTokens', 'input'])
      const outputTokens = readUsageNumber(usage, ['output_tokens', 'outputTokens', 'output'])
      if (usageIsTotal) {
        if (inputTokens !== undefined) session.usage.inputTokens = inputTokens
        if (outputTokens !== undefined) session.usage.outputTokens = outputTokens
      } else {
        if (inputTokens !== undefined) session.usage.inputTokens += inputTokens
        if (outputTokens !== undefined) session.usage.outputTokens += outputTokens
      }

      const totalCost = readFiniteNumber(event.total_cost_usd)
      const cost = readFiniteNumber(event.cost_usd)
      if (totalCost !== undefined) {
        session.usage.costUsd = totalCost
      } else if (cost !== undefined) {
        session.usage.costUsd = cost
      }
      return
    }

    if (evtType === 'result') {
      const totalCost = readFiniteNumber(event.total_cost_usd)
      const cost = readFiniteNumber(event.cost_usd)
      if (totalCost !== undefined) {
        session.usage.costUsd = totalCost
      } else if (cost !== undefined) {
        session.usage.costUsd = cost
      }

      if (event.usage) {
        const usage = asObject(event.usage)
        if (!usage) {
          return
        }
        const inputTokens = readUsageNumber(usage, ['input_tokens', 'inputTokens', 'input'])
        const outputTokens = readUsageNumber(usage, ['output_tokens', 'outputTokens', 'output'])
        session.usage.inputTokens = inputTokens ?? session.usage.inputTokens
        session.usage.outputTokens = outputTokens ?? session.usage.outputTokens
      }
    }
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
      session.lastTurnCompleted = false
      session.completedTurnAt = undefined
      session.finalResultEvent = undefined
      session.restoredIdle = false
      if (session.agentType === 'codex') {
        scheduleCodexTurnWatchdog(session)
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
      if (!wasCompleted && session.agentType === 'claude') {
        schedulePersistedSessionsWrite()
      }
      if (session.agentType === 'codex') {
        clearCodexTurnWatchdog(session)
        markCodexTurnHealthy(session)
      }
    }
    if (evtType === 'exit' && session.agentType === 'codex') {
      clearCodexTurnWatchdog(session)
      markCodexTurnHealthy(session)
    }
    applyStreamUsageEvent(session, event)

    if (session.agentType === 'claude') {
      const sessionId = extractClaudeSessionId(event)
      if (sessionId && session.claudeSessionId !== sessionId) {
        session.claudeSessionId = sessionId
        schedulePersistedSessionsWrite()
      }
    }

    appendCommanderTranscriptEvent(session, event)
  }

  function broadcastStreamEvent(session: StreamSession | OpenClawSession | ExternalSession, event: StreamJsonEvent): void {
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

  async function dispatchOpenClawHook(session: OpenClawSession, message: string): Promise<boolean> {
    const text = message.trim()
    if (text.length === 0) return false

    try {
      const response = await fetch(`${session.gatewayUrl}/hooks/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
        }),
      })
      return response.ok
    } catch {
      return false
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

  function resetActiveTurnState(session: StreamSession): void {
    if (session.lastTurnCompleted && !isCommandRoomSessionName(session.name)) {
      session.lastTurnCompleted = false
      session.completedTurnAt = undefined
      session.finalResultEvent = undefined
    }
    if (session.agentType === 'codex') {
      markCodexTurnHealthy(session)
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
      stdinDraining: false,
      lastTurnCompleted: true,
      conversationEntryCount: 0,
      claudeSessionId: options.resumeSessionId,
      resumedFrom: options.resumedFrom,
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
          appendStreamEvent(session, event)
          broadcastStreamEvent(session, event)
        } catch {
          // Skip unparseable lines
        }
      }
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
      } else if (isCommandRoomSessionName(sessionName)) {
        // Cron-triggered sessions: process may exit without emitting result
        // (e.g. AskUserQuestion block, crash, or Codex format). Synthesize
        // completion so the executor can detect it and update the run.
        completedSessions.set(
          sessionName,
          toExitBasedCompletedSession(sessionName, exitEvent, session.usage.costUsd),
        )
      }

      exitedStreamSessions.set(sessionName, snapshotExitedStreamSession(session))
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
      if (isCommandRoomSessionName(sessionName) && !session.finalResultEvent) {
        completedSessions.set(
          sessionName,
          toExitBasedCompletedSession(sessionName, errorEvent, session.usage.costUsd),
        )
      }
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }

      exitedStreamSessions.set(sessionName, snapshotExitedStreamSession(session))
      sessions.delete(sessionName)
      schedulePersistedSessionsWrite()
    })

    // Send initial task as the first user message via stdin.
    if (task.length > 0) {
      const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: task } })
      writeToStdin(session, userMsg + '\n')
    }

    return session
  }

  // ── Codex App-Server Sidecar ─────────────────────────────────────
  interface CodexSidecar {
    process: ChildProcess | null
    port: number
    ws: WebSocket | null
    stopKeepAlive: (() => void) | null
    requestId: number
    pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
    notificationListeners: Map<string, Set<(method: string, params: unknown) => void>>
    stdoutTail: string[]
    stderrTail: string[]
  }

  const codexSidecar: CodexSidecar = {
    process: null,
    port: 0,
    ws: null,
    stopKeepAlive: null,
    requestId: 0,
    pendingRequests: new Map(),
    notificationListeners: new Map(),
    stdoutTail: [],
    stderrTail: [],
  }

  function codexFailureMessage(reason: string): string {
    return `Codex transport failure: ${reason}`
  }

  function listActiveCodexSessionNames(): string[] {
    return [...sessions.entries()]
      .filter(([, candidate]) => candidate.kind === 'stream' && candidate.agentType === 'codex')
      .map(([sessionName]) => sessionName)
  }

  function appendCodexSidecarTail(tail: string[], lines: string[]): void {
    for (const line of lines) {
      tail.push(line)
    }
    if (tail.length > CODEX_SIDECAR_LOG_TAIL_LIMIT) {
      tail.splice(0, tail.length - CODEX_SIDECAR_LOG_TAIL_LIMIT)
    }
  }

  function logCodexSidecar(
    level: 'info' | 'warn' | 'error',
    message: string,
    extra: Record<string, unknown> = {},
  ): void {
    const payload = JSON.stringify({
      pid: codexSidecar.process?.pid ?? null,
      port: codexSidecar.port || null,
      activeSessions: listActiveCodexSessionNames(),
      pendingRequests: codexSidecar.pendingRequests.size,
      listenerThreads: codexSidecar.notificationListeners.size,
      ...(codexSidecar.stderrTail.length > 0 ? { stderrTail: codexSidecar.stderrTail } : {}),
      ...(codexSidecar.stdoutTail.length > 0 ? { stdoutTail: codexSidecar.stdoutTail } : {}),
      ...extra,
    })
    const line = `[agents][codex-sidecar] ${message} ${payload}`
    if (level === 'error') {
      console.error(line)
      return
    }
    if (level === 'warn') {
      console.warn(line)
      return
    }
    console.info(line)
  }

  function recordCodexSidecarOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const lines = chunk.toString()
      .split(/\r?\n/g)
      .map((line) => truncateLogText(line))
      .filter((line) => line.length > 0)
    if (lines.length === 0) {
      return
    }

    const tail = stream === 'stderr' ? codexSidecar.stderrTail : codexSidecar.stdoutTail
    appendCodexSidecarTail(tail, lines)

    if (stream === 'stderr') {
      console.warn(`[agents][codex-sidecar][stderr] ${truncateLogText(lines.join(' | '), 800)}`)
    }
  }

  function getCodexApprovalRequestDetails(params: unknown): {
    itemId?: string
    turnId?: string
    reason?: string
    risk?: string
  } {
    const payload = asObject(params)
    if (!payload) {
      return {}
    }

    const itemId = typeof payload.itemId === 'string' && payload.itemId.trim().length > 0
      ? payload.itemId.trim()
      : undefined
    const turnId = typeof payload.turnId === 'string' && payload.turnId.trim().length > 0
      ? payload.turnId.trim()
      : undefined
    const reason = typeof payload.reason === 'string' && payload.reason.trim().length > 0
      ? truncateLogText(payload.reason.trim(), 300)
      : undefined
    const risk = typeof payload.risk === 'string' && payload.risk.trim().length > 0
      ? truncateLogText(payload.risk.trim(), 300)
      : undefined

    return { itemId, turnId, reason, risk }
  }

  function buildCodexApprovalRequestSystemEvent(method: string, params: unknown): StreamJsonEvent | null {
    const approvalTarget = method === 'item/commandExecution/requestApproval'
      ? 'command execution'
      : (method === 'item/fileChange/requestApproval' ? 'file change' : null)
    if (!approvalTarget) {
      return null
    }

    const { reason, risk } = getCodexApprovalRequestDetails(params)
    const extras = [reason ? `Reason: ${reason}` : null, risk ? `Risk: ${risk}` : null]
      .filter((value): value is string => value !== null)
      .join(' ')

    return {
      type: 'system',
      text: `Codex is waiting for ${approvalTarget} approval, but Hammurabi does not yet handle Codex approval prompts. This turn may appear stalled until it is approved externally or rerun in an auto-approve mode.${extras ? ` ${extras}` : ''}`,
    }
  }

  function rejectPendingCodexRequests(error: Error): void {
    for (const pending of codexSidecar.pendingRequests.values()) {
      pending.reject(error)
    }
    codexSidecar.pendingRequests.clear()
  }

  function clearCodexTurnWatchdog(session: StreamSession): void {
    if (session.codexTurnWatchdogTimer) {
      clearTimeout(session.codexTurnWatchdogTimer)
      session.codexTurnWatchdogTimer = undefined
    }
  }

  function markCodexTurnHealthy(session: StreamSession): void {
    session.codexTurnStaleAt = undefined
  }

  function extractCodexUsageTotals(payload: unknown): {
    usage?: { input_tokens?: number; output_tokens?: number }
    totalCostUsd?: number
  } {
    const usagePayload = asObject(payload)
    if (!usagePayload) {
      return {}
    }
    const inputTokens = readUsageNumber(usagePayload, ['input_tokens', 'inputTokens', 'input'])
    const outputTokens = readUsageNumber(usagePayload, ['output_tokens', 'outputTokens', 'output'])
    const totalCostUsd = readUsageNumber(usagePayload, ['total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd'])
    return {
      usage: (inputTokens !== undefined || outputTokens !== undefined)
        ? {
            ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
            ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
          }
        : undefined,
      totalCostUsd,
    }
  }

  function buildCodexResultFromThreadSnapshot(
    status: string,
    turn: Record<string, unknown>,
    thread: Record<string, unknown>,
  ): StreamJsonEvent {
    const turnUsage = extractCodexUsageTotals(asObject(turn.tokenUsage) ?? asObject(turn.usage))
    const threadUsage = extractCodexUsageTotals(asObject(thread.tokenUsage) ?? asObject(thread.usage))
    const usage = turnUsage.usage ?? threadUsage.usage
    const totalCostUsd = turnUsage.totalCostUsd ?? threadUsage.totalCostUsd

    if (status === 'failed') {
      const error = asObject(turn.error)
      const message = typeof error?.message === 'string' && error.message.trim().length > 0
        ? error.message.trim()
        : 'Codex turn failed'
      return {
        type: 'result',
        subtype: 'failed',
        is_error: true,
        result: message,
        ...(usage ? { usage } : {}),
        ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
      }
    }

    if (status === 'interrupted') {
      return {
        type: 'result',
        subtype: 'interrupted',
        is_error: false,
        result: 'Turn interrupted',
        ...(usage ? { usage } : {}),
        ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
      }
    }

    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Turn completed',
      ...(usage ? { usage } : {}),
      ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
    }
  }

  async function handleCodexTurnWatchdogTimeout(session: StreamSession): Promise<void> {
    if (sessions.get(session.name) !== session) {
      return
    }
    if (session.lastTurnCompleted || !session.codexThreadId) {
      clearCodexTurnWatchdog(session)
      markCodexTurnHealthy(session)
      return
    }

    clearCodexTurnWatchdog(session)

    let resolved = false
    try {
      const readResult = await sendCodexRequest('thread/read', {
        threadId: session.codexThreadId,
        includeTurns: true,
      })

      if (sessions.get(session.name) !== session || session.lastTurnCompleted) {
        return
      }

      const resultObj = asObject(readResult)
      const thread = asObject(resultObj?.thread)
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      let latestTurn: Record<string, unknown> | null = null
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = asObject(turns[i])
        if (turn) {
          latestTurn = turn
          break
        }
      }

      const status = typeof latestTurn?.status === 'string'
        ? latestTurn.status.trim().toLowerCase()
        : ''

      if (latestTurn && thread && (status === 'completed' || status === 'failed' || status === 'interrupted')) {
        const syntheticResult = buildCodexResultFromThreadSnapshot(status, latestTurn, thread)
        appendStreamEvent(session, syntheticResult)
        broadcastStreamEvent(session, syntheticResult)
        schedulePersistedSessionsWrite()
        resolved = true
      }
    } catch (error) {
      logCodexSidecar('warn', 'Codex watchdog thread/read reconciliation failed', {
        sessionName: session.name,
        threadId: session.codexThreadId,
        error: truncateLogText(error instanceof Error ? error.message : String(error)),
      })
    }

    if (resolved || sessions.get(session.name) !== session || session.lastTurnCompleted) {
      return
    }

    const timeoutSeconds = Math.max(1, Math.round(codexTurnWatchdogTimeoutMs / 1000))
    session.codexTurnStaleAt = new Date().toISOString()
    const staleEvent: StreamJsonEvent = {
      type: 'system',
      text: `Codex turn is stale (no sidecar events for ${timeoutSeconds}s). Session remains recoverable via resume.`,
    }
    appendStreamEvent(session, staleEvent)
    broadcastStreamEvent(session, staleEvent)
    schedulePersistedSessionsWrite()
    logCodexSidecar('warn', 'Codex turn marked stale after watchdog timeout', {
      sessionName: session.name,
      threadId: session.codexThreadId,
      timeoutSeconds,
    })
  }

  function scheduleCodexTurnWatchdog(session: StreamSession): void {
    if (session.agentType !== 'codex' || session.lastTurnCompleted) {
      clearCodexTurnWatchdog(session)
      return
    }
    clearCodexTurnWatchdog(session)
    markCodexTurnHealthy(session)
    session.codexTurnWatchdogTimer = setTimeout(() => {
      void handleCodexTurnWatchdogTimeout(session)
    }, codexTurnWatchdogTimeoutMs)
  }

  function detachCodexSidecarKeepAlive(): void {
    codexSidecar.stopKeepAlive?.()
    codexSidecar.stopKeepAlive = null
  }

  function handleCodexSidecarDisconnect(ws: WebSocket, detail: string): void {
    if (codexSidecar.ws !== ws) {
      return
    }
    logCodexSidecar('warn', 'Codex sidecar disconnected', {
      detail: truncateLogText(detail),
      readyState: ws.readyState,
    })
    detachCodexSidecarKeepAlive()
    codexSidecar.ws = null
    rejectPendingCodexRequests(new Error(detail))
    failAllCodexSessions(detail)
  }

  function failCodexSession(
    sessionName: string,
    session: StreamSession,
    reason: string,
    exitCode = 1,
    signal?: string,
  ): void {
    if (sessions.get(sessionName) !== session) {
      return
    }

    clearCodexTurnWatchdog(session)
    markCodexTurnHealthy(session)

    const message = codexFailureMessage(reason)
    const systemEvent: StreamJsonEvent = {
      type: 'system',
      text: message,
    }
    appendStreamEvent(session, systemEvent)
    broadcastStreamEvent(session, systemEvent)

    const resultEvent: StreamJsonEvent = {
      type: 'result',
      subtype: 'failed',
      is_error: true,
      result: message,
    }
    appendStreamEvent(session, resultEvent)
    broadcastStreamEvent(session, resultEvent)

    const exitEvent: StreamJsonEvent = {
      type: 'exit',
      exitCode,
      signal,
      text: message,
    }
    appendStreamEvent(session, exitEvent)
    broadcastStreamEvent(session, exitEvent)

    completedSessions.set(
      sessionName,
      toCompletedSession(
        sessionName,
        session.completedTurnAt ?? new Date().toISOString(),
        resultEvent,
        session.usage.costUsd,
      ),
    )
    exitedStreamSessions.set(sessionName, snapshotExitedStreamSession(session))

    // Keep failure cleanup on the existing kill/archive contract for Codex sessions.
    try {
      session.process.kill('SIGTERM')
    } catch {
      // Best-effort cleanup; continue with session teardown.
    }

    for (const client of session.clients) {
      client.close(1000, 'Session ended')
    }
    sessions.delete(sessionName)
    sessionEventHandlers.delete(sessionName)
  }

  function failAllCodexSessions(reason: string, exitCode = 1, signal?: string): void {
    const codexSessions = [...sessions.entries()].filter(([, candidate]) =>
      candidate.kind === 'stream' && candidate.agentType === 'codex'
    ) as Array<[string, StreamSession]>

    if (codexSessions.length === 0) {
      codexSidecar.notificationListeners.clear()
      return
    }

    logCodexSidecar('warn', 'Failing Codex sessions after transport failure', {
      reason: truncateLogText(reason),
      exitCode,
      signal: signal ?? null,
      affectedSessions: codexSessions.map(([sessionName]) => sessionName),
    })
    for (const [sessionName, session] of codexSessions) {
      failCodexSession(sessionName, session, reason, exitCode, signal)
    }
    codexSidecar.notificationListeners.clear()
    schedulePersistedSessionsWrite()
  }

  async function ensureCodexSidecar(): Promise<void> {
    if (codexSidecar.ws?.readyState === WebSocket.OPEN) return

    if (codexSidecar.ws) {
      detachCodexSidecarKeepAlive()
      codexSidecar.ws = null
    }

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
      codexSidecar.stdoutTail = []
      codexSidecar.stderrTail = []

      const cp = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      codexSidecar.process = cp
      cp.stdout?.on('data', (chunk: Buffer) => {
        recordCodexSidecarOutput('stdout', chunk)
      })
      cp.stderr?.on('data', (chunk: Buffer) => {
        recordCodexSidecarOutput('stderr', chunk)
      })
      logCodexSidecar('info', 'Spawned Codex sidecar process')

      const cpEmitter = cp as unknown as NodeJS.EventEmitter
      cpEmitter.on('exit', (code: number | null, signal: string | null) => {
        const detail = signal
          ? `Codex sidecar exited with signal ${signal}`
          : `Codex sidecar exited with code ${code ?? -1}`
        logCodexSidecar('error', 'Codex sidecar process exited', {
          detail,
          exitCode: code ?? -1,
          signal: signal ?? null,
        })
        codexSidecar.process = null
        detachCodexSidecarKeepAlive()
        if (codexSidecar.ws && codexSidecar.ws.readyState === WebSocket.OPEN) {
          codexSidecar.ws.terminate()
        }
        codexSidecar.ws = null
        rejectPendingCodexRequests(new Error(detail))
        failAllCodexSessions(detail, typeof code === 'number' ? code : 1, signal ?? undefined)
      })
      cpEmitter.on('error', (err: Error) => {
        logCodexSidecar('error', 'Codex sidecar process error', {
          error: truncateLogText(err.message),
        })
        codexSidecar.process = null
        detachCodexSidecarKeepAlive()
        if (codexSidecar.ws && codexSidecar.ws.readyState === WebSocket.OPEN) {
          codexSidecar.ws.terminate()
        }
        codexSidecar.ws = null
        rejectPendingCodexRequests(err)
        failAllCodexSessions(`Codex sidecar process error: ${err.message}`)
      })

    }

    // Connect as soon as the sidecar binds instead of sleeping through a fixed delay.
    const ws = await connectCodexSidecarSocket(codexSidecar.port)
    logCodexSidecar('info', 'Connected to Codex sidecar WebSocket')

    ws.on('message', (data: RawData) => {
      const payloadText = rawDataToText(data)
      try {
        const msg = JSON.parse(payloadText) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
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
      } catch (error) {
        logCodexSidecar('warn', 'Failed to parse Codex sidecar WebSocket payload', {
          error: truncateLogText(error instanceof Error ? error.message : String(error)),
          payloadSnippet: truncateLogText(payloadText, 800),
        })
      }
    })

    ws.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString().trim()
      const detail = reason
        ? `Codex sidecar connection closed (code ${code}): ${reason}`
        : `Codex sidecar connection closed (code ${code})`
      handleCodexSidecarDisconnect(ws, detail)
    })

    ws.on('error', (error) => {
      const detail = error instanceof Error
        ? `Codex sidecar connection error: ${error.message}`
        : 'Codex sidecar connection error'
      handleCodexSidecarDisconnect(ws, detail)
    })

    codexSidecar.ws = ws
    codexSidecar.stopKeepAlive = attachWebSocketKeepAlive(ws, () => {
      const detail = 'Codex sidecar keepalive timeout'
      logCodexSidecar('warn', 'Codex sidecar keepalive timeout', {
        readyState: ws.readyState,
      })
      handleCodexSidecarDisconnect(ws, detail)
    })

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
      try {
        codexSidecar.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        codexSidecar.pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      setTimeout(() => {
        if (codexSidecar.pendingRequests.has(id)) {
          codexSidecar.pendingRequests.delete(id)
          logCodexSidecar('warn', 'Codex request timed out', {
            id,
            method,
            timeoutMs: 30000,
          })
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

  async function openCodexSidecarSocket(
    port: number,
    timeoutMs: number,
  ): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)

    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        clearTimeout(timeout)
        ws.off('open', onOpen)
        ws.off('error', onError)
      }

      const rejectOnce = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        try {
          ws.terminate()
        } catch {
          // Best-effort cleanup only.
        }
        reject(error)
      }

      const onOpen = () => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(ws)
      }

      const onError = (error: Error) => {
        rejectOnce(error)
      }

      const timeout = setTimeout(() => {
        rejectOnce(new Error('Codex sidecar connection timeout'))
      }, timeoutMs)

      ws.once('open', onOpen)
      ws.once('error', onError)
    })
  }

  async function connectCodexSidecarSocket(
    port: number,
    options: { totalTimeoutMs?: number; attemptTimeoutMs?: number; retryDelayMs?: number } = {},
  ): Promise<WebSocket> {
    const totalTimeoutMs = options.totalTimeoutMs ?? 5000
    const attemptTimeoutMs = options.attemptTimeoutMs ?? 500
    const retryDelayMs = options.retryDelayMs ?? 50
    const startedAt = Date.now()
    let lastError: Error | null = null

    while (Date.now() - startedAt < totalTimeoutMs) {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
      const timeoutMs = Math.max(50, Math.min(attemptTimeoutMs, remainingMs))

      try {
        return await openCodexSidecarSocket(port, timeoutMs)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }

      if (!codexSidecar.process) {
        break
      }

      const delayMs = Math.min(retryDelayMs, Math.max(0, totalTimeoutMs - (Date.now() - startedAt)))
      if (delayMs <= 0) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    logCodexSidecar('error', 'Unable to connect to Codex sidecar WebSocket', {
      totalTimeoutMs,
      attemptTimeoutMs,
      retryDelayMs,
      lastError: truncateLogText((lastError ?? new Error('Codex sidecar connection timeout')).message),
    })
    throw lastError ?? new Error('Codex sidecar connection timeout')
  }

  async function startCodexTurn(session: StreamSession, text: string): Promise<void> {
    const codexThreadId = session.codexThreadId
    if (!codexThreadId) {
      throw new Error('Codex session is missing a thread id')
    }
    await ensureCodexSidecar()
    await sendCodexRequest('turn/start', {
      threadId: codexThreadId,
      input: [{ type: 'text', text }],
    })
  }

  async function sendTextToStreamSession(session: StreamSession, text: string): Promise<boolean> {
    if (session.agentType === 'codex' && session.codexThreadId) {
      try {
        await startCodexTurn(session, text)
      } catch (error) {
        if (sessions.get(session.name) !== session) {
          return false
        }

        const detail = error instanceof Error ? error.message : String(error)
        console.warn(`[agents] Codex input delivery failed for ${session.name}: ${detail}`)
        failCodexSession(session.name, session, detail)
        schedulePersistedSessionsWrite()
        return false
      }

      resetActiveTurnState(session)
      scheduleCodexTurnWatchdog(session)
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: text },
      } as unknown as StreamJsonEvent
      appendStreamEvent(session, userEvent)
      broadcastStreamEvent(session, userEvent)
      return true
    }

    const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
    const sent = writeToStdin(session, userMsg + '\n')
    if (!sent) {
      return false
    }

    resetActiveTurnState(session)
    const userEvent: StreamJsonEvent = {
      type: 'user',
      message: { role: 'user', content: text },
    } as unknown as StreamJsonEvent
    appendStreamEvent(session, userEvent)
    broadcastStreamEvent(session, userEvent)
    return true
  }

  // normalizeCodexEvent is imported from ./normalize-codex-event.ts

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
    const loggedCodexApprovalRequests = new Set<string>()
    // Create a virtual StreamSession backed by the codex sidecar.
    // We use a fake ChildProcess-like object since we're proxying through the sidecar.
    const fakeProcess = new (await import('node:events')).EventEmitter() as unknown as ChildProcess
    let notificationCleanup = () => {}
    Object.assign(fakeProcess, {
      pid: codexSidecar.process?.pid ?? 0,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => {
        // Archive the thread
        void sendCodexRequest('thread/archive', { threadId }).catch(() => {})
        notificationCleanup()
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
      stdinDraining: false,
      lastTurnCompleted: true,
      conversationEntryCount: 0,
      codexThreadId: threadId,
      resumedFrom: options.resumedFrom,
      codexNotificationCleanup: undefined,
      restoredIdle: false,
    }

    // Listen for codex notifications on this thread.
    notificationCleanup = addCodexNotificationListener(threadId, (method, params) => {
      if (!session.lastTurnCompleted) {
        scheduleCodexTurnWatchdog(session)
      }

      const approvalEvent = buildCodexApprovalRequestSystemEvent(method, params)
      if (approvalEvent) {
        const approvalDetails = getCodexApprovalRequestDetails(params)
        const approvalKey = [
          method,
          approvalDetails.turnId ?? '',
          approvalDetails.itemId ?? '',
        ].join(':')

        if (!loggedCodexApprovalRequests.has(approvalKey)) {
          loggedCodexApprovalRequests.add(approvalKey)
          logCodexSidecar('warn', 'Unsupported Codex approval request', {
            sessionName: session.name,
            threadId,
            method,
            ...approvalDetails,
          })
          appendStreamEvent(session, approvalEvent)
          broadcastStreamEvent(session, approvalEvent)
          schedulePersistedSessionsWrite()
        }
        return
      }

      const normalized = normalizeCodexEvent(method, params)
      if (!normalized) return
      const events = Array.isArray(normalized) ? normalized : [normalized]
      for (const event of events) {
        appendStreamEvent(session, event)
        broadcastStreamEvent(session, event)
      }
    })
    session.codexNotificationCleanup = notificationCleanup

    if (task.length > 0) {
      try {
        await startCodexTurn(session, task)
      } catch (error) {
        notificationCleanup()
        session.codexNotificationCleanup = undefined
        throw error
      }

      resetActiveTurnState(session)
      scheduleCodexTurnWatchdog(session)
      const userEvent: StreamJsonEvent = {
        type: 'user',
        message: { role: 'user', content: task },
      } as unknown as StreamJsonEvent
      appendStreamEvent(session, userEvent)
      broadcastStreamEvent(session, userEvent)
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

    const hasSystemPrompt = typeof options.systemPrompt === 'string' && options.systemPrompt.length > 0
    const initialTask = hasSystemPrompt ? '' : task

    const threadStartParams: {
      cwd: string
      sandbox: string
      approvalPolicy: string
      developerInstructions?: string
    } = {
      cwd: sessionCwd,
      sandbox,
      approvalPolicy,
    }
    if (hasSystemPrompt) {
      threadStartParams.developerInstructions = options.systemPrompt
    }

    let threadId: string
    if (options.resumeSessionId) {
      threadId = options.resumeSessionId
      await sendCodexRequest('thread/resume', { threadId })
    } else {
      const threadResult = await sendCodexRequest('thread/start', threadStartParams) as { thread: { id: string } }
      threadId = threadResult.thread.id
    }

    return createCodexSessionFromThread(
      sessionName,
      mode,
      sessionCwd,
      threadId,
      initialTask,
      options,
    )
  }

  async function resumeCodexAppServerSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    cwd: string,
    threadId: string,
    createdAt: string,
    resumedFrom?: string,
  ): Promise<StreamSession> {
    await ensureCodexSidecar()
    await sendCodexRequest('thread/resume', { threadId })
    return createCodexSessionFromThread(sessionName, mode, cwd, threadId, '', {
      createdAt,
      resumedFrom,
    })
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

    const resumeFromSession = parseOptionalSessionName(req.body?.resumeFromSession)
    if (resumeFromSession === null) {
      res.status(400).json({ error: 'Invalid resume session name' })
      return
    }

    if (sessions.has(sessionName)) {
      res.status(409).json({ error: `Session "${sessionName}" already exists` })
      return
    }

    let resumeSource: ResolvedResumableSessionSource | undefined
    if (resumeFromSession) {
      let persistedState: PersistedSessionsState
      try {
        persistedState = await readPersistedSessionsState()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load persisted sessions'
        res.status(500).json({ error: message })
        return
      }

      const resolved = resolveResumableSessionSource(resumeFromSession, persistedState)
      if (!resolved.source) {
        res.status(resolved.error?.status ?? 404).json({
          error: resolved.error?.message ?? `Session "${resumeFromSession}" is not resumable`,
        })
        return
      }
      resumeSource = resolved.source
    }

    if (sessions.size >= maxSessions && !resumeSource?.liveSession) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    const cwd = resumeSource?.source.cwd ?? parseCwd(req.body?.cwd)
    if (cwd === null) {
      res.status(400).json({ error: 'Invalid cwd: must be an absolute path' })
      return
    }

    const sessionType = resumeSource ? 'stream' : parseSessionType(req.body?.sessionType)
    const agentType = resumeSource?.source.agentType ?? parseAgentType(req.body?.agentType)
    const requestedHost = resumeSource?.source.host ?? parseOptionalHost(req.body?.host)
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

    if (
      resumeSource &&
      !resumeSource.liveSession &&
      resumeSource.source.agentType === 'codex' &&
      resumeSource.source.codexThreadId &&
      !(await hasCodexRolloutFile(resumeSource.source.codexThreadId, resumeSource.source.createdAt))
    ) {
      clearCodexResumeMetadata(resumeFromSession!)
      res.status(409).json({
        error: codexRolloutUnavailableMessage(resumeFromSession!),
      })
      return
    }

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

      try {
        const session = resumeSource
          ? (
              agentType === 'codex'
                ? await createCodexAppServerSession(sessionName, mode, task ?? '', requestedMachineCwd, {
                  resumeSessionId: resumeSource.source.codexThreadId,
                  resumedFrom: resumeFromSession,
                })
                : createStreamSession(sessionName, mode, task ?? '', requestedMachineCwd, machine, agentType, {
                  resumeSessionId: resumeSource.source.claudeSessionId,
                  resumedFrom: resumeFromSession,
                })
            )
          : (
              agentType === 'codex'
                ? await createCodexAppServerSession(sessionName, mode, task ?? '', requestedMachineCwd)
                : createStreamSession(sessionName, mode, task ?? '', requestedMachineCwd, machine, agentType)
            )
        if (resumeSource?.liveSession) {
          retireLiveCodexSessionForResume(resumeFromSession!, resumeSource.liveSession)
        }
        sessions.set(sessionName, session)
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
        if (resumeFromSession && isMissingCodexRolloutError(err)) {
          clearCodexResumeMetadata(resumeFromSession)
          res.status(409).json({
            error: codexRolloutUnavailableMessage(resumeFromSession),
          })
          return
        }
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

    const session = sessions.get(sessionName)
    if (!session || (session.kind !== 'stream' && session.kind !== 'openclaw')) {
      res.status(404).json({ error: `Stream session "${sessionName}" not found` })
      return
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (text.length === 0) {
      res.status(400).json({ error: 'text must be a non-empty string' })
      return
    }

    if (session.kind === 'openclaw') {
      const sent = await dispatchOpenClawHook(session, text)
      res.json({ sent })
      return
    }

    const sent = await sendTextToStreamSession(session, text)
    if (!sent) {
      res.status(503).json({ sent: false, error: 'Stream session unavailable' })
      return
    }

    res.json({ sent: true })
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

    if (session.kind === 'pty') {
      res.json({ debriefed: false, reason: 'pty-session' })
      return
    }

    if (session.kind !== 'stream') {
      res.json({ debriefed: false, reason: 'unsupported-session-type' })
      return
    }

    if (session.agentType === 'openclaw') {
      res.json({ debriefed: false, reason: 'unsupported-agent-type' })
      return
    }

    // Keep the kill flow non-blocking until the full debrief pipeline is
    // ported into this app codepath.
    res.json({ debriefStarted: false, reason: 'not-supported-yet' })
  })

  router.get('/sessions/:name/debrief-status', requireWriteAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    res.json({ status: 'none' })
  })

  router.delete('/sessions/:name', requireWriteAccess, async (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session) {
      const hadExited = exitedStreamSessions.delete(sessionName)
      const hadCompleted = completedSessions.delete(sessionName)
      if (hadExited || hadCompleted) {
        schedulePersistedSessionsWrite()
        res.json({ killed: true })
        return
      }
      res.status(404).json({ error: `Session "${sessionName}" not found` })
      return
    }

    for (const client of session.clients) {
      client.close(1000, 'Session killed')
    }

    if (session.kind === 'pty') {
      session.pty.kill()
    } else if (session.kind === 'stream') {
      if (session.agentType === 'codex') {
        clearCodexTurnWatchdog(session)
        markCodexTurnHealthy(session)
      }
      session.process.kill('SIGTERM')
    } else if (session.kind === 'openclaw') {
      session.gatewayWs?.close()
      session.gatewayWs = null
    }
    // External sessions have no local process — just remove from the map.

    sessions.delete(sessionName)
    exitedStreamSessions.delete(sessionName)
    completedSessions.delete(sessionName)
    sessionEventHandlers.delete(sessionName)
    schedulePersistedSessionsWrite()

    res.json({ killed: true })
  })

  function buildPersistedEntryFromExitedSession(
    sessionName: string,
    exited: ExitedStreamSessionState,
  ): PersistedStreamSession {
    return {
      name: sessionName,
      agentType: exited.agentType,
      mode: exited.mode,
      cwd: exited.cwd,
      host: exited.host,
      createdAt: exited.createdAt,
      claudeSessionId: exited.claudeSessionId,
      codexThreadId: exited.codexThreadId,
      parentSession: exited.parentSession,
      spawnedWorkers: [...exited.spawnedWorkers],
      resumedFrom: exited.resumedFrom,
      sessionState: 'exited',
      hadResult: exited.hadResult,
      conversationEntryCount: exited.conversationEntryCount,
      events: [...exited.events],
    }
  }

  function buildPersistedEntryFromLiveStreamSession(
    sessionName: string,
    session: StreamSession,
  ): PersistedStreamSession {
    return {
      name: sessionName,
      agentType: session.agentType,
      mode: session.mode,
      cwd: session.cwd,
      host: session.host,
      createdAt: session.createdAt,
      claudeSessionId: session.claudeSessionId,
      codexThreadId: session.codexThreadId,
      parentSession: session.parentSession,
      spawnedWorkers: [...session.spawnedWorkers],
      resumedFrom: session.resumedFrom,
      sessionState: 'active',
      hadResult: Boolean(session.finalResultEvent),
      conversationEntryCount: session.conversationEntryCount,
      events: [...session.events],
    }
  }

function parseCodexSidecarError(error: unknown): { code?: number; message?: string } | null {
  if (!(error instanceof Error)) {
    return null
  }

  try {
    const parsed = JSON.parse(error.message) as { code?: unknown; message?: unknown }
    return {
      code: typeof parsed.code === 'number' ? parsed.code : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
    }
  } catch {
    return null
  }
}

function isMissingCodexRolloutError(error: unknown): boolean {
  const parsed = parseCodexSidecarError(error)
  return parsed?.code === -32600 && Boolean(parsed.message?.includes('no rollout found for thread id'))
}

function codexRolloutUnavailableMessage(sessionName: string): string {
  return `Session "${sessionName}" can no longer be resumed because its Codex rollout is unavailable`
}

function codexRolloutDirectoryForCreatedAt(createdAt: string): string | null {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  const iso = date.toISOString()
  return path.join(homedir(), '.codex', 'sessions', iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10))
}

async function hasCodexRolloutFile(threadId: string, createdAt: string): Promise<boolean> {
  const directory = codexRolloutDirectoryForCreatedAt(createdAt)
  if (!directory) {
    return true
  }

  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && entry.name.includes(threadId))
  } catch {
    return false
  }
}

async function isExitedSessionResumeAvailable(entry: PersistedStreamSession): Promise<boolean> {
  if (!hasResumeIdentifier(entry)) {
    return false
  }

  if (entry.agentType !== 'codex' || !entry.codexThreadId) {
    return true
  }

  return hasCodexRolloutFile(entry.codexThreadId, entry.createdAt)
}

  function hasResumeIdentifier(entry: PersistedStreamSession): boolean {
    if (entry.agentType === 'claude') {
      return Boolean(entry.claudeSessionId)
    }
    if (entry.agentType === 'codex') {
      return Boolean(entry.codexThreadId)
    }
    return false
  }

  function canResumeLiveStreamSession(session: StreamSession): boolean {
    return (
      session.agentType === 'codex' &&
      Boolean(session.codexThreadId) &&
      Boolean(session.codexTurnStaleAt)
    )
  }

  function snapshotExitedStreamSession(session: StreamSession): ExitedStreamSessionState {
    return {
      phase: 'exited',
      hadResult: Boolean(session.finalResultEvent),
      agentType: session.agentType,
      mode: session.mode,
      cwd: session.cwd,
      host: session.host,
      parentSession: session.parentSession,
      spawnedWorkers: [...session.spawnedWorkers],
      createdAt: session.createdAt,
      claudeSessionId: session.claudeSessionId,
      codexThreadId: session.codexThreadId,
      resumedFrom: session.resumedFrom,
      conversationEntryCount: session.conversationEntryCount,
      events: [...session.events],
    }
  }

  function clearCodexResumeMetadata(sessionName: string): void {
    const liveSession = sessions.get(sessionName)
    if (liveSession?.kind === 'stream' && liveSession.agentType === 'codex') {
      liveSession.codexThreadId = undefined
      liveSession.codexTurnStaleAt = undefined
    }

    const exitedSession = exitedStreamSessions.get(sessionName)
    if (exitedSession?.agentType === 'codex') {
      exitedSession.codexThreadId = undefined
    }

    schedulePersistedSessionsWrite()
  }

  function retireLiveCodexSessionForResume(sessionName: string, session: StreamSession): void {
    clearCodexTurnWatchdog(session)
    markCodexTurnHealthy(session)
    session.codexNotificationCleanup?.()
    session.codexNotificationCleanup = undefined
    for (const client of session.clients) {
      client.close(1000, 'Session resumed')
    }
    exitedStreamSessions.set(sessionName, snapshotExitedStreamSession(session))
    sessions.delete(sessionName)
    sessionEventHandlers.delete(sessionName)
  }

  function resolveResumableSessionSource(
    sessionName: string,
    persistedState: PersistedSessionsState,
  ): { source?: ResolvedResumableSessionSource; error?: { status: number; message: string } } {
    const liveSession = sessions.get(sessionName)
    if (liveSession) {
      if (liveSession.kind !== 'stream' || liveSession.agentType === 'openclaw') {
        return {
          error: { status: 404, message: `Session "${sessionName}" is not resumable` },
        }
      }
      if (!canResumeLiveStreamSession(liveSession)) {
        return {
          error: { status: 409, message: `Session "${sessionName}" is not resumable right now` },
        }
      }
      return {
        source: {
          source: buildPersistedEntryFromLiveStreamSession(sessionName, liveSession),
          liveSession,
        },
      }
    }

    const exitedSession = exitedStreamSessions.get(sessionName)
    const persistedSource = persistedState.sessions.find((entry) => entry.name === sessionName)
    let source = exitedSession ? buildPersistedEntryFromExitedSession(sessionName, exitedSession) : undefined
    if ((!source || !hasResumeIdentifier(source)) && persistedSource) {
      source = persistedSource
    }

    if (!source || source.agentType === 'openclaw') {
      return {
        error: { status: 404, message: `Session "${sessionName}" not found` },
      }
    }

    if (!hasResumeIdentifier(source)) {
      return {
        error: { status: 409, message: `Session "${sessionName}" is missing resume metadata` },
      }
    }

    return { source: { source } }
  }

  router.post('/sessions/:name/resume', requireWriteAccess, async (req, res) => {
    const originalName = parseSessionName(req.params.name)
    if (!originalName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    let persistedState: PersistedSessionsState
    try {
      persistedState = await readPersistedSessionsState()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load persisted sessions'
      res.status(500).json({ error: message })
      return
    }

    const resolved = resolveResumableSessionSource(originalName, persistedState)
    if (!resolved.source) {
      res.status(resolved.error?.status ?? 404).json({
        error: resolved.error?.message ?? `Session "${originalName}" is not resumable`,
      })
      return
    }
    const { source, liveSession } = resolved.source

    if (sessions.size >= maxSessions && !liveSession) {
      res.status(429).json({ error: `Session limit reached (${maxSessions})` })
      return
    }

    if (source.agentType === 'codex' && source.host) {
      res.status(400).json({
        error: 'Remote stream sessions are currently supported for claude only',
      })
      return
    }

    let machine: MachineConfig | undefined
    if (source.host) {
      try {
        const machines = await readMachineRegistry()
        machine = machines.find((entry) => entry.id === source.host)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read machines registry'
        res.status(500).json({ error: message })
        return
      }
      if (!machine) {
        res.status(400).json({ error: `Unknown host machine "${source.host}"` })
        return
      }
    }

    if (
      !liveSession &&
      source.agentType === 'codex' &&
      source.codexThreadId &&
      !(await hasCodexRolloutFile(source.codexThreadId, source.createdAt))
    ) {
      clearCodexResumeMetadata(originalName)
      res.status(409).json({
        error: codexRolloutUnavailableMessage(originalName),
      })
      return
    }

    try {
      const resumedSession = source.agentType === 'codex'
        ? await createCodexAppServerSession(originalName, source.mode, '', source.cwd, {
          resumeSessionId: source.codexThreadId,
          resumedFrom: source.resumedFrom,
        })
        : createStreamSession(
          originalName,
          source.mode,
          '',
          source.cwd,
          machine,
          'claude',
          {
            resumeSessionId: source.claudeSessionId,
            resumedFrom: source.resumedFrom,
          },
        )
      if (liveSession) {
        retireLiveCodexSessionForResume(originalName, liveSession)
      }
      completedSessions.delete(originalName)
      sessions.set(originalName, resumedSession)
      schedulePersistedSessionsWrite()
      res.status(201).json({
        name: originalName,
        resumedFrom: originalName,
      })
    } catch (error) {
      if (isMissingCodexRolloutError(error)) {
        clearCodexResumeMetadata(originalName)
        res.status(409).json({
          error: codexRolloutUnavailableMessage(originalName),
        })
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to resume session'
      res.status(500).json({ error: message })
    }
  })

  // ── External session teleport endpoints ───────────────────────────

  router.post('/sessions/register', requireWriteAccess, (req, res) => {
    const name = parseSessionName(req.body?.name)
    if (!name) {
      res.status(400).json({ error: 'Invalid or missing session name' })
      return
    }

    if (sessions.has(name)) {
      res.status(409).json({ error: `Session "${name}" already exists` })
      return
    }

    if (sessions.size >= maxSessions) {
      res.status(503).json({ error: 'Maximum session limit reached' })
      return
    }

    const agentType = parseAgentType(req.body?.agentType)
    const machine = typeof req.body?.machine === 'string' ? req.body.machine.trim() : ''
    const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : ''
    const task = typeof req.body?.task === 'string' ? req.body.task.trim() : undefined
    const metadata = typeof req.body?.metadata === 'object' && req.body.metadata !== null
      ? req.body.metadata as Record<string, unknown>
      : undefined

    if (!machine) {
      res.status(400).json({ error: 'machine is required' })
      return
    }

    const now = Date.now()
    const session: ExternalSession = {
      kind: 'external',
      name,
      agentType,
      machine,
      cwd: cwd || '/',
      host: machine,
      task,
      status: 'connected',
      lastHeartbeat: now,
      events: [],
      clients: new Set(),
      createdAt: new Date(now).toISOString(),
      lastEventAt: new Date(now).toISOString(),
      metadata,
    }

    sessions.set(name, session)
    res.status(201).json({
      registered: true,
      name,
      agentType,
      machine,
      cwd: session.cwd,
    })
  })

  router.post('/sessions/:name/heartbeat', requireWriteAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session || session.kind !== 'external') {
      res.status(404).json({ error: `External session "${sessionName}" not found` })
      return
    }

    const now = Date.now()
    session.lastHeartbeat = now
    session.status = 'connected'
    session.lastEventAt = new Date(now).toISOString()

    // Allow updating metadata on heartbeat
    if (typeof req.body?.metadata === 'object' && req.body.metadata !== null) {
      session.metadata = { ...session.metadata, ...req.body.metadata as Record<string, unknown> }
    }

    res.json({ ok: true, status: session.status })
  })

  router.post('/sessions/:name/events', requireWriteAccess, (req, res) => {
    const sessionName = parseSessionName(req.params.name)
    if (!sessionName) {
      res.status(400).json({ error: 'Invalid session name' })
      return
    }

    const session = sessions.get(sessionName)
    if (!session || session.kind !== 'external') {
      res.status(404).json({ error: `External session "${sessionName}" not found` })
      return
    }

    const events = Array.isArray(req.body?.events) ? req.body.events as unknown[] : []
    if (events.length === 0) {
      res.status(400).json({ error: 'events must be a non-empty array' })
      return
    }

    let accepted = 0
    for (const rawEvent of events) {
      if (typeof rawEvent !== 'object' || rawEvent === null) continue
      const event = rawEvent as StreamJsonEvent
      if (typeof event.type !== 'string' || !event.type) continue

      session.events.push(event)
      session.lastEventAt = new Date().toISOString()
      session.lastHeartbeat = Date.now()
      broadcastStreamEvent(session, event)
      accepted += 1
    }

    // Cap event buffer
    if (session.events.length > MAX_STREAM_EVENTS) {
      session.events = session.events.slice(-MAX_STREAM_EVENTS)
    }

    res.json({ accepted })
  })

  async function restorePersistedSessions(): Promise<void> {
    const persisted = await readPersistedSessionsState()
    if (persisted.sessions.length === 0) return

    for (const entry of persisted.sessions) {
      if (sessions.has(entry.name)) {
        continue
      }

      try {
        if (entry.sessionState === 'exited') {
          const hadResult = entry.hadResult ?? false
          if (
            (entry.agentType === 'claude' && !entry.claudeSessionId) ||
            (entry.agentType === 'codex' && !entry.codexThreadId)
          ) {
            continue
          }

          exitedStreamSessions.set(entry.name, {
            phase: 'exited',
            hadResult,
            agentType: entry.agentType,
            mode: entry.mode,
            cwd: entry.cwd,
            host: entry.host,
            parentSession: entry.parentSession,
            spawnedWorkers: entry.spawnedWorkers ? [...entry.spawnedWorkers] : [],
            createdAt: entry.createdAt,
            claudeSessionId: entry.claudeSessionId,
            codexThreadId: entry.codexThreadId,
            resumedFrom: entry.resumedFrom,
            conversationEntryCount: entry.conversationEntryCount ?? countCompletedTurnEntries(entry.events ?? []),
            events: entry.events ? [...entry.events] : [],
          })

          if (hadResult) {
            const events = entry.events ?? []
            const resultEvent = [...events].reverse().find((evt) => evt.type === 'result')
            if (resultEvent) {
              const totalCost = typeof resultEvent.total_cost_usd === 'number'
                ? resultEvent.total_cost_usd
                : (typeof resultEvent.cost_usd === 'number' ? resultEvent.cost_usd : 0)
              completedSessions.set(
                entry.name,
                toCompletedSession(
                  entry.name,
                  entry.createdAt,
                  resultEvent,
                  totalCost,
                ),
              )
            } else {
              completedSessions.set(entry.name, {
                name: entry.name,
                completedAt: entry.createdAt,
                subtype: 'success',
                finalComment: '',
                costUsd: 0,
              })
            }
          }
          continue
        }

        if (sessions.size >= maxSessions) {
          break
        }

        if (entry.agentType === 'codex') {
          if (!entry.codexThreadId || entry.host) {
            continue
          }
          const session = await resumeCodexAppServerSession(
            entry.name,
            entry.mode,
            entry.cwd,
            entry.codexThreadId,
            entry.createdAt,
            entry.resumedFrom,
          )
          sessions.set(entry.name, session)
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
            resumedFrom: entry.resumedFrom,
          },
        )
        // Restore accumulated event history for WS replay and rebuild usage totals.
        if (entry.events && entry.events.length > 0) {
          session.events = entry.events
          for (const evt of session.events) {
            applyStreamUsageEvent(session, evt)
          }
        }
        session.conversationEntryCount = entry.conversationEntryCount ?? countCompletedTurnEntries(session.events)
        sessions.set(entry.name, session)
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
        if (session.kind === 'stream' || session.kind === 'openclaw' || session.kind === 'external') {
          // Stream/external session: send buffered events as JSON array for replay.
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

          ws.on('message', async (data) => {
            // Look up the live session on every message — the map entry may have
            // been replaced by a respawn while this WS connection is still open.
            // Using the stale closed-over `session` after a respawn would write to
            // the dead process and trigger repeated respawn loops.
            const liveSession = sessions.get(sessionName)
            if (!liveSession || liveSession.kind === 'pty') {
              ws.close(4004, 'Session not found')
              return
            }

            // External sessions are read-only viewers — ignore input from WS clients.
            if (liveSession.kind === 'external') return

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
                // For codex sessions, use the sidecar transport and only
                // record the user event after Codex accepts the turn.
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
                    await sendTextToStreamSession(liveSession, inputText)
                  }
                } else {
                  // Clear completed state on new input so the RPG world-state poller
                  // immediately sees the session as active again. Command-room sessions
                  // are intentionally one-shot and must remain in completed state.
                  if (liveSession.lastTurnCompleted && !isCommandRoomSessionName(sessionName)) {
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
                      .then((machines) => {
                        const machine = liveSession.host
                          ? machines.find((m) => m.id === liveSession.host)
                          : undefined
                        const newSession = createStreamSession(
                          sessionName,
                          liveSession.mode,
                          '',
                          liveSession.cwd,
                          machine,
                          'claude',
                          {
                            resumeSessionId: resumeId,
                            parentSession: liveSession.parentSession,
                            spawnedWorkers: liveSession.spawnedWorkers,
                            resumedFrom: liveSession.resumedFrom,
                          },
                        )
                        newSession.events = liveSession.events.slice()
                        newSession.usage = { ...liveSession.usage }
                        newSession.conversationEntryCount = liveSession.conversationEntryCount
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
            session = await createCodexAppServerSession(
              name,
              'dangerouslySkipPermissions',
              '',
              sessionCwd,
              { resumeSessionId: resumeCodexThreadId },
            )
          } catch {
            session = await createCodexAppServerSession(
              name,
              'dangerouslySkipPermissions',
              '',
              sessionCwd,
              { systemPrompt },
            )
          }
        } else {
          session = await createCodexAppServerSession(
            name,
            'dangerouslySkipPermissions',
            '',
            sessionCwd,
            { systemPrompt },
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
      sessions.set(name, session)
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

      for (const client of session.clients) {
        client.close(1000, 'Commander stopped')
      }

      if (session.kind === 'stream') {
        if (session.agentType === 'codex') {
          clearCodexTurnWatchdog(session)
          markCodexTurnHealthy(session)
        }
        session.process.kill('SIGTERM')
      } else if (session.kind === 'openclaw') {
        session.gatewayWs?.close()
        session.gatewayWs = null
      } else if (session.kind === 'pty') {
        session.pty.kill()
      }
      // External sessions have no local process.

      sessions.delete(name)
      sessionEventHandlers.delete(name)
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
