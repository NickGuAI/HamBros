import { Router } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import multer from 'multer'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { createAuth0Verifier } from '../../server/middleware/auth0.js'

const DEFAULT_MAX_SESSIONS = 10
const DEFAULT_TASK_DELAY_MS = 3000
const DEFAULT_WS_KEEPALIVE_INTERVAL_MS = 30000
const MAX_BUFFER_BYTES = 256 * 1024
const MAX_STREAM_EVENTS = 1000
const SESSION_NAME_PATTERN = /^[\w-]+$/
const FILE_NAME_PATTERN = /^[a-zA-Z0-9._\- ]+$/
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const DEFAULT_SESSION_STORE_PATH = 'data/agents/stream-sessions.json'

type ClaudePermissionMode = 'default' | 'acceptEdits' | 'dangerouslySkipPermissions'

type AgentType = 'claude' | 'codex'

function parseAgentType(raw: unknown): AgentType {
  if (raw === 'codex') return 'codex'
  return 'claude'
}

const CLAUDE_MODE_COMMANDS: Record<ClaudePermissionMode, string> = {
  default: 'unset CLAUDECODE && claude',
  acceptEdits: 'unset CLAUDECODE && claude --acceptEdits',
  dangerouslySkipPermissions: 'unset CLAUDECODE && claude --dangerously-skip-permissions',
}

const CODEX_MODE_COMMANDS: Record<ClaudePermissionMode, string> = {
  default: 'codex',
  acceptEdits: 'codex --full-auto',
  dangerouslySkipPermissions: 'codex --dangerously-bypass-approvals-and-sandbox',
}

export interface AgentSession {
  name: string
  created: string
  pid: number
  sessionType?: 'pty' | 'stream'
  agentType?: AgentType
  cwd?: string
  host?: string
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
  pty: PtyHandle
  buffer: string
  clients: Set<WebSocket>
  createdAt: string
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
  process: ChildProcess
  events: StreamJsonEvent[]
  clients: Set<WebSocket>
  createdAt: string
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  stdoutBuffer: string
  stdinDraining: boolean
  lastTurnCompleted: boolean
  claudeSessionId?: string
  codexThreadId?: string
}

type AnySession = PtySession | StreamSession

export interface AgentsRouterOptions {
  ptySpawner?: PtySpawner
  maxSessions?: number
  taskDelayMs?: number
  wsKeepAliveIntervalMs?: number
  sessionStorePath?: string
  autoResumeSessions?: boolean
  machinesFilePath?: string
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
}

export interface AgentsRouterResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
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

interface MachineConfig {
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
  claudeSessionId?: string
  codexThreadId?: string
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

  if (!SESSION_NAME_PATTERN.test(name)) {
    return null
  }
  if (!mode) {
    return null
  }
  if (!cwd.startsWith('/')) {
    return null
  }

  return {
    name,
    mode,
    agentType,
    cwd: path.resolve(cwd),
    host,
    createdAt,
    claudeSessionId,
    codexThreadId,
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

function buildClaudeStreamArgs(
  mode: ClaudePermissionMode,
  resumeSessionId?: string,
): string[] {
  // Claude CLI requires --verbose when using --print (-p) with stream-json output.
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json']
  if (mode === 'acceptEdits') {
    args.push('--acceptEdits')
  } else if (mode === 'dangerouslySkipPermissions') {
    args.push('--dangerously-skip-permissions')
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
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

export function createAgentsRouter(options: AgentsRouterOptions = {}): AgentsRouterResult {
  const router = Router()
  const sessions = new Map<string, AnySession>()
  const wss = new WebSocketServer({ noServer: true })
  const maxSessions = parseMaxSessions(options.maxSessions)
  const taskDelayMs = parseTaskDelayMs(options.taskDelayMs)
  const wsKeepAliveIntervalMs = parseWsKeepAliveIntervalMs(options.wsKeepAliveIntervalMs)
  const autoResumeSessions = options.autoResumeSessions ?? true
  const sessionStorePath = options.sessionStorePath
    ? path.resolve(options.sessionStorePath)
    : path.resolve(process.cwd(), DEFAULT_SESSION_STORE_PATH)
  const machinesFilePath = options.machinesFilePath
    ? path.resolve(options.machinesFilePath)
    : path.resolve(process.cwd(), 'data/machines.json')

  let spawner: PtySpawner | null = options.ptySpawner ?? null
  let cachedMachines: MachineConfig[] | null = null
  let cachedMachinesMtimeMs = -1
  let persistSessionStateQueue = Promise.resolve()

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

      if (session.agentType === 'claude' && (!session.claudeSessionId || !session.lastTurnCompleted)) continue
      if (session.agentType === 'codex' && !session.codexThreadId) continue

      restoredSessions.push({
        name: session.name,
        agentType: session.agentType,
        mode: session.mode,
        cwd: session.cwd,
        host: session.host,
        createdAt: session.createdAt,
        claudeSessionId: session.claudeSessionId,
        codexThreadId: session.codexThreadId,
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
  })
  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
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
          proc.on('close', (code) => { resolve({ stdout, stderr, code: code ?? 1 }) })
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
        if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const fullPath = path.join(targetDir, entry.name)
        const resolved = await realpath(fullPath)

        if (resolved !== homeBase && !resolved.startsWith(homeBase + '/')) {
          continue
        }

        directories.push(resolved)
      }

      directories.sort((a, b) => a.localeCompare(b))

      res.json({ parent: targetDir, directories })
    } catch {
      res.status(400).json({ error: 'Cannot read directory' })
    }
  })

  router.get('/skills', requireReadAccess, async (_req, res) => {
    const skillsDir = path.join(homedir(), '.claude', 'skills')
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true })
      const skills: Array<{ name: string; description: string; userInvocable: boolean; argumentHint?: string }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md')
        try {
          const content = await readFile(skillMd, 'utf-8')
          const fm = parseFrontmatter(content)
          if (fm['user-invocable'] === true || fm['user-invocable'] === 'true') {
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

      res.json(skills)
    } catch {
      res.json([])
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

  router.get('/sessions', requireReadAccess, async (_req, res) => {
    const result: AgentSession[] = []
    for (const [name, session] of sessions) {
      const pid = session.kind === 'pty' ? session.pty.pid : (session.process.pid ?? 0)
      result.push({
        name,
        created: session.createdAt,
        pid,
        sessionType: session.kind,
        agentType: session.agentType,
        cwd: session.cwd,
        host: session.host,
      })
    }
    res.json(result)
  })

  // ── Stream session helpers ──────────────────────────────────────
  function appendStreamEvent(session: StreamSession, event: StreamJsonEvent): void {
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
      if (wasCompleted && session.agentType === 'claude') {
        schedulePersistedSessionsWrite()
      }
    }
    if (evtType === 'result') {
      const wasCompleted = session.lastTurnCompleted
      session.lastTurnCompleted = true
      if (!wasCompleted && session.agentType === 'claude') {
        schedulePersistedSessionsWrite()
      }
    }
    if (evtType === 'message_delta' && event.usage) {
      const u = event.usage as { input_tokens?: number; output_tokens?: number }
      if (u.input_tokens !== undefined) session.usage.inputTokens += u.input_tokens
      if (u.output_tokens !== undefined) session.usage.outputTokens += u.output_tokens
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
  }

  function broadcastStreamEvent(session: StreamSession, event: StreamJsonEvent): void {
    const payload = JSON.stringify(event)
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
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

  function createStreamSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
    machine: MachineConfig | undefined,
    agentType: AgentType = 'claude',
    resumeSessionId?: string,
    createdAt?: string,
  ): StreamSession {
    const args = buildClaudeStreamArgs(mode, resumeSessionId)

    const remote = isRemoteMachine(machine)
    const localSpawnCwd = process.env.HOME || '/tmp'
    const requestedCwd = cwd ?? machine?.cwd
    const sessionCwd = requestedCwd ?? localSpawnCwd
    const spawnCommand = remote ? 'ssh' : 'claude'
    // For remote stream sessions, wrap in a login shell so PATH includes
    // tools installed in user-local directories (e.g. ~/.local/bin on macOS).
    const remoteClaude = ['claude', ...args].map(shellEscape).join(' ')
    const remoteStreamCmd = requestedCwd
      ? `cd ${shellEscape(requestedCwd)} && exec $SHELL -lc ${shellEscape(remoteClaude)}`
      : `exec $SHELL -lc ${shellEscape(remoteClaude)}`
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
      process: childProcess,
      events: [],
      clients: new Set(),
      createdAt: createdAt ?? new Date().toISOString(),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stdoutBuffer: '',
      stdinDraining: false,
      lastTurnCompleted: true,
      claudeSessionId: resumeSessionId,
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
      // spawn ENOENT) it may be followed by 'exit'.  Without this check the
      // second handler would operate on a stale session object whose events
      // buffer would grow unreachable in memory until GC.
      if (!sessions.has(sessionName)) return

      // If the process exits mid-turn, avoid persisting --resume state that
      // would replay an assistant prefill unsupported by newer Claude models.
      if (session.agentType === 'claude' && !session.lastTurnCompleted) {
        session.claudeSessionId = undefined
      }

      const exitEvent: StreamJsonEvent = {
        type: 'exit',
        exitCode: code ?? -1,
        signal: signal ?? undefined,
      }
      appendStreamEvent(session, exitEvent)
      broadcastStreamEvent(session, exitEvent)
      // Close all WebSocket clients so they receive the exit event and
      // cleanly disconnect rather than discovering a deleted session later.
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }
      sessions.delete(sessionName)
      schedulePersistedSessionsWrite()
    })

    cpEmitter.on('error', (err: Error) => {
      // Guard against duplicate cleanup — see 'exit' handler comment above.
      if (!sessions.has(sessionName)) return

      const errorEvent: StreamJsonEvent = {
        type: 'system',
        text: `Process error: ${err.message}`,
      }
      appendStreamEvent(session, errorEvent)
      broadcastStreamEvent(session, errorEvent)

      // On spawn failure (e.g. ENOENT), 'error' may fire without a
      // subsequent 'exit' event.  Clean up the session to prevent zombie
      // entries that never auto-clean.
      for (const client of session.clients) {
        client.close(1000, 'Session ended')
      }
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
        srv.on('error', reject)
      })
      codexSidecar.port = port

      const cp = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      codexSidecar.process = cp

      cp.on('exit', () => {
        codexSidecar.process = null
        codexSidecar.ws = null
      })
      cp.on('error', () => {
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
      clientInfo: { name: 'hambros', version: '0.1.0' },
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

  function normalizeCodexEvent(method: string, params: unknown): StreamJsonEvent | StreamJsonEvent[] | null {
    const p = params as Record<string, unknown>

    switch (method) {
      case 'thread/started':
        return { type: 'system', text: 'Codex session started' }
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
        const text = (p as Record<string, unknown>).text as string | undefined
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
          const content = item.content as Array<{ type: string; text?: string }> | undefined
          const text = content?.map(c => c.text ?? '').join('') ?? ''
          return {
            type: 'user',
            message: { role: 'user', content: text },
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
          return {
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{ type: 'text', text: item.text as string ?? '' }],
            },
          } as unknown as StreamJsonEvent
        }
        if (itemType === 'reasoning') {
          return {
            type: 'assistant',
            message: {
              id: itemId,
              role: 'assistant',
              content: [{ type: 'thinking', thinking: item.text as string ?? '' }],
            },
          } as unknown as StreamJsonEvent
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
    createdAt?: string,
  ): Promise<StreamSession> {
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
      process: fakeProcess,
      events: [],
      clients: new Set(),
      createdAt: createdAt ?? new Date().toISOString(),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stdoutBuffer: '',
      stdinDraining: false,
      lastTurnCompleted: true,
      codexThreadId: threadId,
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

      void sendCodexRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: task }],
      }).catch(() => {})
    }

    return session
  }

  async function createCodexAppServerSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    task: string,
    cwd: string | undefined,
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
    )
  }

  async function resumeCodexAppServerSession(
    sessionName: string,
    mode: ClaudePermissionMode,
    cwd: string,
    threadId: string,
    createdAt: string,
  ): Promise<StreamSession> {
    await ensureCodexSidecar()
    await sendCodexRequest('thread/resume', { threadId })
    return createCodexSessionFromThread(sessionName, mode, cwd, threadId, '', createdAt)
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

    if (sessions.size >= maxSessions) {
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

    if (sessionType === 'stream') {
      if (remoteMachine && agentType === 'codex') {
        res.status(400).json({
          error: 'Remote stream sessions are currently supported for claude only',
        })
        return
      }

      try {
        const session = agentType === 'codex'
          ? await createCodexAppServerSession(sessionName, mode, task ?? '', requestedMachineCwd)
          : createStreamSession(sessionName, mode, task ?? '', requestedMachineCwd, machine, agentType)
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

      const session: PtySession = {
        kind: 'pty',
        name: sessionName,
        agentType,
        cwd: sessionCwd,
        host: remoteMachine?.id,
        pty,
        buffer: '',
        clients: new Set(),
        createdAt: new Date().toISOString(),
      }

      pty.onData((data) => {
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

    for (const client of session.clients) {
      client.close(1000, 'Session killed')
    }

    if (session.kind === 'pty') {
      session.pty.kill()
    } else {
      session.process.kill('SIGTERM')
    }

    sessions.delete(sessionName)
    schedulePersistedSessionsWrite()

    res.json({ killed: true })
  })

  async function restorePersistedSessions(): Promise<void> {
    const persisted = await readPersistedSessionsState()
    if (persisted.sessions.length === 0) return

    for (const entry of persisted.sessions) {
      if (sessions.size >= maxSessions) {
        break
      }
      if (sessions.has(entry.name)) {
        continue
      }

      try {
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
          entry.claudeSessionId,
          entry.createdAt,
        )
        sessions.set(entry.name, session)
      } catch {
        // Ignore individual restore failures and continue restoring others.
      }
    }

    schedulePersistedSessionsWrite()
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
    const apiKeyHeader = req.headers['x-hambros-api-key'] as string | undefined
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
    // Expected path: /api/agents/sessions/:name/terminal
    const match = url.pathname.match(/\/sessions\/([^/]+)\/terminal$/)
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
        if (session.kind === 'stream') {
          // Stream session: send buffered events as JSON array for replay.
          // Include the accumulated usage so the client can set totals
          // directly rather than re-accumulating from individual deltas.
          if (session.events.length > 0) {
            ws.send(JSON.stringify({
              type: 'replay',
              events: session.events,
              usage: session.usage,
            }))
          }

          session.clients.add(ws)
          const stopKeepAlive = attachWebSocketKeepAlive(ws, () => {
            session.clients.delete(ws)
          })

          ws.on('message', (data) => {
            if (!sessions.has(sessionName)) {
              ws.close(4004, 'Session not found')
              return
            }

            try {
              const msg = JSON.parse(data.toString()) as {
                type: string
                text?: string
                toolId?: string
                answers?: Record<string, string[]>
              }
              if (msg.type === 'input' && typeof msg.text === 'string' && msg.text.trim()) {
                // For codex sessions, send turn/start instead of stdin
                const codexThreadId = session.codexThreadId
                if (codexThreadId) {
                  // Persist user message in session events for replay on reconnect
                  const userEvent: StreamJsonEvent = {
                    type: 'user',
                    message: { role: 'user', content: msg.text.trim() },
                  } as unknown as StreamJsonEvent
                  appendStreamEvent(session, userEvent)
                  broadcastStreamEvent(session, userEvent)

                  void sendCodexRequest('turn/start', {
                    threadId: codexThreadId,
                    input: [{ type: 'text', text: msg.text.trim() }],
                  }).catch(() => {})
                } else {
                  const userMsg = JSON.stringify({
                    type: 'user',
                    message: { role: 'user', content: msg.text.trim() },
                  })
                  writeToStdin(session, userMsg + '\n')
                }
              } else if (msg.type === 'tool_answer' && msg.toolId && msg.answers && !session.codexThreadId) {
                // Serialize string[] values to comma-separated strings
                // per the AskUserQuestion contract (answers: Record<string, string>)
                const serialized: Record<string, string> = {}
                for (const [key, val] of Object.entries(msg.answers)) {
                  serialized[key] = Array.isArray(val) ? val.join(', ') : String(val)
                }
                const toolResultMsg = JSON.stringify({
                  type: 'user',
                  message: {
                    role: 'user',
                    content: [{
                      type: 'tool_result',
                      tool_use_id: msg.toolId,
                      content: JSON.stringify({ answers: serialized, annotations: {} }),
                    }],
                  },
                })
                const ok = writeToStdin(session, toolResultMsg + '\n')
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
            session.clients.delete(ws)
          })

          ws.on('error', () => {
            stopKeepAlive()
            session.clients.delete(ws)
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

  return { router, handleUpgrade }
}
