import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { createAuth0Verifier } from '../../server/middleware/auth0.js'
import { CommanderAgent } from './agent.js'
import { CommanderManager } from './manager.js'
import { EmergencyFlusher, type FlushContext } from './memory/index.js'
import type { GHIssue } from './memory/skill-matcher.js'
import {
  CommanderHeartbeatManager,
  createDefaultHeartbeatState,
  mergeHeartbeatState,
  parseHeartbeatPatch,
} from './heartbeat.js'
import {
  CommanderSessionStore,
  type CommanderCurrentTask,
  type CommanderSession,
  type CommanderTaskSource,
} from './store.js'
import { CommanderCronManager, InvalidCronExpressionError } from './cron-manager.js'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const HOST_PATTERN = /^[a-zA-Z0-9_-]+$/
const DEFAULT_WS_KEEPALIVE_INTERVAL_MS = 30_000
const MAX_STREAM_EVENTS = 1_000

const STARTUP_PROMPT = 'Commander runtime started. Acknowledge readiness and await instructions.'
const BASE_SYSTEM_PROMPT =
  'You are Commander, the orchestration agent for GitHub task execution. Follow repo instructions exactly.'

const COMMANDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const CRON_TASK_ID_PATTERN = /^[a-z0-9-]+$/i

type StreamEvent = Record<string, unknown>

interface ClaudeQueryInput {
  prompt: string
  options?: Record<string, unknown>
}

type ClaudeQueryFn = (input: ClaudeQueryInput) => AsyncIterable<unknown>

interface ContextPressureBridge {
  onContextPressure(handler: () => Promise<void> | void): void
  trigger(): Promise<void>
}

interface CommanderRuntime {
  manager: CommanderManager
  agent: CommanderAgent
  flusher: EmergencyFlusher
  contextPressureBridge: ContextPressureBridge
  events: StreamEvent[]
  clients: Set<WebSocket>
  queue: Promise<void>
  abortController: AbortController | null
  lastTaskState: string
  pendingSpikeObservations: string[]
  claudeSessionId?: string
}

export interface CommandersRouterOptions {
  sessionStore?: CommanderSessionStore
  sessionStorePath?: string
  fetchImpl?: typeof fetch
  queryFn?: ClaudeQueryFn
  cronManager?: CommanderCronManager
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  memoryBasePath?: string
  wsKeepAliveIntervalMs?: number
  now?: () => Date
  githubToken?: string
}

export interface CommandersRouterResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
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

function parseIssueNumber(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return null
  }
  return raw
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

function eventToRecord(raw: unknown): StreamEvent {
  if (isObject(raw)) {
    return raw
  }
  return {
    type: 'system',
    text: typeof raw === 'string' ? raw : JSON.stringify(raw),
  }
}

function extractClaudeSessionId(event: StreamEvent): string | undefined {
  const direct = event.session_id
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim()
  }
  const camel = event.sessionId
  if (typeof camel === 'string' && camel.trim()) {
    return camel.trim()
  }
  return undefined
}

function extractCostDelta(event: StreamEvent): { kind: 'absolute' | 'delta'; value: number } | null {
  const total = event.total_cost_usd
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    return { kind: 'absolute', value: total }
  }

  const partial = event.cost_usd
  if (typeof partial === 'number' && Number.isFinite(partial) && partial >= 0) {
    return { kind: 'delta', value: partial }
  }

  const result = event.result
  if (isObject(result)) {
    const nestedTotal = result.total_cost_usd
    if (typeof nestedTotal === 'number' && Number.isFinite(nestedTotal) && nestedTotal >= 0) {
      return { kind: 'absolute', value: nestedTotal }
    }

    const nestedPartial = result.cost_usd
    if (typeof nestedPartial === 'number' && Number.isFinite(nestedPartial) && nestedPartial >= 0) {
      return { kind: 'delta', value: nestedPartial }
    }
  }

  return null
}

function isContextPressureEvent(event: StreamEvent): boolean {
  const type = typeof event.type === 'string' ? event.type : ''
  const subtype = typeof event.subtype === 'string' ? event.subtype : ''
  return type === 'context_pressure' || subtype === 'context_pressure'
}

function toPromptIssue(session: CommanderSession): GHIssue | null {
  if (!session.currentTask) {
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
  const repo = `${session.taskSource.owner}/${session.taskSource.repo}`
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

function appendEvent(runtime: CommanderRuntime, event: StreamEvent): void {
  runtime.events.push(event)
  if (runtime.events.length > MAX_STREAM_EVENTS) {
    runtime.events = runtime.events.slice(-MAX_STREAM_EVENTS)
  }
}

function broadcastEvent(runtime: CommanderRuntime, event: StreamEvent): void {
  const payload = JSON.stringify(event)
  for (const ws of runtime.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }
}

function normalizeWsKeepAliveMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_WS_KEEPALIVE_INTERVAL_MS
  }
  return Math.max(1000, Math.floor(raw))
}

function attachWebSocketKeepAlive(
  ws: WebSocket,
  intervalMs: number,
  onStale: () => void,
): () => void {
  let waitingForPong = false
  let stopped = false

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
  }, intervalMs)

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

  ws.on('pong', onPong)
  ws.on('close', onCloseOrError)
  ws.on('error', onCloseOrError)

  return stop
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

function isInvalidCronError(error: unknown): error is InvalidCronExpressionError {
  return error instanceof InvalidCronExpressionError
}

export function createCommandersRouter(
  options: CommandersRouterOptions = {},
): CommandersRouterResult {
  const router = Router()
  const wss = new WebSocketServer({ noServer: true })
  const now = options.now ?? (() => new Date())
  const fetchImpl = options.fetchImpl ?? fetch
  const githubToken = resolveGitHubToken(options.githubToken)
  const wsKeepAliveIntervalMs = normalizeWsKeepAliveMs(options.wsKeepAliveIntervalMs)
  const sessionStore = options.sessionStore ?? new CommanderSessionStore(options.sessionStorePath)
  const runtimes = new Map<string, CommanderRuntime>()

  const cronManager = options.cronManager ?? new CommanderCronManager({
    dispatcher: {
      sendInstruction: async (commanderId: string, instruction: string) => {
        const runtime = runtimes.get(commanderId)
        if (!runtime) return
        const session = await sessionStore.get(commanderId)
        if (!session) return
        await queueTurn(commanderId, runtime, instruction, BASE_SYSTEM_PROMPT)
      },
    },
  })
  const cronInitialized = cronManager.initialize().catch((error) => {
    console.error('[commanders] Failed to initialize cron manager:', error)
  })

  let cachedQueryFn: ClaudeQueryFn | null = options.queryFn ?? null

  async function getQueryFn(): Promise<ClaudeQueryFn> {
    if (cachedQueryFn) {
      return cachedQueryFn
    }

    const sdkSpecifier: string = '@anthropic-ai/claude-agent-sdk'
    const sdkModule = await import(sdkSpecifier)
    const query = (sdkModule as { query?: ClaudeQueryFn }).query
    if (typeof query !== 'function') {
      throw new Error('Claude Agent SDK did not expose query()')
    }

    cachedQueryFn = query
    return query
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

  async function queueTurn(
    commanderId: string,
    runtime: CommanderRuntime,
    prompt: string,
    systemPrompt: string,
  ): Promise<void> {
    runtime.queue = runtime.queue
      .catch(() => undefined)
      .then(async () => {
        const current = await sessionStore.get(commanderId)
        if (!current || current.state !== 'running') {
          return
        }

        const queryFn = await getQueryFn()
        const abortController = new AbortController()
        runtime.abortController = abortController

        try {
          const stream = queryFn({
            prompt,
            options: {
              cwd: process.cwd(),
              maxTurns: 1,
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
              systemPrompt,
              ...(runtime.claudeSessionId ? { resume: runtime.claudeSessionId } : {}),
              signal: abortController.signal,
              abortSignal: abortController.signal,
            },
          })

          for await (const rawEvent of stream) {
            const event = eventToRecord(rawEvent)
            appendEvent(runtime, event)
            broadcastEvent(runtime, event)

            const claudeSessionId = extractClaudeSessionId(event)
            if (claudeSessionId) {
              runtime.claudeSessionId = claudeSessionId
            }

            const cost = extractCostDelta(event)
            if (cost) {
              await sessionStore.update(commanderId, (session) => ({
                ...session,
                totalCostUsd: cost.kind === 'absolute'
                  ? cost.value
                  : session.totalCostUsd + cost.value,
              }))
            }

            if (isContextPressureEvent(event)) {
              await runtime.contextPressureBridge.trigger()
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            const failureEvent = {
              type: 'system',
              text: `Commander turn failed: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies StreamEvent
            appendEvent(runtime, failureEvent)
            broadcastEvent(runtime, failureEvent)
          }
        } finally {
          runtime.abortController = null
        }
      })

    await runtime.queue
  }

  const heartbeatManager = new CommanderHeartbeatManager({
    now,
    sendHeartbeat: async ({ commanderId, renderedMessage }) => {
      const session = await sessionStore.get(commanderId)
      if (!session || session.state !== 'running') {
        return false
      }

      const runtime = runtimes.get(commanderId)
      if (!runtime) {
        return false
      }

      runtime.lastTaskState = renderedMessage
      runtime.pendingSpikeObservations = []

      const built = await runtime.agent.buildHeartbeatSystemPrompt(BASE_SYSTEM_PROMPT, {
        currentTask: toPromptIssue(session),
        recentConversation: [{ role: 'user', content: renderedMessage }],
      })

      await queueTurn(commanderId, runtime, renderedMessage, built.systemPrompt)
      return true
    },
    onHeartbeatSent: async ({ commanderId, timestamp }) => {
      await sessionStore.updateLastHeartbeat(commanderId, timestamp)
    },
    onHeartbeatError: ({ commanderId, error }) => {
      const runtime = runtimes.get(commanderId)
      if (!runtime) {
        return
      }

      const heartbeatErrorEvent = {
        type: 'system',
        text: `Commander heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      } satisfies StreamEvent
      appendEvent(runtime, heartbeatErrorEvent)
      broadcastEvent(runtime, heartbeatErrorEvent)
    },
  })

  router.get('/', requireReadAccess, async (_req, res) => {
    const sessions = await sessionStore.list()
    res.json(sessions)
  })

  router.post('/', requireWriteAccess, async (req, res) => {
    const host = parseHost(req.body?.host)
    if (!host) {
      res.status(400).json({ error: 'Invalid host' })
      return
    }

    const taskSource = parseTaskSource(req.body?.taskSource)
    if (!taskSource) {
      res.status(400).json({ error: 'Invalid taskSource' })
      return
    }

    const existing = await sessionStore.list()
    if (existing.some((session) => session.host === host)) {
      res.status(409).json({ error: `Commander for host "${host}" already exists` })
      return
    }

    const session: CommanderSession = {
      id: randomUUID(),
      host,
      pid: null,
      state: 'idle',
      created: now().toISOString(),
      heartbeat: createDefaultHeartbeatState(),
      lastHeartbeat: null,
      taskSource,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
    }

    try {
      const created = await sessionStore.create(session)
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

    try {
      const manager = new CommanderManager(commanderId, options.memoryBasePath)
      await manager.init()
      const agent = new CommanderAgent(commanderId, options.memoryBasePath)
      const contextPressureBridge = createContextPressureBridge()
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

      const runtime: CommanderRuntime = {
        manager,
        agent,
        flusher,
        contextPressureBridge,
        events: [],
        clients: new Set<WebSocket>(),
        queue: Promise.resolve(),
        abortController: null,
        lastTaskState: 'Commander started',
        pendingSpikeObservations: [],
      }

      manager.wirePreCompactionFlush(
        contextPressureBridge,
        flusher,
        () => buildFlushContext(session, runtime),
      )

      const started = await sessionStore.update(commanderId, (current) => ({
        ...current,
        state: 'running',
        pid: null,
        currentTask: parsedCurrentTask.value ?? current.currentTask,
      }))

      if (!started) {
        res.status(404).json({ error: `Commander "${commanderId}" not found` })
        return
      }

      const built = await agent.buildTaskPickupSystemPrompt(BASE_SYSTEM_PROMPT, {
        currentTask: toPromptIssue(started),
        recentConversation: [],
      })

      runtimes.set(commanderId, runtime)
      heartbeatManager.start(commanderId, started.heartbeat)
      const startPrompt = parseMessage(req.body?.message) ?? STARTUP_PROMPT
      void queueTurn(commanderId, runtime, startPrompt, built.systemPrompt)

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

    const runtime = runtimes.get(commanderId)
    if (runtime) {
      runtime.lastTaskState = parseMessage(req.body?.state) ?? 'Commander stop requested'
      runtime.abortController?.abort()

      await runtime.queue.catch(() => undefined)

      const latestSession = (await sessionStore.get(commanderId)) ?? session
      try {
        await runtime.manager.flushBetweenTasksAndPickNext(
          runtime.flusher,
          () => buildFlushContext(latestSession, runtime),
          async () => undefined,
        )
      } catch (error) {
        const flushErrorEvent = {
          type: 'system',
          text: `Commander flush failed on stop: ${error instanceof Error ? error.message : String(error)}`,
        } satisfies StreamEvent
        appendEvent(runtime, flushErrorEvent)
        broadcastEvent(runtime, flushErrorEvent)
      }

      for (const client of runtime.clients) {
        client.close(1000, 'Commander stopped')
      }

      runtimes.delete(commanderId)
    }

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

    const runtime = runtimes.get(commanderId)
    if (runtime) {
      runtime.abortController?.abort()
      for (const client of runtime.clients) {
        client.close(1000, 'Commander deleted')
      }
      runtimes.delete(commanderId)
    }

    await sessionStore.delete(commanderId)
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

    if (updated.state === 'running' && runtimes.has(commanderId)) {
      heartbeatManager.start(commanderId, updated.heartbeat)
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

    const built = await runtime.agent.buildHeartbeatSystemPrompt(BASE_SYSTEM_PROMPT, {
      currentTask: toPromptIssue(session),
      recentConversation: [{ role: 'user', content: message }],
    })

    void queueTurn(commanderId, runtime, message, built.systemPrompt)

    res.json({ accepted: true })
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

    const updated = await sessionStore.update(commanderId, (current) => ({
      ...current,
      currentTask,
    }))

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

    await cronInitialized
    const tasks = await cronManager.listTasks(commanderId)
    res.json(tasks)
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

    const agentType = req.body?.agentType === 'codex' ? 'codex' : req.body?.agentType === 'claude' ? 'claude' : undefined
    const sessionType = req.body?.sessionType === 'pty' ? 'pty' : req.body?.sessionType === 'stream' ? 'stream' : undefined
    const permissionMode = typeof req.body?.permissionMode === 'string' && req.body.permissionMode ? req.body.permissionMode as string : undefined
    const workDir = typeof req.body?.workDir === 'string' && req.body.workDir ? req.body.workDir : undefined
    const machine = typeof req.body?.machine === 'string' && req.body.machine ? req.body.machine : undefined

    try {
      await cronInitialized
      const created = await cronManager.createTask({
        commanderId,
        schedule,
        instruction,
        enabled: enabled ?? true,
        agentType,
        sessionType,
        permissionMode,
        workDir,
        machine,
      })
      res.status(201).json(created)
    } catch (error) {
      if (isInvalidCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }

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

    try {
      await cronInitialized
      const updated = await cronManager.updateTask(commanderId, cronTaskId, update)
      if (!updated) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

      res.json(updated)
    } catch (error) {
      if (isInvalidCronError(error)) {
        res.status(400).json({ error: 'Invalid cron expression' })
        return
      }

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
      await cronInitialized
      const deleted = await cronManager.deleteTask(commanderId, cronTaskId)
      if (!deleted) {
        res.status(404).json({ error: 'Cron task not found' })
        return
      }

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
      await cronInitialized
      await cronManager.triggerInstruction(commanderId, instruction)
      res.status(200).json({ ok: true, triggered: true })
    } catch {
      res.status(500).json({ error: 'Failed to trigger commander instruction' })
    }
  })

  // --- WebSocket upgrade ---

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

    if (auth0Verifier) {
      try {
        await auth0Verifier(token)
        return true
      } catch {
        // Fall through to API key auth.
      }
    }

    if (options.apiKeyStore) {
      const result = await options.apiKeyStore.verifyKey(token, {
        requiredScopes: ['agents:read'],
      })
      return result.ok
    }

    return false
  }

  function extractCommanderIdFromUrl(url: URL): string | null {
    const match = url.pathname.match(/\/api\/commanders\/([^/]+)\/ws$/)
    if (!match) {
      return null
    }

    try {
      const decoded = decodeURIComponent(match[1] ?? '')
      return parseSessionId(decoded)
    } catch {
      return null
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const commanderId = extractCommanderIdFromUrl(url)

    if (!commanderId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    void verifyWsAuth(req).then(async (authorized) => {
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const session = await sessionStore.get(commanderId)
      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      const runtime = runtimes.get(commanderId)
      if (!runtime || session.state !== 'running') {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(
          JSON.stringify({
            type: 'replay',
            events: runtime.events,
          }),
        )

        runtime.clients.add(ws)
        const stopKeepAlive = attachWebSocketKeepAlive(ws, wsKeepAliveIntervalMs, () => {
          runtime.clients.delete(ws)
        })

        ws.on('close', () => {
          stopKeepAlive()
          runtime.clients.delete(ws)
        })

        ws.on('error', () => {
          stopKeepAlive()
          runtime.clients.delete(ws)
        })
      })
    })
  }

  return { router, handleUpgrade }
}
