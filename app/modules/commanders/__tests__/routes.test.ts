import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { CommanderCronManager, type CronScheduler } from '../cron-manager.js'
import { CommanderCronTaskStore } from '../cron-store.js'
import { createCommandersRouter, type CommandersRouterOptions } from '../routes'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_MESSAGE,
} from '../heartbeat'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

const NEXT_RUN_ISO = '2026-03-02T02:00:00.000Z'

interface RunningServer {
  baseUrl: string
  httpServer: Server
  close: () => Promise<void>
}

interface QueuedQueryCall {
  prompt: string
  options?: Record<string, unknown>
}

interface MockClaudeQuery {
  query: NonNullable<CommandersRouterOptions['queryFn']>
  calls: QueuedQueryCall[]
  enqueue: (events: unknown[]) => void
}

interface CronRunningServer {
  baseUrl: string
  close: () => Promise<void>
}

interface MockJob {
  stop: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  getNextRun: ReturnType<typeof vi.fn>
}

interface ScheduledRegistration {
  expression: string
  task: () => Promise<void> | void
  job: MockJob
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

function createMockClaudeQuery(): MockClaudeQuery {
  const queue: unknown[][] = []
  const calls: QueuedQueryCall[] = []
  const query = vi.fn((input: { prompt: string; options?: Record<string, unknown> }) => {
    calls.push({ prompt: input.prompt, options: input.options })
    const events = queue.shift() ?? []
    return (async function* () {
      for (const event of events) {
        yield event
      }
    })()
  })

  return {
    query,
    calls,
    enqueue: (events: unknown[]) => {
      queue.push(events)
    },
  }
}

function createMockScheduler(): {
  scheduler: CronScheduler
  scheduled: ScheduledRegistration[]
} {
  const scheduled: ScheduledRegistration[] = []
  const scheduler: CronScheduler = {
    validate: vi.fn((expression: string) => expression !== 'invalid cron'),
    schedule: vi.fn((expression, task) => {
      const job: MockJob = {
        stop: vi.fn(),
        destroy: vi.fn(),
        getNextRun: vi.fn(() => new Date(NEXT_RUN_ISO)),
      }
      scheduled.push({
        expression,
        task,
        job,
      })
      return job
    }),
  }

  return {
    scheduler,
    scheduled,
  }
}

async function startServer(
  options: Partial<CommandersRouterOptions> = {},
): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const commanders = createCommandersRouter({
    apiKeyStore: createTestApiKeyStore(),
    ...options,
  })
  app.use('/api/commanders', commanders.router)

  const httpServer = createServer(app)
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/commanders/')) {
      commanders.handleUpgrade(req, socket, head)
      return
    }
    socket.destroy()
  })

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

async function startCronServer(options: {
  store: CommanderCronTaskStore
  manager: CommanderCronManager
}): Promise<CronRunningServer> {
  const app = express()
  app.use(express.json())
  const { router } = createCommandersRouter({
    cronManager: options.manager,
    apiKeyStore: createTestApiKeyStore(),
  })
  app.use('/api/commanders', router)

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
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

async function connectWs(baseUrl: string, commanderId: string, apiKey = 'test-key'): Promise<WebSocket> {
  const wsUrl = baseUrl.replace('http://', 'ws://') +
    `/api/commanders/${encodeURIComponent(commanderId)}/ws?api_key=${apiKey}`
  const ws = new WebSocket(wsUrl)
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out opening commander websocket'))
    }, 3_000)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('open', onOpen)
      ws.off('error', onError)
      ws.off('unexpected-response', onUnexpectedResponse)
    }

    const onOpen = () => {
      cleanup()
      resolve(ws)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }) => {
      cleanup()
      reject(new Error(`WebSocket upgrade rejected with status ${res.statusCode}`))
    }

    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('unexpected-response', (_req, res) => {
      onUnexpectedResponse(_req, res)
    })
  })
}

function waitForWsJson(
  ws: WebSocket,
  predicate: (payload: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for WebSocket message'))
    }, 3_000)

    const onMessage = (raw: WebSocket.RawData) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }

      if (!predicate(parsed)) {
        return
      }

      cleanup()
      resolve(parsed)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }

    ws.on('message', onMessage)
    ws.on('error', onError)
  })
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
    const server = await startServer({ sessionStorePath: storePath })

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
    } finally {
      await server.close()
    }
  })

  it('updates heartbeat config without starting commander runtime', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-config-')
    const storePath = join(dir, 'sessions.json')
    const mockQuery = createMockClaudeQuery()
    const server = await startServer({
      sessionStorePath: storePath,
      queryFn: mockQuery.query,
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
      expect(mockQuery.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('sends periodic heartbeat messages while running and stops after stop', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-loop-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mockQuery = createMockClaudeQuery()
    mockQuery.enqueue([{ type: 'system', subtype: 'init', session_id: 'claude-cmdr-heartbeat' }])
    mockQuery.enqueue([{ type: 'assistant', message: { content: [{ type: 'text', text: 'heartbeat' }] } }])

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      queryFn: mockQuery.query,
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

      await vi.waitFor(() => {
        expect(mockQuery.calls.length).toBeGreaterThanOrEqual(2)
      })
      expect(mockQuery.calls.some((call) => call.prompt.includes('[HEARTBEAT QUICK '))).toBe(true)

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
      const callsAfterStopSettled = mockQuery.calls.length
      await sleep(80)
      expect(mockQuery.calls.length).toBe(callsAfterStopSettled)
    } finally {
      await server.close()
    }
  })

  it('applies heartbeat PATCH updates immediately for running commander', async () => {
    const dir = await createTempDir('hammurabi-commanders-heartbeat-live-patch-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mockQuery = createMockClaudeQuery()
    mockQuery.enqueue([{ type: 'system', subtype: 'init', session_id: 'claude-cmdr-heartbeat-live' }])

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      queryFn: mockQuery.query,
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
        expect(mockQuery.calls.some((call) => call.prompt.includes('[HB1 '))).toBe(true)
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
        expect(mockQuery.calls.some((call) => call.prompt.includes('[HB2 '))).toBe(true)
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

  it('starts and stops commander lifecycle with SDK query', async () => {
    const dir = await createTempDir('hammurabi-commanders-lifecycle-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mockQuery = createMockClaudeQuery()
    mockQuery.enqueue([
      { type: 'system', subtype: 'init', session_id: 'claude-cmdr-1' },
      { type: 'result', total_cost_usd: 1.25 },
    ])

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      queryFn: mockQuery.query,
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

      await vi.waitFor(() => {
        expect(mockQuery.calls).toHaveLength(1)
      })
      expect(mockQuery.calls[0]?.options?.systemPrompt).toEqual(expect.stringContaining('## Commander Memory'))

      await vi.waitFor(async () => {
        const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
          headers: AUTH_HEADERS,
        })
        const sessions = (await listResponse.json()) as Array<{
          id: string
          state: string
          totalCostUsd: number
        }>
        const started = sessions.find((entry) => entry.id === created.id)
        expect(started?.state).toBe('running')
        expect(started?.totalCostUsd).toBe(1.25)
      })

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

  it('sends message to running commander', async () => {
    const dir = await createTempDir('hammurabi-commanders-message-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mockQuery = createMockClaudeQuery()
    mockQuery.enqueue([{ type: 'system', subtype: 'init', session_id: 'claude-cmdr-msg' }])
    mockQuery.enqueue([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } }])

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      queryFn: mockQuery.query,
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

      const messageResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/message`, {
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

      await vi.waitFor(() => {
        expect(mockQuery.calls).toHaveLength(2)
      })
      expect(mockQuery.calls[1]?.prompt).toBe(message)
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

  it('streams live events over websocket', async () => {
    const dir = await createTempDir('hammurabi-commanders-ws-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const mockQuery = createMockClaudeQuery()
    mockQuery.enqueue([
      { type: 'system', subtype: 'init', session_id: 'claude-cmdr-ws' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Session started' }] } },
    ])
    mockQuery.enqueue([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Live reply' }] } },
    ])

    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      queryFn: mockQuery.query,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-ws',
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

      await vi.waitFor(() => {
        expect(mockQuery.calls).toHaveLength(1)
      })

      const ws = await connectWs(server.baseUrl, created.id)

      const livePromise = waitForWsJson(
        ws,
        (payload) =>
          payload.type === 'assistant' &&
          JSON.stringify(payload).includes('Live reply'),
      )

      const messageResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Send live update',
        }),
      })
      expect(messageResponse.status).toBe(200)

      const live = await livePromise
      expect(live.type).toBe('assistant')

      ws.close()
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
})

describe('commanders cron routes', () => {
  let tmpDir: string
  let store: CommanderCronTaskStore
  let manager: CommanderCronManager
  let scheduled: ScheduledRegistration[]
  let dispatcher: { sendInstruction: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hammurabi-commanders-routes-test-'))
    store = new CommanderCronTaskStore(join(tmpDir, 'cron-tasks.json'))
    const mockScheduler = createMockScheduler()
    scheduled = mockScheduler.scheduled
    dispatcher = {
      sendInstruction: vi.fn(async () => {}),
    }
    manager = new CommanderCronManager({
      store,
      scheduler: mockScheduler.scheduler,
      dispatcher,
      now: () => new Date('2026-03-01T10:00:00.000Z'),
    })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists cron tasks for a commander', async () => {
    await store.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
      nextRun: null,
    })
    const server = await startCronServer({ store, manager })

    try {
      const response = await fetch(`${server.baseUrl}/api/commanders/cmdr-1/crons`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as Array<{
        commanderId: string
        schedule: string
      }>
      expect(payload).toHaveLength(1)
      expect(payload[0]).toEqual(
        expect.objectContaining({
          commanderId: 'cmdr-1',
          schedule: '0 2 * * *',
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('creates a cron task and schedules it immediately', async () => {
    const server = await startCronServer({ store, manager })

    try {
      const response = await fetch(`${server.baseUrl}/api/commanders/cmdr-1/crons`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schedule: '0 2 * * *',
          instruction: 'run nightly test suite',
        }),
      })

      expect(response.status).toBe(201)
      expect(scheduled).toHaveLength(1)
      const payload = (await response.json()) as {
        commanderId: string
        nextRun: string | null
      }
      expect(payload.commanderId).toBe('cmdr-1')
      expect(payload.nextRun).toBe(NEXT_RUN_ISO)
    } finally {
      await server.close()
    }
  })

  it('pauses a cron task when PATCH sets enabled=false', async () => {
    const created = await store.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
      nextRun: null,
    })
    const server = await startCronServer({ store, manager })

    try {
      const response = await fetch(
        `${server.baseUrl}/api/commanders/cmdr-1/crons/${created.id}`,
        {
          method: 'PATCH',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        },
      )

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        id: string
        enabled: boolean
        nextRun: string | null
      }
      expect(payload.id).toBe(created.id)
      expect(payload.enabled).toBe(false)
      expect(payload.nextRun).toBeNull()

      const listResponse = await fetch(`${server.baseUrl}/api/commanders/cmdr-1/crons`, {
        headers: AUTH_HEADERS,
      })
      const tasks = (await listResponse.json()) as Array<{ id: string }>
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.id).toBe(created.id)
    } finally {
      await server.close()
    }
  })

  it('deletes a cron task and removes it from the store', async () => {
    const created = await store.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
      nextRun: null,
    })
    const server = await startCronServer({ store, manager })

    try {
      const response = await fetch(
        `${server.baseUrl}/api/commanders/cmdr-1/crons/${created.id}`,
        {
          method: 'DELETE',
          headers: AUTH_HEADERS,
        },
      )
      expect(response.status).toBe(204)

      const listResponse = await fetch(`${server.baseUrl}/api/commanders/cmdr-1/crons`, {
        headers: AUTH_HEADERS,
      })
      const tasks = (await listResponse.json()) as Array<{ id: string }>
      expect(tasks).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('accepts cron-trigger payloads and dispatches instructions when present', async () => {
    const server = await startCronServer({ store, manager })

    try {
      const triggeredResponse = await fetch(
        `${server.baseUrl}/api/commanders/cmdr-1/cron-trigger`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            detail: {
              instruction: 'run backup',
            },
          }),
        },
      )

      expect(triggeredResponse.status).toBe(200)
      expect(await triggeredResponse.json()).toEqual({
        ok: true,
        triggered: true,
      })
      expect(dispatcher.sendInstruction).toHaveBeenCalledWith('cmdr-1', 'run backup')

      const noopResponse = await fetch(
        `${server.baseUrl}/api/commanders/cmdr-1/cron-trigger`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            detail: {},
          }),
        },
      )
      expect(noopResponse.status).toBe(200)
      expect(await noopResponse.json()).toEqual({
        ok: true,
        triggered: false,
      })
    } finally {
      await server.close()
    }
  })

  it('returns 400 for invalid cron expressions', async () => {
    const server = await startCronServer({ store, manager })

    try {
      const response = await fetch(`${server.baseUrl}/api/commanders/cmdr-1/crons`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schedule: 'invalid cron',
          instruction: 'run nightly test suite',
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Invalid cron expression',
      })
    } finally {
      await server.close()
    }
  })
})
