import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createCommandersRouter, type CommandersRouterOptions } from '../routes'
import type { CommanderSessionsInterface } from '../../agents/routes'
import { CommanderSessionStore } from '../store'
import { JournalWriter } from '../memory/journal'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_MESSAGE,
} from '../heartbeat'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}
const PRE_COMPACTION_OUTCOME = 'Emergency flush before context compaction'

interface RunningServer {
  baseUrl: string
  httpServer: Server
  close: () => Promise<void>
}

interface MockSessionEntry {
  name: string
  systemPrompt: string
  agentType: 'claude' | 'codex'
  cwd?: string
  resumeSessionId?: string
  resumeCodexThreadId?: string
  maxTurns?: number
}

interface MockSessionsInterface {
  interface: CommanderSessionsInterface
  createCalls: MockSessionEntry[]
  sendCalls: Array<{ name: string; text: string }>
  activeSessions: Set<string>
  triggerEvent: (sessionName: string, event: unknown) => void
  setUsage: (usage: {
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
  }) => void
}

const tempDirs: string[] = []

function createTestApiKeyStore(): ApiKeyStoreLike {
  const recordsByRawKey = {
    'test-key': {
      id: 'test-key-id',
      name: 'Test Key',
      keyHash: 'hash',
      prefix: 'hmrb_test',
      createdBy: 'test',
      createdAt: '2026-02-16T00:00:00.000Z',
      lastUsedAt: null,
      scopes: ['agents:read', 'agents:write', 'commanders:read', 'commanders:write'],
    },
  } satisfies Record<string, import('../../../server/api-keys/store').ApiKeyRecord>

  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey, options) => {
      const record = recordsByRawKey[rawKey as keyof typeof recordsByRawKey]
      if (!record) {
        return { ok: false, reason: 'not_found' as const }
      }

      const requiredScopes = options?.requiredScopes ?? []
      const hasAllScopes = requiredScopes.every((scope) => record.scopes.includes(scope))
      if (!hasAllScopes) {
        return { ok: false, reason: 'insufficient_scope' as const }
      }

      return { ok: true as const, record }
    },
  }
}

function createMockSessionsInterface(opts: {
  /** Cost that getSession() reports for each active session's usage.costUsd */
  sessionCostUsd?: number
  /** input token count that getSession() reports */
  sessionInputTokens?: number
  /** output token count that getSession() reports */
  sessionOutputTokens?: number
  /** claudeSessionId that getSession() reports for each active session */
  sessionClaudeSessionId?: string
  /** codexThreadId that getSession() reports for each active session */
  sessionCodexThreadId?: string
  /** sessions that should be treated as already active (e.g. reconciled after restart) */
  initialActiveSessions?: string[]
} = {}): MockSessionsInterface {
  const createCalls: MockSessionEntry[] = []
  const sendCalls: Array<{ name: string; text: string }> = []
  const activeSessions = new Set<string>(opts.initialActiveSessions ?? [])
  const agentTypeBySessionName = new Map<string, 'claude' | 'codex'>(
    (opts.initialActiveSessions ?? []).map((sessionName) => [sessionName, 'claude']),
  )
  const eventHandlers = new Map<string, Set<(event: unknown) => void>>()
  const usage = {
    inputTokens: opts.sessionInputTokens ?? 0,
    outputTokens: opts.sessionOutputTokens ?? 0,
    costUsd: opts.sessionCostUsd ?? 0,
  }

  const mock: CommanderSessionsInterface = {
    async createCommanderSession(params) {
      createCalls.push(params)
      activeSessions.add(params.name)
      agentTypeBySessionName.set(params.name, params.agentType)
      // Return a minimal fake StreamSession (interface uses opaque return type)
      return { kind: 'stream', name: params.name } as unknown as Awaited<ReturnType<
        CommanderSessionsInterface['createCommanderSession']
      >>
    },
    async sendToSession(name, text) {
      sendCalls.push({ name, text })
      return activeSessions.has(name)
    },
    deleteSession(name) {
      activeSessions.delete(name)
      agentTypeBySessionName.delete(name)
    },
    getSession(name) {
      if (!activeSessions.has(name)) return undefined
      const agentType = agentTypeBySessionName.get(name) ?? 'claude'
      return {
        kind: 'stream',
        name,
        agentType,
        claudeSessionId: agentType === 'claude' ? opts.sessionClaudeSessionId : undefined,
        codexThreadId: agentType === 'codex' ? opts.sessionCodexThreadId : undefined,
        usage: { ...usage },
      } as unknown as ReturnType<CommanderSessionsInterface['getSession']>
    },
    subscribeToEvents(name, handler) {
      if (!eventHandlers.has(name)) eventHandlers.set(name, new Set())
      eventHandlers.get(name)!.add(handler as (event: unknown) => void)
      return () => {
        eventHandlers.get(name)?.delete(handler as (event: unknown) => void)
      }
    },
  }

  return {
    interface: mock,
    createCalls,
    sendCalls,
    activeSessions,
    triggerEvent(sessionName, event) {
      for (const handler of eventHandlers.get(sessionName) ?? []) {
        handler(event)
      }
    },
    setUsage(nextUsage) {
      if (typeof nextUsage.inputTokens === 'number' && Number.isFinite(nextUsage.inputTokens)) {
        usage.inputTokens = nextUsage.inputTokens
      }
      if (typeof nextUsage.outputTokens === 'number' && Number.isFinite(nextUsage.outputTokens)) {
        usage.outputTokens = nextUsage.outputTokens
      }
      if (typeof nextUsage.costUsd === 'number' && Number.isFinite(nextUsage.costUsd)) {
        usage.costUsd = nextUsage.costUsd
      }
    },
  }
}

async function startServer(
  options: Partial<CommandersRouterOptions> = {},
): Promise<RunningServer> {
  const sessionStorePath = options.sessionStorePath
    ?? join(await createTempDir('hammurabi-commanders-session-store-'), 'sessions.json')
  const memoryBasePath = options.memoryBasePath
    ?? join(dirname(sessionStorePath), 'memory')

  const app = express()
  app.use(express.json())

  const commanders = createCommandersRouter({
    apiKeyStore: createTestApiKeyStore(),
    ...options,
    sessionStorePath,
    memoryBasePath,
  })
  app.use('/api/commanders', commanders.router)

  const httpServer = createServer(app)

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve())
  })

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    httpServer,
    close: async () => {
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections()
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

afterEach(async () => {
  vi.clearAllMocks()
  // Small drain to allow any in-flight async heartbeat log writes to complete
  // before deleting temp directories, preventing ENOTEMPTY race conditions.
  await sleep(75)
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ),
  )
})

describe('commanders routes', () => {
  it('lists sessions from persisted JSON store', async () => {
    const dir = await createTempDir('hammurabi-commanders-store-')
    const storePath = join(dir, 'sessions.json')
    await writeFile(
      storePath,
      JSON.stringify(
        {
          sessions: [
            {
              id: 'cmdr-1',
              host: 'host-a',
              pid: null,
              state: 'idle',
              created: '2026-02-20T00:00:00.000Z',
              lastHeartbeat: null,
              taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
              currentTask: null,
              completedTasks: 0,
              totalCostUsd: 0,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const server = await startServer({ sessionStorePath: storePath })
    try {
      const response = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([
        expect.objectContaining({
          id: 'cmdr-1',
          host: 'host-a',
          state: 'idle',
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('creates idle commander and rejects duplicate host', async () => {
    const dir = await createTempDir('hammurabi-commanders-create-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
    })

    try {
      const first = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-1',
          taskSource: {
            owner: 'example-user',
            repo: 'example-repo',
            label: 'commander',
          },
        }),
      })

      expect(first.status).toBe(201)
      const created = (await first.json()) as {
        state: string
        host: string
        id: string
        heartbeat: {
          intervalMs: number
          messageTemplate: string
          lastSentAt: string | null
        }
        lastHeartbeat: string | null
      }
      expect(created.state).toBe('idle')
      expect(created.host).toBe('worker-1')
      expect(created.id).toBeTruthy()
      expect(created.heartbeat).toEqual({
        intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
        messageTemplate: DEFAULT_HEARTBEAT_MESSAGE,
        lastSentAt: null,
      })
      expect(created.lastHeartbeat).toBeNull()

      const second = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-1',
          taskSource: {
            owner: 'example-user',
            repo: 'example-repo',
            label: 'commander',
          },
        }),
      })

      expect(second.status).toBe(409)

      const persisted = JSON.parse(await readFile(storePath, 'utf8')) as { sessions: unknown[] }
      expect(persisted.sessions).toHaveLength(1)

      const names = JSON.parse(await readFile(join(dir, 'names.json'), 'utf8')) as Record<string, string>
      expect(names[created.id]).toBe('worker-1')

      const template = await readFile(join(memoryBasePath, 'COMMANDER.template.md'), 'utf8')
      expect(template).toContain('[COMMANDER_ID]')
      expect(template).toContain('## Memory')

      const workflow = await readFile(join(memoryBasePath, created.id, 'COMMANDER.md'), 'utf8')
      expect(workflow).toContain(`hammurabi memory find --commander ${created.id}`)
      expect(workflow).toContain('.memory/MEMORY.md')
    } finally {
      await server.close()
    }
  })

  it('updates heartbeat config without starting commander runtime', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-config-')
    const storePath = join(dir, 'sessions.json')
    const mock = createMockSessionsInterface()
    const server = await startServer({
      sessionStorePath: storePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-heartbeat-config',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const patchResponse = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            intervalMs: 25,
            messageTemplate: '[HEARTBEAT CUSTOM {{timestamp}}]',
          }),
        },
      )

      expect(patchResponse.status).toBe(200)
      expect(await patchResponse.json()).toEqual({
        id: created.id,
        heartbeat: {
          intervalMs: 25,
          messageTemplate: '[HEARTBEAT CUSTOM {{timestamp}}]',
          lastSentAt: null,
        },
        lastHeartbeat: null,
      })

      await sleep(60)
      // No start was called, so no session sends should have occurred
      expect(mock.sendCalls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('sends periodic heartbeat messages while running and stops after stop', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-loop-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-heartbeat-loop',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const patchResponse = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            intervalMs: 25,
            messageTemplate: '[HEARTBEAT QUICK {{timestamp}}]',
          }),
        },
      )
      expect(patchResponse.status).toBe(200)

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      // Wait for at least a startup send + one heartbeat send
      await vi.waitFor(() => {
        expect(mock.sendCalls.length).toBeGreaterThanOrEqual(2)
      })
      expect(mock.sendCalls.some((call) => call.text.includes('[HEARTBEAT QUICK '))).toBe(true)

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        state: string
        lastHeartbeat: string | null
        heartbeat: {
          intervalMs: number
          messageTemplate: string
          lastSentAt: string | null
        }
      }>
      const updated = sessions.find((session) => session.id === created.id)
      expect(updated?.state).toBe('running')
      expect(updated?.heartbeat.intervalMs).toBe(25)
      expect(updated?.heartbeat.messageTemplate).toBe('[HEARTBEAT QUICK {{timestamp}}]')
      expect(updated?.heartbeat.lastSentAt).toBeTruthy()
      expect(updated?.lastHeartbeat).toBe(updated?.heartbeat.lastSentAt)

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(stopResponse.status).toBe(200)

      await sleep(40)
      const sendsAfterStopSettled = mock.sendCalls.length
      await sleep(80)
      expect(mock.sendCalls.length).toBe(sendsAfterStopSettled)
    } finally {
      await server.close()
    }
  })

  it('writes a heartbeat error entry when commander is not running when heartbeat fires', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-stop-log-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const sessionStore = new CommanderSessionStore(storePath)
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStore,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-heartbeat-stop-log',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      expect(createResponse.status).toBe(201)
      const created = (await createResponse.json()) as { id: string }

      const patchResponse = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            intervalMs: 10,
            messageTemplate: '[HEARTBEAT QUICK {{timestamp}}]',
          }),
        },
      )
      expect(patchResponse.status).toBe(200)

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      // Wait for at least one send (startup prompt) confirming commander is running
      await vi.waitFor(() => {
        expect(mock.sendCalls.length).toBeGreaterThanOrEqual(1)
      })

      // Simulate the commander's session being stopped externally (state → stopped)
      const sessions = await sessionStore.list()
      const session = sessions[0]
      if (session) {
        await sessionStore.update(session.id, (current) => ({
          ...current,
          state: 'stopped',
          pid: null,
          currentTask: null,
        }))
      }

      // Wait for the heartbeat log to record an error after detecting non-running state
      await vi.waitFor(async () => {
        const heartbeatLogResponse = await fetch(
          `${server.baseUrl}/api/commanders/${created.id}/heartbeat-log`,
          { headers: AUTH_HEADERS },
        )
        const payload = (await heartbeatLogResponse.json()) as {
          entries: Array<{ outcome: string; errorMessage?: string }>
        }
        expect(payload.entries.some((entry) => entry.outcome === 'error')).toBe(true)
      }, { timeout: 2000 })

      const heartbeatLogResponse = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat-log`,
        { headers: AUTH_HEADERS },
      )
      expect(heartbeatLogResponse.status).toBe(200)
      const payload = (await heartbeatLogResponse.json()) as {
        entries: Array<{
          outcome: string
          errorMessage?: string
        }>
      }

      expect(payload.entries.some((entry) =>
        entry.outcome === 'error' &&
        entry.errorMessage === 'Commander session was not running when heartbeat fired')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('applies heartbeat PATCH updates immediately for running commander', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-live-patch-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-heartbeat-live',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      const patchFirst = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            intervalMs: 25,
            messageTemplate: '[HB1 {{timestamp}}]',
          }),
        },
      )
      expect(patchFirst.status).toBe(200)

      await vi.waitFor(() => {
        expect(mock.sendCalls.some((call) => call.text.includes('[HB1 '))).toBe(true)
      })

      const patchSecond = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messageTemplate: '[HB2 {{timestamp}}]',
          }),
        },
      )
      expect(patchSecond.status).toBe(200)

      await vi.waitFor(() => {
        expect(mock.sendCalls.some((call) => call.text.includes('[HB2 '))).toBe(true)
      })

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(stopResponse.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('starts and stops commander lifecycle with sessionsInterface', async () => {
    const dir = await createTempDir('hammurabi-commanders-lifecycle-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-lifecycle',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)
      expect(await startResponse.json()).toEqual({
        id: created.id,
        state: 'running',
        started: true,
      })

      // createCommanderSession should be called once with the system prompt
      await vi.waitFor(() => {
        expect(mock.createCalls).toHaveLength(1)
      })
      expect(mock.createCalls[0]?.systemPrompt).toEqual(
        expect.stringContaining('## Commander Memory'),
      )
      // Session name should match commander id pattern
      expect(mock.createCalls[0]?.name).toBe(`commander-${created.id}`)
      expect(mock.createCalls[0]?.agentType).toBe('claude')

      // State should be running
      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        state: string
      }>
      const started = sessions.find((entry) => entry.id === created.id)
      expect(started?.state).toBe('running')

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          state: 'Stopping for test',
        }),
      })

      expect(stopResponse.status).toBe(200)
      expect(await stopResponse.json()).toEqual({
        id: created.id,
        state: 'stopped',
        stopped: true,
      })
    } finally {
      await server.close()
    }
  })

  it('uses per-commander COMMANDER.md as authoritative with workspace fallback', async () => {
    const dir = await createTempDir('hammurabi-commanders-workflow-source-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const workspaceDir = join(dir, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      join(workspaceDir, 'COMMANDER.md'),
      [
        '---',
        'maxTurns: 3',
        '---',
        'WORKSPACE PROMPT SOURCE',
      ].join('\n'),
      'utf8',
    )
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const firstCreate = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-workflow-fallback',
          cwd: workspaceDir,
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const firstCommander = (await firstCreate.json()) as { id: string }
      const firstStart = await fetch(
        `${server.baseUrl}/api/commanders/${firstCommander.id}/start`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
        },
      )
      expect(firstStart.status).toBe(200)

      await vi.waitFor(() => {
        expect(mock.createCalls).toHaveLength(1)
      })
      expect(mock.createCalls[0]?.systemPrompt).toContain('WORKSPACE PROMPT SOURCE')
      expect(mock.createCalls[0]?.maxTurns).toBe(3)

      const secondCreate = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-workflow-authoritative',
          cwd: workspaceDir,
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const secondCommander = (await secondCreate.json()) as { id: string }
      const commanderRoot = join(memoryBasePath, secondCommander.id)
      await mkdir(commanderRoot, { recursive: true })
      await writeFile(
        join(commanderRoot, 'COMMANDER.md'),
        [
          '---',
          'maxTurns: 7',
          '---',
          'COMMANDER-DIR PROMPT SOURCE',
        ].join('\n'),
        'utf8',
      )

      const secondStart = await fetch(
        `${server.baseUrl}/api/commanders/${secondCommander.id}/start`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
        },
      )
      expect(secondStart.status).toBe(200)

      await vi.waitFor(() => {
        expect(mock.createCalls).toHaveLength(2)
      })
      expect(mock.createCalls[1]?.systemPrompt).toContain('COMMANDER-DIR PROMPT SOURCE')
      expect(mock.createCalls[1]?.systemPrompt).not.toContain('WORKSPACE PROMPT SOURCE')
      expect(mock.createCalls[1]?.maxTurns).toBe(7)
    } finally {
      await server.close()
    }
  })

  it('reloads authoritative COMMANDER.md body for fat heartbeats instead of sending injected memory context', async () => {
    const dir = await createTempDir('hammurabi-commanders-workflow-heartbeat-reload-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-workflow-reload',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const commander = (await createResponse.json()) as { id: string }
      const commanderRoot = join(memoryBasePath, commander.id)
      const memoryRoot = join(commanderRoot, '.memory')
      await mkdir(commanderRoot, { recursive: true })
      await mkdir(memoryRoot, { recursive: true })
      await writeFile(
        join(commanderRoot, 'COMMANDER.md'),
        'COMMANDER PROMPT V1',
        'utf8',
      )
      await writeFile(
        join(memoryRoot, 'MEMORY.md'),
        '# Commander Memory\n\n- Initial memory fact',
        'utf8',
      )
      await writeFile(
        join(memoryRoot, 'identity.md'),
        '# Identity Section\n\nYou are Athena, engineering commander.',
        'utf8',
      )

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      await writeFile(
        join(commanderRoot, 'COMMANDER.md'),
        'COMMANDER PROMPT V2',
        'utf8',
      )
      await writeFile(
        join(memoryRoot, 'MEMORY.md'),
        '# Commander Memory\n\n- Updated memory fact',
        'utf8',
      )

      const heartbeatResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/heartbeat`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
        },
      )
      expect(heartbeatResponse.status).toBe(200)

      await vi.waitFor(() => {
        expect(mock.sendCalls.length).toBeGreaterThanOrEqual(2)
      })
      const lastSend = mock.sendCalls[mock.sendCalls.length - 1]
      expect(lastSend?.text).toContain('COMMANDER PROMPT V2')
      expect(lastSend?.text).toContain('Check your task list.')
      expect(lastSend?.text).not.toContain('COMMANDER PROMPT V1')
      expect(lastSend?.text).not.toContain('Updated memory fact')
      expect(lastSend?.text).not.toContain('You are Athena, engineering commander.')
      expect(lastSend?.text).not.toContain('# Hammurabi Quest Board')
      expect(lastSend?.text).not.toContain('# Commander Memory Workflow')
    } finally {
      await server.close()
    }
  })

  it('rehydrates heartbeat prompt after restart reconciliation without runtime state', async () => {
    const dir = await createTempDir('hammurabi-commanders-restart-rehydrate-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const agentsSessionStorePath = join(dir, 'agents-sessions.json')
    const commanderId = 'cmdr-rehydrate'
    const commanderSessionName = `commander-${commanderId}`

    await writeFile(
      storePath,
      JSON.stringify({
        sessions: [
          {
            id: commanderId,
            host: 'worker-rehydrate',
            pid: null,
            state: 'running',
            created: '2026-03-01T00:00:00.000Z',
            heartbeat: {
              intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
              messageTemplate: DEFAULT_HEARTBEAT_MESSAGE,
              lastSentAt: null,
            },
            lastHeartbeat: null,
            taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
            currentTask: null,
            completedTasks: 0,
            totalCostUsd: 0,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      agentsSessionStorePath,
      JSON.stringify({
        sessions: [
          { name: commanderSessionName },
        ],
      }),
      'utf8',
    )
    const commanderRoot = join(memoryBasePath, commanderId)
    const memoryRoot = join(commanderRoot, '.memory')
    await mkdir(commanderRoot, { recursive: true })
    await mkdir(memoryRoot, { recursive: true })
    await writeFile(
      join(commanderRoot, 'COMMANDER.md'),
      'RESTART REHYDRATED PROMPT',
      'utf8',
    )
    await writeFile(
      join(memoryRoot, 'MEMORY.md'),
      '# Commander Memory\n\n- Recovered memory fact',
      'utf8',
    )

    const mock = createMockSessionsInterface({
      initialActiveSessions: [commanderSessionName],
    })

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
      agentsSessionStorePath,
    })

    try {
      await vi.waitFor(async () => {
        const heartbeatResponse = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/heartbeat`,
          {
            method: 'POST',
            headers: {
              ...AUTH_HEADERS,
              'content-type': 'application/json',
            },
          },
        )
        expect(heartbeatResponse.status).toBe(200)
      }, { timeout: 3000 })

      await vi.waitFor(() => {
        expect(
          mock.sendCalls.some((call) =>
            call.text.includes('RESTART REHYDRATED PROMPT') &&
            call.text.includes('Check your task list.') &&
            !call.text.includes('Recovered memory fact')),
        ).toBe(true)
      })
      expect(mock.createCalls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('preserves thin heartbeat cadence after restart reconciliation without runtime state', async () => {
    const dir = await createTempDir('hammurabi-commanders-restart-thin-cadence-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const agentsSessionStorePath = join(dir, 'agents-sessions.json')
    const commanderId = 'cmdr-thin-rehydrate'
    const commanderSessionName = `commander-${commanderId}`

    await writeFile(
      storePath,
      JSON.stringify({
        sessions: [
          {
            id: commanderId,
            host: 'worker-thin-rehydrate',
            pid: null,
            state: 'running',
            created: '2026-03-01T00:00:00.000Z',
            heartbeat: {
              intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
              messageTemplate: DEFAULT_HEARTBEAT_MESSAGE,
              lastSentAt: '2026-03-01T00:05:00.000Z',
            },
            lastHeartbeat: '2026-03-01T00:05:00.000Z',
            heartbeatTickCount: 1,
            contextConfig: {
              fatPinInterval: 4,
            },
            taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
            currentTask: null,
            completedTasks: 0,
            totalCostUsd: 0,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      agentsSessionStorePath,
      JSON.stringify({
        sessions: [
          { name: commanderSessionName },
        ],
      }),
      'utf8',
    )

    const mock = createMockSessionsInterface({
      initialActiveSessions: [commanderSessionName],
    })

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
      agentsSessionStorePath,
    })

    try {
      await vi.waitFor(async () => {
        const heartbeatResponse = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/heartbeat`,
          {
            method: 'POST',
            headers: {
              ...AUTH_HEADERS,
              'content-type': 'application/json',
            },
          },
        )
        expect(heartbeatResponse.status).toBe(200)
      }, { timeout: 3000 })

      await vi.waitFor(() => {
        expect(
          mock.sendCalls.some((call) =>
            call.text.includes('Check your task list.') &&
            call.text.includes('If current task is complete, mark it done and pick up the next one.'),
          ),
        ).toBe(true)
      }, { timeout: 3000 })

      await vi.waitFor(async () => {
        const persisted = JSON.parse(await readFile(storePath, 'utf8')) as {
          sessions?: Array<{ id?: string; heartbeatTickCount?: number }>
        }
        const updated = persisted.sessions?.find((session) => session.id === commanderId)
        expect(updated?.heartbeatTickCount).toBe(2)
      }, { timeout: 3000 })
    } finally {
      await server.close()
    }
  })

  it('triggers pre-compaction flush from message_delta usage pressure events', async () => {
    const dir = await createTempDir('hammurabi-commanders-message-delta-pressure-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-message-delta-pressure',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      const journal = new JournalWriter(created.id, memoryBasePath)
      const sessionName = `commander-${created.id}`

      mock.setUsage({ inputTokens: 1 })
      mock.triggerEvent(sessionName, {
        type: 'message_delta',
        usage: { input_tokens: 1, output_tokens: 1 },
      })

      await sleep(50)
      const beforeThreshold = await journal.readRecent()
      expect(
        beforeThreshold.some((entry) => entry.outcome === PRE_COMPACTION_OUTCOME),
      ).toBe(false)

      mock.setUsage({ inputTokens: 900_000 })
      mock.triggerEvent(sessionName, {
        type: 'message_delta',
        usage: { input_tokens: 900_000, output_tokens: 900_000 },
      })

      await vi.waitFor(async () => {
        const entries = await journal.readRecent()
        expect(
          entries.some((entry) =>
            entry.outcome === PRE_COMPACTION_OUTCOME &&
            entry.body.includes('- Trigger: `pre-compaction`')),
        ).toBe(true)
      }, { timeout: 3000 })
    } finally {
      await server.close()
    }
  })

  it('triggers pre-compaction flush from result usage pressure events', async () => {
    const dir = await createTempDir('hammurabi-commanders-result-pressure-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-result-pressure',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      const journal = new JournalWriter(created.id, memoryBasePath)
      const sessionName = `commander-${created.id}`

      mock.setUsage({ inputTokens: 1_200_000 })
      mock.triggerEvent(sessionName, {
        type: 'result',
        usage: { input_tokens: 1_200_000, output_tokens: 1_100_000 },
        total_cost_usd: 0.25,
      })

      await vi.waitFor(async () => {
        const entries = await journal.readRecent()
        expect(
          entries.some((entry) =>
            entry.outcome === PRE_COMPACTION_OUTCOME &&
            entry.body.includes('- Trigger: `pre-compaction`')),
        ).toBe(true)
      }, { timeout: 3000 })
    } finally {
      await server.close()
    }
  })

  it('persists cwd when creating a commander with cwd in request body', async () => {
    const dir = await createTempDir('hammurabi-commanders-cwd-create-')
    const storePath = join(dir, 'sessions.json')
    const server = await startServer({ sessionStorePath: storePath })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-cwd',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
          cwd: '/tmp/my-project',
        }),
      })

      expect(createResponse.status).toBe(201)
      const created = (await createResponse.json()) as { id: string; cwd?: string }
      expect(created.cwd).toBe('/tmp/my-project')

      // Persisted in the store
      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{ id: string; cwd?: string }>
      const found = sessions.find((s) => s.id === created.id)
      expect(found?.cwd).toBe('/tmp/my-project')
    } finally {
      await server.close()
    }
  })

  it('accumulates totalCostUsd from agent session usage on stop', async () => {
    const dir = await createTempDir('hammurabi-commanders-cost-stop-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    // Mock reports 1.5 USD of session cost when getSession is called during stop
    const mock = createMockSessionsInterface({
      sessionCostUsd: 1.5,
      sessionClaudeSessionId: 'claude-test-session-id',
    })

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-cost-stop',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(startResponse.status).toBe(200)

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(stopResponse.status).toBe(200)

      // totalCostUsd should be accumulated from agentSession.usage.costUsd (1.5)
      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        totalCostUsd: number
        claudeSessionId?: string
      }>
      const stopped = sessions.find((s) => s.id === created.id)
      expect(stopped?.totalCostUsd).toBe(1.5)
      expect(stopped?.claudeSessionId).toBe('claude-test-session-id')
    } finally {
      await server.close()
    }
  })

  it('reuses persisted claude session id when restarting commander chat', async () => {
    const dir = await createTempDir('hammurabi-commanders-claude-restart-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface({
      sessionClaudeSessionId: 'claude-resume-123',
    })

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-claude-restart',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const firstStartResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(firstStartResponse.status).toBe(200)

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(stopResponse.status).toBe(200)

      const secondStartResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(secondStartResponse.status).toBe(200)

      expect(mock.createCalls).toHaveLength(2)
      expect(mock.createCalls[0]?.agentType).toBe('claude')
      expect(mock.createCalls[1]).toEqual(
        expect.objectContaining({
          agentType: 'claude',
          resumeSessionId: 'claude-resume-123',
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('reuses persisted codex thread id when restarting commander chat', async () => {
    const dir = await createTempDir('hammurabi-commanders-codex-restart-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface({
      sessionCodexThreadId: 'codex-thread-123',
    })

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-codex-restart',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const firstStartResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agentType: 'codex' }),
      })
      expect(firstStartResponse.status).toBe(200)
      await vi.waitFor(() => {
        expect(mock.createCalls).toHaveLength(1)
        expect(mock.sendCalls.length).toBeGreaterThanOrEqual(1)
      })
      expect(mock.createCalls[0]).toEqual(
        expect.objectContaining({
          agentType: 'codex',
          resumeSessionId: undefined,
          resumeCodexThreadId: undefined,
        }),
      )
      expect(mock.sendCalls[0]?.text).toBe(
        'Commander runtime started. Acknowledge readiness and await instructions.',
      )

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/stop`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(stopResponse.status).toBe(200)

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        agentType?: 'claude' | 'codex'
        codexThreadId?: string
      }>
      const stopped = sessions.find((session) => session.id === created.id)
      expect(stopped?.agentType).toBe('codex')
      expect(stopped?.codexThreadId).toBe('codex-thread-123')

      const secondStartResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      })
      expect(secondStartResponse.status).toBe(200)

      expect(mock.createCalls).toHaveLength(2)
      expect(mock.createCalls[0]?.agentType).toBe('codex')
      expect(mock.createCalls[1]).toEqual(
        expect.objectContaining({
          agentType: 'codex',
          resumeCodexThreadId: 'codex-thread-123',
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('sends message to running commander', async () => {
    const dir = await createTempDir('hammurabi-commanders-message-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-message',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      const message = 'Please investigate issue #167'

      const messageResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/message?mode=followup`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message,
        }),
      })

      expect(messageResponse.status).toBe(200)
      expect(await messageResponse.json()).toEqual({ accepted: true })

      // The message should appear in sendCalls (startup prompt + the explicit message)
      await vi.waitFor(() => {
        expect(mock.sendCalls.some((call) => call.text === message)).toBe(true)
      })

      const journal = new JournalWriter(created.id, memoryBasePath)
      await vi.waitFor(async () => {
        const entries = await journal.readRecent()
        expect(entries.some((entry) =>
          entry.outcome === 'Commander instruction received' &&
          entry.body.includes(message))).toBe(true)
      })

      const workingMemoryPath = join(
        memoryBasePath,
        created.id,
        '.memory',
        'working-memory.json',
      )
      const workingMemory = JSON.parse(await readFile(workingMemoryPath, 'utf-8')) as {
        checkpoints?: Array<{ source?: string; summary?: string }>
      }
      const checkpoints = workingMemory.checkpoints ?? []
      expect(
        checkpoints.some((entry) => entry.source === 'message' && entry.summary?.includes(message)),
      ).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('proxies GitHub tasks filtered by commander label', async () => {
    const dir = await createTempDir('hammurabi-commanders-tasks-')
    const storePath = join(dir, 'sessions.json')

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = input instanceof URL ? input.toString() : String(input)
        if (!url.includes('/issues?')) {
          throw new Error(`Unexpected URL: ${url}`)
        }
        return new Response(
          JSON.stringify([
            {
              number: 167,
              title: 'Commander lifecycle',
              body: 'Implement routes',
              html_url: 'https://github.com/example-user/example-repo/issues/167',
              state: 'open',
              labels: [{ name: 'commander' }],
            },
            {
              number: 999,
              title: 'PR placeholder',
              html_url: 'https://github.com/example-user/example-repo/pull/999',
              state: 'open',
              pull_request: {},
              labels: [],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    )

    const server = await startServer({
      sessionStorePath: storePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-tasks',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const tasksResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/tasks`, {
        headers: AUTH_HEADERS,
      })

      expect(tasksResponse.status).toBe(200)
      expect(await tasksResponse.json()).toEqual([
        {
          number: 167,
          title: 'Commander lifecycle',
          body: 'Implement routes',
          issueUrl: 'https://github.com/example-user/example-repo/issues/167',
          state: 'open',
          labels: ['commander'],
        },
      ])

      const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
      expect(requestedUrl).toContain('labels=commander')
    } finally {
      await server.close()
    }
  })

  it('assigns task label and persists currentTask', async () => {
    const dir = await createTempDir('hammurabi-commanders-assign-')
    const storePath = join(dir, 'sessions.json')

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = input instanceof URL ? input.toString() : String(input)
        if (!url.endsWith('/issues/167/labels')) {
          throw new Error(`Unexpected URL: ${url}`)
        }
        return new Response(JSON.stringify([{ name: 'commander' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )

    const server = await startServer({
      sessionStorePath: storePath,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date('2026-02-21T12:00:00.000Z'),
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-assign',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const created = (await createResponse.json()) as { id: string }

      const assignResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/tasks`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          issueNumber: 167,
        }),
      })

      expect(assignResponse.status).toBe(201)
      expect(await assignResponse.json()).toEqual({
        assigned: true,
        currentTask: {
          issueNumber: 167,
          issueUrl: 'https://github.com/example-user/example-repo/issues/167',
          startedAt: '2026-02-21T12:00:00.000Z',
        },
      })

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        currentTask: { issueNumber: number } | null
      }>
      const updated = sessions.find((session) => session.id === created.id)
      expect(updated?.currentTask?.issueNumber).toBe(167)

      const callBody = String(fetchMock.mock.calls[0]?.[1]?.body ?? '')
      expect(callBody).toContain('"labels":["commander"]')
    } finally {
      await server.close()
    }
  })

  // NOTE: WebSocket live-event streaming is no longer tested here.
  // The WS endpoint for commander sessions has moved to the agents router:
  //   /api/agents/sessions/commander-{id}/ws
  // End-to-end WS streaming is verified via agents router integration tests.
  it.skip('streams live events over websocket', () => {
    // Skipped: commander WS endpoint was removed as part of the stream-session migration.
    // See apps/hammurabi/modules/agents/routes.ts for the agents WS handler.
  })

  it('supports quest CRUD routes including note appends', async () => {
    const dir = await createTempDir('hammurabi-commanders-quest-routes-')
    const storePath = join(dir, 'sessions.json')
    const server = await startServer({ sessionStorePath: storePath })

    try {
      const createCommanderResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-quest-routes',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const commander = (await createCommanderResponse.json()) as { id: string }

      const createQuestResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          source: 'manual',
          instruction: 'Draft implementation plan',
          contract: {
            cwd: '/tmp/example-repo',
            permissionMode: 'bypassPermissions',
            agentType: 'claude',
            skillsToUse: ['issue-finder'],
          },
        }),
      })
      expect(createQuestResponse.status).toBe(201)
      const createdQuest = (await createQuestResponse.json()) as {
        id: string
        status: string
      }
      expect(createdQuest.status).toBe('pending')

      const listResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        headers: AUTH_HEADERS,
      })
      expect(listResponse.status).toBe(200)
      const listed = (await listResponse.json()) as Array<{ id: string }>
      expect(listed).toHaveLength(1)
      expect(listed[0]?.id).toBe(createdQuest.id)

      const patchResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/quests/${createdQuest.id}`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            status: 'active',
            note: 'Started working on the route implementation',
          }),
        },
      )
      expect(patchResponse.status).toBe(200)
      const patched = (await patchResponse.json()) as { status: string; note?: string }
      expect(patched.status).toBe('active')
      expect(patched.note).toBe('Started working on the route implementation')

      const appendNoteResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/quests/${createdQuest.id}/notes`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            note: 'Added tests and confirmed passing status',
          }),
        },
      )
      expect(appendNoteResponse.status).toBe(200)
      const noted = (await appendNoteResponse.json()) as { note?: string }
      expect(noted.note).toContain('Started working on the route implementation')
      expect(noted.note).toContain('Added tests and confirmed passing status')

      const deleteResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/quests/${createdQuest.id}`,
        {
          method: 'DELETE',
          headers: AUTH_HEADERS,
        },
      )
      expect(deleteResponse.status).toBe(204)

      const emptyListResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        headers: AUTH_HEADERS,
      })
      expect(emptyListResponse.status).toBe(200)
      expect(await emptyListResponse.json()).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('resets active quests to pending when commander starts', async () => {
    const dir = await createTempDir('hammurabi-commanders-quest-stale-guard-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()
    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createCommanderResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-quest-stale-guard',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const commander = (await createCommanderResponse.json()) as { id: string }

      const createQuestResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          source: 'manual',
          instruction: 'Fix stale quest state',
        }),
      })
      const createdQuest = (await createQuestResponse.json()) as { id: string }

      const patchToActiveResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/quests/${createdQuest.id}`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            status: 'active',
          }),
        },
      )
      expect(patchToActiveResponse.status).toBe(200)

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      const questsResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        headers: AUTH_HEADERS,
      })
      const quests = (await questsResponse.json()) as Array<{ id: string; status: string }>
      expect(quests).toEqual([
        expect.objectContaining({
          id: createdQuest.id,
          status: 'pending',
        }),
      ])
    } finally {
      await server.close()
    }
  })

  it('prepends pending quests to heartbeat messages', async () => {
    const dir = await createTempDir('hammurabi-commanders-quest-heartbeat-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mock = createMockSessionsInterface()

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: mock.interface,
    })

    try {
      const createCommanderResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-quest-heartbeat',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const commander = (await createCommanderResponse.json()) as { id: string }

      const instructions = [
        'First pending quest',
        'Second pending quest',
        'Third pending quest',
        'Fourth pending quest',
      ]
      for (const instruction of instructions) {
        const createQuestResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            source: 'manual',
            instruction,
          }),
        })
        expect(createQuestResponse.status).toBe(201)
      }

      const patchHeartbeatResponse = await fetch(
        `${server.baseUrl}/api/commanders/${commander.id}/heartbeat`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            intervalMs: 25,
            messageTemplate: '[HB {{timestamp}}]',
          }),
        },
      )
      expect(patchHeartbeatResponse.status).toBe(200)

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(startResponse.status).toBe(200)

      // Wait for at least a startup send + one heartbeat with quest board
      await vi.waitFor(() => {
        expect(
          mock.sendCalls.some((call) => call.text.includes('[QUEST BOARD] Top pending quests:')),
        ).toBe(true)
      })

      const heartbeatCall = mock.sendCalls.find((call) =>
        call.text.includes('[QUEST BOARD] Top pending quests:'),
      )

      expect(heartbeatCall).toBeDefined()
      const heartbeatText = heartbeatCall?.text ?? ''
      expect(heartbeatText).toContain('1. First pending quest')
      expect(heartbeatText).toContain('2. Second pending quest')
      const hasThirdQuest = heartbeatText.includes('3. Third pending quest')
      const hasFourthQuest = heartbeatText.includes('3. Fourth pending quest')
      expect(hasThirdQuest || hasFourthQuest).toBe(true)
      expect(hasThirdQuest && hasFourthQuest).toBe(false)

      const stopResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
      })
      expect(stopResponse.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('imports instruction text from githubIssueUrl', async () => {
    const dir = await createTempDir('hammurabi-commanders-quest-github-import-')
    const storePath = join(dir, 'sessions.json')
    const readTask = vi.fn(async () => ({
      number: 331,
      title: 'Implement quest board backend',
      body: 'Add store, routes, and tests for commander quests.',
      labels: ['commander'],
      assignees: [],
      comments: [],
      url: 'https://github.com/example-user/example-repo/issues/331',
    }))
    const ghTasksFactory = vi.fn((_repo: string) => ({ readTask }))

    const server = await startServer({
      sessionStorePath: storePath,
      ghTasksFactory,
    })

    try {
      const createCommanderResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-quest-github-import',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      const commander = (await createCommanderResponse.json()) as { id: string }

      const createQuestResponse = await fetch(`${server.baseUrl}/api/commanders/${commander.id}/quests`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          githubIssueUrl: 'https://github.com/example-user/example-repo/issues/331',
        }),
      })

      expect(createQuestResponse.status).toBe(201)
      const createdQuest = (await createQuestResponse.json()) as {
        source: string
        instruction: string
      }
      expect(createdQuest.source).toBe('github-issue')
      expect(createdQuest.instruction).toContain('Implement quest board backend')
      expect(createdQuest.instruction).toContain('Add store, routes, and tests for commander quests.')
      expect(ghTasksFactory).toHaveBeenCalledWith('example-user/example-repo')
      expect(readTask).toHaveBeenCalledWith(331)
    } finally {
      await server.close()
    }
  })

  it('persists sessions across server restarts', async () => {
    const dir = await createTempDir('hammurabi-commanders-restart-')
    const storePath = join(dir, 'sessions.json')

    const firstServer = await startServer({ sessionStorePath: storePath })
    const createResponse = await fetch(`${firstServer.baseUrl}/api/commanders`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        host: 'worker-restart',
        taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
      }),
    })
    expect(createResponse.status).toBe(201)
    await firstServer.close()

    const secondServer = await startServer({ sessionStorePath: storePath })
    try {
      const listResponse = await fetch(`${secondServer.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      expect(listResponse.status).toBe(200)
      expect(await listResponse.json()).toEqual([
        expect.objectContaining({
          host: 'worker-restart',
          state: 'idle',
        }),
      ])
    } finally {
      await secondServer.close()
    }
  })

  describe('memory CLI endpoints', () => {
    async function createServerWithCommander(
      options: Partial<CommandersRouterOptions> = {},
    ): Promise<{
      server: RunningServer
      commanderId: string
      memoryBasePath: string
    }> {
      const dir = await createTempDir('hammurabi-memory-routes-')
      const storePath = join(dir, 'sessions.json')
      const memoryBasePath = join(dir, 'commanders')
      const commanderId = 'cmdr-mem-1'
      await writeFile(
        storePath,
        JSON.stringify({
          sessions: [
            {
              id: commanderId,
              host: 'test-host',
              pid: null,
              state: 'idle',
              created: '2026-03-01T00:00:00.000Z',
              lastHeartbeat: null,
              taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
              currentTask: null,
              completedTasks: 0,
              totalCostUsd: 0,
            },
          ],
        }),
      )
      const server = await startServer({
        sessionStorePath: storePath,
        memoryBasePath,
        agentsSessionStorePath: join(dir, 'agents-sessions.json'),
        ...options,
      })
      return { server, commanderId, memoryBasePath }
    }

    it('POST /:id/memory/compact returns consolidation report', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/compact`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toHaveProperty('factsExtracted')
        expect(body).toHaveProperty('memoryMdLineCount')
        expect(body).toHaveProperty('entriesCompressed')
        expect(body).toHaveProperty('debrifsProcessed')
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/compact returns 404 for unknown commander', async () => {
      const { server } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/nonexistent/memory/compact`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        expect(response.status).toBe(404)
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/recall returns hits for a cue', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/recall`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ cue: 'prisma migration' }),
          },
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toHaveProperty('hits')
        expect(body).toHaveProperty('queryTerms')
        expect(Array.isArray(body.hits)).toBe(true)
        expect(Array.isArray(body.queryTerms)).toBe(true)
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/recall returns 400 when cue is missing', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/recall`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.error).toContain('cue is required')
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/semantic-search returns semantic results', async () => {
      const semanticSearchRunner = vi.fn(async () => ([
        {
          score: 0.872,
          text: 'Agent memory architecture uses semantic search over the knowledge cache.',
          source_file: '/home/ec2-user/.ginsights/domains/agentic-ai/knowledge/agent-fleet-operations.md',
          section_header: 'Agent Memory Architecture',
          chunk_index: 0,
        },
      ]))
      const { server, commanderId } = await createServerWithCommander({ semanticSearchRunner })
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/semantic-search`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'agent memory', topK: 3 }),
          },
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual([
          expect.objectContaining({
            section_header: 'Agent Memory Architecture',
            source_file: '/home/ec2-user/.ginsights/domains/agentic-ai/knowledge/agent-fleet-operations.md',
          }),
        ])
        expect(semanticSearchRunner).toHaveBeenCalledWith('agent memory', 3)
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/semantic-search returns 400 when query is missing', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/semantic-search`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.error).toContain('query is required')
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/facts saves facts and returns result', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/facts`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ facts: ['Always use pnpm in monorepo'] }),
          },
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toHaveProperty('factsAdded')
        expect(body).toHaveProperty('lineCount')
        expect(body).toHaveProperty('evicted')
        expect(body.factsAdded).toBe(1)
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/facts returns 400 when facts is empty', async () => {
      const { server, commanderId } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/${commanderId}/memory/facts`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ facts: [] }),
          },
        )
        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.error).toContain('facts array')
      } finally {
        await server.close()
      }
    })

    it('POST /:id/memory/facts returns 404 for unknown commander', async () => {
      const { server } = await createServerWithCommander()
      try {
        const response = await fetch(
          `${server.baseUrl}/api/commanders/nonexistent/memory/facts`,
          {
            method: 'POST',
            headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ facts: ['some fact'] }),
          },
        )
        expect(response.status).toBe(404)
      } finally {
        await server.close()
      }
    })

    it('exposes read-only workspace tree and file preview routes', async () => {
      const workspaceDir = await createTempDir('hammurabi-commander-workspace-')
      await mkdir(join(workspaceDir, 'quests'), { recursive: true })
      await writeFile(join(workspaceDir, 'brief.md'), 'Commander workspace\n', 'utf8')

      const server = await startServer()
      try {
        const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
          method: 'POST',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            host: 'local-hq',
            cwd: workspaceDir,
          }),
        })
        expect(createResponse.status).toBe(201)
        const created = await createResponse.json()

        const treeResponse = await fetch(
          `${server.baseUrl}/api/commanders/${created.id}/workspace/tree`,
          { headers: AUTH_HEADERS },
        )
        expect(treeResponse.status).toBe(200)
        const treeBody = await treeResponse.json()
        expect(treeBody.nodes.map((node: { name: string }) => node.name)).toEqual(['quests', 'brief.md'])

        const fileResponse = await fetch(
          `${server.baseUrl}/api/commanders/${created.id}/workspace/file?path=brief.md`,
          { headers: AUTH_HEADERS },
        )
        expect(fileResponse.status).toBe(200)
        const fileBody = await fileResponse.json()
        expect(fileBody.kind).toBe('text')
        expect(fileBody.content).toContain('Commander workspace')
      } finally {
        await server.close()
      }
    })
  })
})
