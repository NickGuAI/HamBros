import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'

// Mock child_process.spawn so stream session tests can control the child process.
// vi.mock is hoisted before imports by Vitest, so routes.ts gets the mock.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  }
})

const { mockedNodePtySpawn } = vi.hoisted(() => ({
  mockedNodePtySpawn: vi.fn(),
}))

vi.mock('@lydell/node-pty', () => ({
  spawn: mockedNodePtySpawn,
}))

import {
  createAgentsRouter,
  type AgentsRouterOptions,
  type PtyHandle,
  type PtySpawner,
} from '../routes'
import {
  appendTranscriptEvent,
  resetTranscriptStoreRoot,
  setTranscriptStoreRoot,
  writeSessionMeta,
} from '../transcript-store'
import { CommanderSessionStore, type CommanderSession } from '../../commanders/store'
import { spawn as spawnFn } from 'node:child_process'

// Typed reference to the mocked spawn function
const mockedSpawn = vi.mocked(spawnFn)

interface MockPtyHandle extends PtyHandle {
  dataCallbacks: ((data: string) => void)[]
  exitCallbacks: ((e: { exitCode: number; signal?: number }) => void)[]
  emitData(data: string): void
  emitExit(e: { exitCode: number; signal?: number }): void
}

function createMockPtyHandle(): MockPtyHandle {
  const dataCallbacks: ((data: string) => void)[] = []
  const exitCallbacks: ((e: { exitCode: number; signal?: number }) => void)[] = []

  return {
    pid: 12345,
    dataCallbacks,
    exitCallbacks,
    onData(cb) {
      dataCallbacks.push(cb)
      return {
        dispose: () => {
          const index = dataCallbacks.indexOf(cb)
          if (index >= 0) {
            dataCallbacks.splice(index, 1)
          }
        },
      }
    },
    onExit(cb) {
      exitCallbacks.push(cb)
      return {
        dispose: () => {
          const index = exitCallbacks.indexOf(cb)
          if (index >= 0) {
            exitCallbacks.splice(index, 1)
          }
        },
      }
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData(data: string) {
      for (const cb of dataCallbacks) {
        cb(data)
      }
    },
    emitExit(e: { exitCode: number; signal?: number }) {
      for (const cb of exitCallbacks) {
        cb(e)
      }
    },
  }
}

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
  httpServer: Server
  agents: ReturnType<typeof createAgentsRouter>
}

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

const READ_ONLY_AUTH_HEADERS = {
  'x-hammurabi-api-key': 'read-only-key',
}

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
      scopes: ['agents:read', 'agents:write'],
    },
    'read-only-key': {
      id: 'test-read-key-id',
      name: 'Read-only Key',
      keyHash: 'hash',
      prefix: 'hmrb_test_read',
      createdBy: 'test',
      createdAt: '2026-02-16T00:00:00.000Z',
      lastUsedAt: null,
      scopes: ['agents:read'],
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

      return {
        ok: true as const,
        record,
      }
    },
  }
}

function createMockPtySpawner(
  handleOverride?: () => MockPtyHandle,
): { spawner: PtySpawner; lastHandle: () => MockPtyHandle | null } {
  let lastCreated: MockPtyHandle | null = null
  const spawner: PtySpawner = {
    spawn: vi.fn(() => {
      lastCreated = handleOverride ? handleOverride() : createMockPtyHandle()
      return lastCreated
    }),
  }
  return { spawner, lastHandle: () => lastCreated }
}

interface TempMachinesRegistry {
  filePath: string
  cleanup: () => Promise<void>
}

async function createTempMachinesRegistry(contents: unknown): Promise<TempMachinesRegistry> {
  const dir = await mkdtemp(join(tmpdir(), 'hammurabi-machines-'))
  const filePath = join(dir, 'machines.json')
  const payload = typeof contents === 'string' ? contents : JSON.stringify(contents)
  await writeFile(filePath, payload)
  return {
    filePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function createMissingMachinesRegistryPath(): Promise<TempMachinesRegistry> {
  const dir = await mkdtemp(join(tmpdir(), 'hammurabi-machines-missing-'))
  return {
    filePath: join(dir, 'machines.json'),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function startServer(options: Partial<AgentsRouterOptions> = {}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const agents = createAgentsRouter({
    apiKeyStore: createTestApiKeyStore(),
    autoResumeSessions: false,
    commanderSessionStorePath: '/tmp/nonexistent-commander-sessions-test.json',
    ...options,
  })
  app.use('/api/agents', agents.router)

  const httpServer = createServer(app)
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/agents/')) {
      agents.handleUpgrade(req, socket, head)
    } else {
      socket.destroy()
    }
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
    agents,
    httpServer,
    close: async () => {
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

function connectWs(
  baseUrl: string,
  sessionName: string,
  apiKey = 'test-key',
): Promise<WebSocket> {
  const wsUrl = baseUrl.replace('http://', 'ws://') +
    `/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?api_key=${apiKey}`
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`WebSocket upgrade rejected with status ${res.statusCode}`))
    })
  })
}

async function connectWsWithReplay(
  baseUrl: string,
  sessionName: string,
  apiKey = 'test-key',
): Promise<{
  ws: WebSocket
  replay: {
    type: 'replay'
    events: Array<Record<string, unknown>>
    usage?: { inputTokens: number; outputTokens: number; costUsd: number }
  }
}> {
  const wsUrl = baseUrl.replace('http://', 'ws://') +
    `/api/agents/sessions/${encodeURIComponent(sessionName)}/terminal?api_key=${apiKey}`
  const ws = new WebSocket(wsUrl)

  const replayPromise = new Promise<{
    type: 'replay'
    events: Array<Record<string, unknown>>
    usage?: { inputTokens: number; outputTokens: number; costUsd: number }
  }>((resolve, reject) => {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as {
        type: string
        events?: Array<Record<string, unknown>>
        usage?: { inputTokens: number; outputTokens: number; costUsd: number }
      }
      if (parsed.type === 'replay' && Array.isArray(parsed.events)) {
        resolve({
          type: 'replay',
          events: parsed.events,
          usage: parsed.usage,
        })
      }
    })
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`WebSocket upgrade rejected with status ${res.statusCode}`))
    })
  })

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`WebSocket upgrade rejected with status ${res.statusCode}`))
    })
  })

  return {
    ws,
    replay: await replayPromise,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  mockedNodePtySpawn.mockReset()
  resetTranscriptStoreRoot()
})

beforeEach(() => {
  vi.spyOn(CommanderSessionStore.prototype, 'list').mockResolvedValue([])
  mockedNodePtySpawn.mockImplementation(() => createMockPtyHandle())
})

describe('agents routes', () => {
  it('requires authentication to access sessions', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/sessions`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('returns empty session list initially', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })
    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual([])

    await server.close()
  })

  it('returns empty world agent list initially', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })
    const response = await fetch(`${server.baseUrl}/api/agents/world`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])

    await server.close()
  })

  it('merges commander sessions with role and excludes stopped commanders', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const commanderSessions: CommanderSession[] = [
      {
        id: 'alpha',
        host: 'localhost',
        pid: 101,
        state: 'running',
        created: '2026-03-06T00:00:00.000Z',
        agentType: 'codex',
        heartbeat: {
          intervalMs: 300000,
          messageTemplate: 'ping',
          lastSentAt: null,
        },
        lastHeartbeat: '2026-03-06T00:01:00.000Z',
        taskSource: { owner: 'example-user', repo: 'example-repo' },
        currentTask: {
          issueNumber: 331,
          issueUrl: 'https://github.com/example-user/example-repo/issues/331',
          startedAt: '2026-03-06T00:00:30.000Z',
        },
        completedTasks: 0,
        totalCostUsd: 1.25,
      },
      {
        id: 'commander-beta',
        host: 'localhost',
        pid: 202,
        state: 'paused',
        created: '2026-03-06T00:02:00.000Z',
        heartbeat: {
          intervalMs: 300000,
          messageTemplate: 'ping',
          lastSentAt: null,
        },
        lastHeartbeat: '2026-03-06T00:03:00.000Z',
        taskSource: { owner: 'example-user', repo: 'example-repo' },
        currentTask: null,
        completedTasks: 0,
        totalCostUsd: 0.5,
      },
      {
        id: 'gamma',
        host: 'localhost',
        pid: null,
        state: 'stopped',
        created: '2026-03-06T00:04:00.000Z',
        heartbeat: {
          intervalMs: 300000,
          messageTemplate: 'ping',
          lastSentAt: null,
        },
        lastHeartbeat: null,
        taskSource: { owner: 'example-user', repo: 'example-repo' },
        currentTask: null,
        completedTasks: 1,
        totalCostUsd: 2.0,
      },
    ]

    vi.mocked(CommanderSessionStore.prototype.list).mockResolvedValue(commanderSessions)

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'world-worker-01',
          mode: 'default',
        }),
      })
      expect(createResponse.status).toBe(201)

      const response = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      const payload = await response.json() as Array<{
        id: string
        role: string
        status: string
        phase: string
      }>

      expect(response.status).toBe(200)
      expect(payload).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'world-worker-01',
          role: 'worker',
        }),
        expect.objectContaining({
          id: 'commander-alpha',
          agentType: 'codex',
          role: 'commander',
          status: 'active',
          phase: 'thinking',
        }),
        expect.objectContaining({
          id: 'commander-beta',
          role: 'commander',
          status: 'idle',
          phase: 'blocked',
        }),
      ]))
      expect(payload.some((agent) => agent.id === 'commander-gamma')).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('returns PTY world agent with idle phase, zero usage, empty task, and null lastToolUse', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'world-pty-01',
        mode: 'default',
      }),
    })
    expect(createResponse.status).toBe(201)

    const response = await fetch(`${server.baseUrl}/api/agents/world`, {
      headers: AUTH_HEADERS,
    })
    const payload = await response.json() as Array<{
      id: string
      agentType: string
      sessionType: string
      status: string
      phase: string
      usage: { inputTokens: number; outputTokens: number; costUsd: number }
      task: string
      lastToolUse: string | null
      lastUpdatedAt: string
    }>

    expect(response.status).toBe(200)
    expect(payload).toHaveLength(1)
    expect(payload[0].id).toBe('world-pty-01')
    expect(payload[0].agentType).toBe('claude')
    expect(payload[0].sessionType).toBe('pty')
    expect(payload[0].status).toBe('active')
    expect(payload[0].phase).toBe('idle')
    expect(payload[0].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })
    expect(payload[0].task).toBe('')
    expect(payload[0].lastToolUse).toBeNull()
    expect(payload[0].lastUpdatedAt).toEqual(expect.any(String))

    await server.close()
  })

  it('returns stream world agent with tool_use phase and includes usage + task + lastToolUse', async () => {
    const streamMock = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(streamMock.cp as never)
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'world-stream-01',
        mode: 'default',
        sessionType: 'stream',
        task: 'Fix login retries',
      }),
    })
    expect(createResponse.status).toBe(201)

    streamMock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
    streamMock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"ls -la"}}]}}\n')

    const response = await fetch(`${server.baseUrl}/api/agents/world`, {
      headers: AUTH_HEADERS,
    })
    const payload = await response.json() as Array<{
      id: string
      phase: string
      usage: { inputTokens: number; outputTokens: number; costUsd: number }
      task: string
      lastToolUse: string | null
    }>

    expect(response.status).toBe(200)
    expect(payload).toHaveLength(1)
    expect(payload[0].id).toBe('world-stream-01')
    expect(payload[0].phase).toBe('tool_use')
    expect(payload[0].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    })
    expect(payload[0].task).toBe('Fix login retries')
    expect(payload[0].lastToolUse).toBe('Bash')

    await server.close()
  })

  it('classifies stream phase as blocked for pending AskUserQuestion and thinking after tool_result', async () => {
    const streamMock = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(streamMock.cp as never)
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'world-blocked-01',
          mode: 'default',
          sessionType: 'stream',
          task: 'Need clarification',
        }),
      })
      expect(createResponse.status).toBe(201)

      streamMock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
      streamMock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"ask_1","name":"AskUserQuestion","input":{"questions":[{"question":"Pick one","multiSelect":false,"options":[{"label":"A","description":"A"}]}]}}]}}\n')

      const blockedResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      expect(blockedResponse.status).toBe(200)
      const blockedPayload = await blockedResponse.json() as Array<{ phase: string; lastToolUse: string | null }>
      expect(blockedPayload).toHaveLength(1)
      expect(blockedPayload[0].phase).toBe('blocked')
      expect(blockedPayload[0].lastToolUse).toBe('AskUserQuestion')

      streamMock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"ask_1","content":"{\\"answers\\":{\\"Pick one\\":\\"A\\"},\\"annotations\\":{}}"}]}}\n')

      const thinkingResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      expect(thinkingResponse.status).toBe(200)
      const thinkingPayload = await thinkingResponse.json() as Array<{ phase: string; lastToolUse: string | null }>
      expect(thinkingPayload).toHaveLength(1)
      expect(thinkingPayload[0].phase).toBe('thinking')
      expect(thinkingPayload[0].lastToolUse).toBe('AskUserQuestion')
    } finally {
      await server.close()
    }
  })

  it('classifies world status as active/idle/stale/completed based on event recency and completion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const baseTime = new Date('2026-03-05T00:00:00.000Z')
      vi.setSystemTime(baseTime)

      const streamMock = createMockChildProcess()
      mockedSpawn.mockReturnValueOnce(streamMock.cp as never)
      const server = await startServer()

      try {
        const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'world-status-01',
            mode: 'default',
            sessionType: 'stream',
          }),
        })
        expect(createResponse.status).toBe(201)

        // Mark turn in-progress so status derives from recency windows.
        streamMock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

        const statusAt = async (iso: string): Promise<string> => {
          vi.setSystemTime(new Date(iso))
          const response = await fetch(`${server.baseUrl}/api/agents/world`, {
            headers: AUTH_HEADERS,
          })
          expect(response.status).toBe(200)
          const payload = await response.json() as Array<{ status: string }>
          expect(payload).toHaveLength(1)
          return payload[0].status
        }

        expect(await statusAt('2026-03-05T00:00:30.000Z')).toBe('active')
        expect(await statusAt('2026-03-05T00:01:00.000Z')).toBe('idle')
        expect(await statusAt('2026-03-05T00:05:00.000Z')).toBe('idle')
        expect(await statusAt('2026-03-05T00:05:01.000Z')).toBe('stale')
        const stalePhaseResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
          headers: AUTH_HEADERS,
        })
        expect(stalePhaseResponse.status).toBe(200)
        const stalePhasePayload = await stalePhaseResponse.json() as Array<{ phase: string }>
        expect(stalePhasePayload[0].phase).toBe('stale')

        streamMock.emitStdout('{"type":"result","result":"done"}\n')
        const completedResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
          headers: AUTH_HEADERS,
        })
        expect(completedResponse.status).toBe(200)
        const completedPayload = await completedResponse.json() as Array<{ status: string; phase: string }>
        expect(completedPayload[0].status).toBe('completed')
        expect(completedPayload[0].phase).toBe('completed')
      } finally {
        await server.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires authentication to access world agents', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/world`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('returns configured machines from /machines', async () => {
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        { id: 'gpu-1', label: 'GPU', host: '10.0.1.50', user: 'ec2-user', port: 22 },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/machines`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([
        { id: 'local', label: 'Local', host: null },
        { id: 'gpu-1', label: 'GPU', host: '10.0.1.50', user: 'ec2-user', port: 22 },
      ])
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('returns empty machines list when registry file is missing', async () => {
    const registry = await createMissingMachinesRegistryPath()
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/machines`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('returns 500 for malformed machines registry', async () => {
    const registry = await createTempMachinesRegistry({})
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/machines`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: 'Invalid machines config: expected "machines" array',
      })
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('adds a machine via POST /machines and persists it to the registry', async () => {
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/machines`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'gpu-2',
          label: 'GPU 2',
          host: '10.0.1.60',
          user: 'ec2-user',
          port: 2222,
          cwd: '/srv/workspace',
        }),
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        id: 'gpu-2',
        label: 'GPU 2',
        host: '10.0.1.60',
        user: 'ec2-user',
        port: 2222,
        cwd: '/srv/workspace',
      })

      const stored = JSON.parse(await readFile(registry.filePath, 'utf8')) as { machines: unknown[] }
      expect(stored.machines).toEqual([
        { id: 'local', label: 'Local', host: null },
        {
          id: 'gpu-2',
          label: 'GPU 2',
          host: '10.0.1.60',
          user: 'ec2-user',
          port: 2222,
          cwd: '/srv/workspace',
        },
      ])
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('rejects duplicate machine IDs and invalid add payloads', async () => {
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        { id: 'gpu-1', label: 'GPU 1', host: '10.0.1.50' },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const duplicate = await fetch(`${server.baseUrl}/api/agents/machines`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'gpu-1',
          label: 'GPU 1 copy',
          host: '10.0.1.60',
        }),
      })

      expect(duplicate.status).toBe(409)
      expect(await duplicate.json()).toEqual({
        error: 'Machine "gpu-1" already exists',
      })

      const invalid = await fetch(`${server.baseUrl}/api/agents/machines`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: 'gpu-2',
          label: 'GPU 2',
          host: null,
        }),
      })

      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({
        error: 'Invalid machines config: machine "gpu-2" host must be string',
      })
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('removes remote machines and rejects removing the local machine', async () => {
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        { id: 'gpu-1', label: 'GPU 1', host: '10.0.1.50' },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const deleteRemote = await fetch(`${server.baseUrl}/api/agents/machines/gpu-1`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteRemote.status).toBe(204)

      const stored = JSON.parse(await readFile(registry.filePath, 'utf8')) as { machines: unknown[] }
      expect(stored.machines).toEqual([
        { id: 'local', label: 'Local', host: null },
      ])

      const deleteLocal = await fetch(`${server.baseUrl}/api/agents/machines/local`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteLocal.status).toBe(400)
      expect(await deleteLocal.json()).toEqual({
        error: 'Machine "local" is the local machine and cannot be removed',
      })

      const deleteMissing = await fetch(`${server.baseUrl}/api/agents/machines/missing-host`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteMissing.status).toBe(404)
      expect(await deleteMissing.json()).toEqual({
        error: 'Machine "missing-host" not found',
      })
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('returns structured health data for remote machines', async () => {
    const registry = await createTempMachinesRegistry({
      machines: [
        {
          id: 'gpu-1',
          label: 'GPU 1',
          host: '10.0.1.50',
          user: 'ec2-user',
          port: 2222,
          cwd: '/srv/workspace',
        },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      mockedSpawn.mockImplementationOnce(() => {
        const mock = createMockChildProcess()
        queueMicrotask(() => {
          mock.emitStdout([
            'ssh:ok',
            'claude:1.0.31',
            'codex:0.1.2503271400',
            'gemini:missing',
            'git:git version 2.45.1',
            'node:v22.14.0',
            '',
          ].join('\n'))
          mock.emitExit(0)
        })
        return mock.cp as never
      })

      const response = await fetch(`${server.baseUrl}/api/agents/machines/gpu-1/health`, {
        headers: AUTH_HEADERS,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        machineId: 'gpu-1',
        mode: 'ssh',
        ssh: {
          ok: true,
          destination: 'ec2-user@10.0.1.50',
        },
        tools: {
          claude: { ok: true, version: '1.0.31', raw: '1.0.31' },
          codex: { ok: true, version: '0.1.2503271400', raw: '0.1.2503271400' },
          gemini: { ok: false, version: null, raw: 'missing' },
          git: { ok: true, version: 'git version 2.45.1', raw: 'git version 2.45.1' },
          node: { ok: true, version: 'v22.14.0', raw: 'v22.14.0' },
        },
      })

      expect(mockedSpawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining([
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-p',
          '2222',
          'ec2-user@10.0.1.50',
        ]),
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      )
      const sshArgs = mockedSpawn.mock.calls[0][1]
      expect(sshArgs[sshArgs.length - 1]).toContain('exec /bin/bash -lc')
      expect(sshArgs[sshArgs.length - 1]).toContain("cd '/srv/workspace'")
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('rejects unsafe session names', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: ':0.1',
        mode: 'default',
      }),
    })

    expect(response.status).toBe(400)
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('rejects invalid host payloads on create', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-host-invalid',
        mode: 'default',
        host: { id: 'gpu-1' },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid host: expected machine ID string' })
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('rejects unknown host machine IDs on create', async () => {
    const { spawner } = createMockPtySpawner()
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        { id: 'gpu-1', label: 'GPU', host: '10.0.1.50' },
      ],
    })
    const server = await startServer({
      ptySpawner: spawner,
      machinesFilePath: registry.filePath,
    })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'agent-host-unknown',
          mode: 'default',
          host: 'missing-host',
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Unknown host machine "missing-host"',
      })
      expect(spawner.spawn).not.toHaveBeenCalled()
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('creates a remote PTY session over SSH when host is provided', async () => {
    const { spawner } = createMockPtySpawner()
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        {
          id: 'gpu-1',
          label: 'GPU',
          host: '10.0.1.50',
          user: 'ec2-user',
          port: 2222,
          cwd: '/home/ec2-user/workspace',
        },
      ],
    })
    const server = await startServer({
      ptySpawner: spawner,
      machinesFilePath: registry.filePath,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'agent-remote-pty',
          mode: 'default',
          host: 'gpu-1',
        }),
      })

      expect(createResponse.status).toBe(201)
      expect(await createResponse.json()).toEqual({
        sessionName: 'agent-remote-pty',
        mode: 'default',
        sessionType: 'pty',
        agentType: 'claude',
        host: 'gpu-1',
        created: true,
      })

      expect(spawner.spawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining(['-tt', '-p', '2222', 'ec2-user@10.0.1.50']),
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
        }),
      )

      const sshArgs = vi.mocked(spawner.spawn).mock.calls[0][1]
      expect(sshArgs[sshArgs.length - 1]).toContain("cd '/home/ec2-user/workspace'")
      expect(sshArgs[sshArgs.length - 1]).toContain('exec $SHELL -l')

      const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await sessionsResponse.json() as Array<{ name: string; host?: string }>
      expect(sessions).toHaveLength(1)
      expect(sessions[0].name).toBe('agent-remote-pty')
      expect(sessions[0].host).toBe('gpu-1')
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('returns clear error when remote PTY SSH spawn fails', async () => {
    const failingSpawner: PtySpawner = {
      spawn: vi.fn(() => {
        throw new Error('Permission denied')
      }),
    }
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'gpu-1', label: 'GPU', host: '10.0.1.50', user: 'ec2-user' },
      ],
    })
    const server = await startServer({
      ptySpawner: failingSpawner,
      machinesFilePath: registry.filePath,
    })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'agent-remote-fail',
          mode: 'default',
          host: 'gpu-1',
        }),
      })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: 'Failed to create remote PTY session: Permission denied',
      })
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('creates a PTY-backed claude session', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-create-01',
        mode: 'acceptEdits',
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      sessionName: 'agent-create-01',
      mode: 'acceptEdits',
      sessionType: 'pty',
      agentType: 'claude',
      created: true,
    })
    expect(spawner.spawn).toHaveBeenCalledWith('bash', ['-l'], expect.objectContaining({
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
    }))
    expect(lastHandle()!.write).toHaveBeenCalledWith(
      'export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 && unset CLAUDECODE && claude --effort max --permission-mode acceptEdits\r',
    )

    await server.close()
  })

  it('creates a PTY-backed claude session with the default PTY loader', async () => {
    const handle = createMockPtyHandle()
    mockedNodePtySpawn.mockReturnValue(handle)
    const server = await startServer()

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'agent-default-loader-01',
          mode: 'default',
        }),
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        sessionName: 'agent-default-loader-01',
        mode: 'default',
        sessionType: 'pty',
        agentType: 'claude',
        created: true,
      })
      expect(mockedNodePtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-l'],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
        }),
      )
      expect(handle.write).toHaveBeenCalledWith(
        'export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 && unset CLAUDECODE && claude --effort max\r',
      )
    } finally {
      await server.close()
    }
  })

  it('uses the requested Claude effort for PTY sessions', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'agent-effort-pty-01',
          mode: 'default',
          effort: 'high',
        }),
      })

      expect(response.status).toBe(201)
      expect(lastHandle()!.write).toHaveBeenCalledWith(
        'export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 && unset CLAUDECODE && claude --effort high\r',
      )
    } finally {
      await server.close()
    }
  })

  it('returns 409 when session already exists on create', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const first = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-dup',
        mode: 'default',
      }),
    })
    expect(first.status).toBe(201)

    const second = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-dup',
        mode: 'default',
      }),
    })

    expect(second.status).toBe(409)
    expect(spawner.spawn).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it('returns 400 for invalid mode on create', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-create-01',
        mode: 'plan',
      }),
    })

    expect(response.status).toBe(400)
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('requires authentication for create session', async () => {
    const server = await startServer()

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-create-01',
        mode: 'default',
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('returns 403 for create session when key lacks write scope', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...READ_ONLY_AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-create-01',
        mode: 'default',
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Insufficient API key scope',
    })
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('returns 429 when max tracked sessions limit is reached', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({
      ptySpawner: spawner,
      maxSessions: 1,
    })

    const firstResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-limit-1',
        mode: 'default',
      }),
    })
    expect(firstResponse.status).toBe(201)

    const secondResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-limit-2',
        mode: 'default',
      }),
    })

    expect(secondResponse.status).toBe(429)
    expect(spawner.spawn).toHaveBeenCalledTimes(1)

    await server.close()
  })

  it('sends initial task after session creation', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({
      ptySpawner: spawner,
      taskDelayMs: 0,
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-task-01',
        mode: 'dangerouslySkipPermissions',
        task: 'Fix the auth bug in login.ts',
      }),
    })

    expect(response.status).toBe(201)
    await vi.waitFor(() => {
      expect(lastHandle()!.write).toHaveBeenCalledTimes(2)
    })
    expect(lastHandle()!.write).toHaveBeenNthCalledWith(
      1,
      'export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 && unset CLAUDECODE && claude --effort max --dangerously-skip-permissions\r',
    )
    expect(lastHandle()!.write).toHaveBeenNthCalledWith(
      2,
      'Fix the auth bug in login.ts\r',
    )

    await server.close()
  })

  it('lists created sessions', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-list-01',
        mode: 'default',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const payload = (await response.json()) as Array<{
      name: string
      created: string
      pid: number
    }>

    expect(response.status).toBe(200)
    expect(payload).toHaveLength(1)
    expect(payload[0].name).toBe('agent-list-01')
    expect(payload[0].pid).toBe(12345)

    await server.close()
  })

  it('uses commander host as the session label', async () => {
    vi.mocked(CommanderSessionStore.prototype.list).mockResolvedValue([
      {
        id: 'cmdr-athena',
        host: 'athena',
      } as unknown as CommanderSession,
    ])

    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'commander-cmdr-athena',
        mode: 'default',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const payload = (await response.json()) as Array<{
      name: string
      label?: string
    }>

    expect(response.status).toBe(200)
    expect(payload).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'commander-cmdr-athena',
        label: 'athena',
      }),
    ]))

    await server.close()
  })

  it('exposes agent session workspace tree, file preview, and git status routes', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'hammurabi-agent-workspace-'))
    await writeFile(join(workspaceDir, 'README.md'), 'Agent workspace\n', 'utf8')

    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'commander-workspace-01',
          mode: 'default',
          cwd: workspaceDir,
        }),
      })
      expect(createResponse.status).toBe(201)

      const treeResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-workspace-01/workspace/tree`,
        { headers: AUTH_HEADERS },
      )
      expect(treeResponse.status).toBe(200)
      const treeBody = await treeResponse.json()
      expect(treeBody.nodes.map((node: { name: string }) => node.name)).toEqual(['README.md'])

      const fileResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-workspace-01/workspace/file?path=README.md`,
        { headers: AUTH_HEADERS },
      )
      expect(fileResponse.status).toBe(200)
      const fileBody = await fileResponse.json()
      expect(fileBody.kind).toBe('text')
      expect(fileBody.content).toContain('Agent workspace')

      const gitStatusResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-workspace-01/workspace/git/status`,
        { headers: AUTH_HEADERS },
      )
      expect(gitStatusResponse.status).toBe(200)
      const gitStatusBody = await gitStatusResponse.json()
      expect(gitStatusBody.enabled).toBe(false)
    } finally {
      await server.close()
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  it('kills a session', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-kill-01',
        mode: 'default',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions/agent-kill-01`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ killed: true })
    expect(lastHandle()!.kill).toHaveBeenCalled()

    await server.close()
  })

  it('returns 404 when killing a missing session', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions/nonexistent`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(404)

    await server.close()
  })

  it('requires authentication for killing sessions', async () => {
    const server = await startServer()

    const response = await fetch(`${server.baseUrl}/api/agents/sessions/alpha`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('returns 403 for kill session when key lacks write scope', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions/alpha`, {
      method: 'DELETE',
      headers: READ_ONLY_AUTH_HEADERS,
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Insufficient API key scope',
    })

    await server.close()
  })

  it('connects via WebSocket and receives PTY output', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-test',
        mode: 'default',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'ws-test')

    const received: string[] = []
    const messagePromise = new Promise<void>((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          received.push(data.toString())
        }
        if (received.length >= 1) {
          resolve()
        }
      })
    })

    lastHandle()!.emitData('hello world\r\n')

    await messagePromise
    expect(received).toContain('hello world\r\n')

    ws.close()
    await server.close()
  })

  it('sends scrollback buffer on WebSocket connect', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-scrollback',
        mode: 'default',
      }),
    })

    // Emit data before WebSocket connects
    lastHandle()!.emitData('previous output\r\n')

    // Attach message listener before open to avoid race condition with scrollback
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/ws-scrollback/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: string[] = []

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        messages.push(data.toString())
      }
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Wait for buffered scrollback message to arrive
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    expect(messages.join('')).toContain('previous output\r\n')

    ws.close()
    await server.close()
  })

  it('replays PTY scrollback after a client reconnect', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-reconnect-scrollback',
        mode: 'default',
      }),
    })

    const firstWs = await connectWs(server.baseUrl, 'ws-reconnect-scrollback')
    const firstChunks: string[] = []
    firstWs.on('message', (data, isBinary) => {
      if (isBinary) {
        firstChunks.push(data.toString())
      }
    })

    lastHandle()!.emitData('before reconnect\r\n')

    await vi.waitFor(() => {
      expect(firstChunks.join('')).toContain('before reconnect\r\n')
    })

    firstWs.close()
    await new Promise<void>((resolve) => firstWs.on('close', () => resolve()))

    // Data produced while disconnected should be included in replay on reconnect.
    lastHandle()!.emitData('after reconnect\r\n')

    const replayChunks: string[] = []
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/ws-reconnect-scrollback/terminal?api_key=test-key'
    const secondWs = new WebSocket(wsUrl)
    secondWs.on('message', (data, isBinary) => {
      if (isBinary) {
        replayChunks.push(data.toString())
      }
    })

    await new Promise<void>((resolve, reject) => {
      secondWs.on('open', () => resolve())
      secondWs.on('error', reject)
    })

    await vi.waitFor(() => {
      const replay = replayChunks.join('')
      expect(replay).toContain('before reconnect\r\n')
      expect(replay).toContain('after reconnect\r\n')
      expect(replay.split('before reconnect\r\n').length - 1).toBe(1)
      expect(replay.split('after reconnect\r\n').length - 1).toBe(1)
    })

    secondWs.close()
    await server.close()
  })

  it('writes WebSocket binary messages to PTY', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-input',
        mode: 'default',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'ws-input')

    ws.send(Buffer.from('ls -la\r'), { binary: true })

    await vi.waitFor(() => {
      // First call is the Claude command, second is our input
      expect(lastHandle()!.write).toHaveBeenCalledWith('ls -la\r')
    })

    ws.close()
    await server.close()
  })

  it('handles resize control messages via WebSocket', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-resize',
        mode: 'default',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'ws-resize')

    ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }))

    await vi.waitFor(() => {
      expect(lastHandle()!.resize).toHaveBeenCalledWith(200, 50)
    })

    ws.close()
    await server.close()
  })

  it('sends keepalive ping frames to connected sockets', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({
      ptySpawner: spawner,
      wsKeepAliveIntervalMs: 20,
    })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-keepalive-ping',
        mode: 'default',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'ws-keepalive-ping')
    let pingCount = 0
    ws.on('ping', () => {
      pingCount += 1
    })

    await vi.waitFor(() => {
      expect(pingCount).toBeGreaterThan(0)
    })

    ws.close()
    await server.close()
  })

  it('terminates stale sockets that stop responding to keepalive pings', async () => {
    const { spawner, lastHandle } = createMockPtySpawner()
    const server = await startServer({
      ptySpawner: spawner,
      wsKeepAliveIntervalMs: 20,
    })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-keepalive-stale',
        mode: 'default',
      }),
    })

    const staleWs = await connectWs(server.baseUrl, 'ws-keepalive-stale')
    staleWs.on('error', () => {
      // socket may emit ECONNRESET when server terminates stale connection
    })

    const interceptedPong = vi.fn(() => staleWs)
    Object.defineProperty(staleWs, 'pong', {
      value: interceptedPong,
      configurable: true,
    })

    let staleCloseCode: number | undefined
    staleWs.on('close', (code) => {
      staleCloseCode = code
    })

    await vi.waitFor(() => {
      expect(staleCloseCode).toBeDefined()
    })

    expect(interceptedPong).toHaveBeenCalled()
    expect([1005, 1006]).toContain(staleCloseCode)

    // Server should continue accepting healthy clients after stale cleanup.
    const healthyWs = await connectWs(server.baseUrl, 'ws-keepalive-stale')
    const messages: string[] = []
    healthyWs.on('message', (data, isBinary) => {
      if (isBinary) {
        messages.push(data.toString())
      }
    })

    lastHandle()!.emitData('recovered after stale socket\r\n')

    await vi.waitFor(() => {
      expect(messages.join('')).toContain('recovered after stale socket\r\n')
    })

    healthyWs.close()
    await server.close()
  })

  it('rejects WebSocket connection without auth', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-noauth',
        mode: 'default',
      }),
    })

    await expect(connectWs(server.baseUrl, 'ws-noauth', 'bad-key')).rejects.toThrow()

    await server.close()
  })

  it('rejects WebSocket connection for nonexistent session', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await expect(connectWs(server.baseUrl, 'nonexistent')).rejects.toThrow()

    await server.close()
  })

  it('rejects WebSocket connection when key lacks write scope', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'ws-readonly',
        mode: 'default',
      }),
    })

    await expect(connectWs(server.baseUrl, 'ws-readonly', 'read-only-key')).rejects.toThrow()

    await server.close()
  })

  it('creates session with custom cwd', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-cwd-01',
        mode: 'default',
        cwd: '/home/ec2-user/projects/my-repo',
      }),
    })

    expect(response.status).toBe(201)
    expect(spawner.spawn).toHaveBeenCalledWith('bash', ['-l'], expect.objectContaining({
      cwd: '/home/ec2-user/projects/my-repo',
    }))

    await server.close()
  })

  it('uses default cwd when cwd is omitted', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-cwd-default',
        mode: 'default',
      }),
    })

    expect(response.status).toBe(201)
    expect(spawner.spawn).toHaveBeenCalledWith('bash', ['-l'], expect.objectContaining({
      cwd: expect.any(String),
    }))

    await server.close()
  })

  it('rejects relative path for cwd', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-cwd-relative',
        mode: 'default',
        cwd: 'relative/path',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid cwd: must be an absolute path' })
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('rejects non-string cwd', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-cwd-number',
        mode: 'default',
        cwd: 42,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid cwd: must be an absolute path' })
    expect(spawner.spawn).not.toHaveBeenCalled()

    await server.close()
  })

  it('normalizes cwd with .. traversal sequences', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-cwd-traversal',
        mode: 'default',
        cwd: '/home/ec2-user/../../etc',
      }),
    })

    expect(response.status).toBe(201)
    expect(spawner.spawn).toHaveBeenCalledWith('bash', ['-l'], expect.objectContaining({
      cwd: '/etc',
    }))

    await server.close()
  })

  it('handles malformed percent-encoding in WebSocket URL without crashing', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/%E0%A4%A/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
        ws.on('unexpected-response', (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`))
        })
      }),
    ).rejects.toThrow()

    await server.close()
  })

  it('accepts WebSocket upgrade on /ws alias path (used by commander sessions)', async () => {
    // The agents router accepts both /terminal (legacy) and /ws (new commander usage).
    // Verify the /ws suffix correctly routes to the same session as /terminal.
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ws-alias-test', mode: 'default' }),
    })

    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/ws-alias-test/ws?api_key=test-key'
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out')), 3_000)
      ws.on('open', () => { clearTimeout(timeout); resolve() })
      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket upgrade rejected with status ${res.statusCode}`))
      })
    })

    ws.close()
    await server.close()
  })
})

describe('agents directories endpoint', () => {
  it('requires authentication', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/directories`)

    expect(response.status).toBe(401)
    await server.close()
  })

  it('returns directories from home when no path provided', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/directories`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { parent: string; directories: string[] }
    expect(payload.parent).toBeTruthy()
    expect(Array.isArray(payload.directories)).toBe(true)

    await server.close()
  })

  it('returns directories for a path under home', async () => {
    const { homedir } = await import('node:os')
    const home = homedir()
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/directories?path=${encodeURIComponent(home)}`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { parent: string; directories: string[] }
    expect(payload.parent).toBe(home)

    await server.close()
  })

  it('returns 403 for paths outside home directory', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/agents/directories?path=/tmp`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Path must be within the home directory' })

    await server.close()
  })

  it('returns 403 for traversal attempts escaping home', async () => {
    const server = await startServer()
    const response = await fetch(
      `${server.baseUrl}/api/agents/directories?path=${encodeURIComponent('/home/ec2-user/../../etc')}`,
      { headers: AUTH_HEADERS },
    )

    expect(response.status).toBe(403)
    await server.close()
  })

  it('returns 400 for nonexistent directory under home', async () => {
    const { homedir } = await import('node:os')
    const home = homedir()
    const server = await startServer()
    const response = await fetch(
      `${server.baseUrl}/api/agents/directories?path=${encodeURIComponent(home + '/definitely-does-not-exist-12345')}`,
      { headers: AUTH_HEADERS },
    )

    expect(response.status).toBe(400)
    await server.close()
  })
})

// ── Stream Session Tests ─────────────────────────────────────────

/**
 * Creates a mock ChildProcess-like object with controllable stdin/stdout
 * for testing stream session behavior without spawning a real process.
 */
function createMockChildProcess(onWrite?: (data: string) => void) {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stdinChunks: string[] = []
  const stdinEmitter = new EventEmitter()
  let exited = false

  const stdout = Object.assign(stdoutEmitter, {
    // Provide enough of the Readable interface for the routes code
    pipe: vi.fn(),
    on: stdoutEmitter.on.bind(stdoutEmitter),
  })

  const stdin = Object.assign(stdinEmitter, {
    writable: true,
    write: vi.fn((data: string) => {
      stdinChunks.push(data)
      onWrite?.(data)
      return true
    }),
    on: stdinEmitter.on.bind(stdinEmitter),
    once: stdinEmitter.once.bind(stdinEmitter),
  })

  const emitExit = (code: number | null, signal: string | null = null) => {
    if (exited) {
      return
    }
    exited = true
    cp.exitCode = code
    cp.signalCode = signal
    emitter.emit('exit', code, signal)
    emitter.emit('close', code, signal)
  }

  // Build a mock ChildProcess with the EventEmitter cast pattern used by routes.ts
  const cp = Object.assign(emitter, {
    pid: 99999,
    stdout,
    stdin,
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn((signal?: string) => {
      emitExit(null, typeof signal === 'string' ? signal : 'SIGTERM')
      return true
    }),
    // For stdinChunks inspection in tests
    _stdinChunks: stdinChunks,
  })

  return {
    cp,
    emitStdout(data: string) {
      stdoutEmitter.emit('data', Buffer.from(data))
    },
    emitExit(code: number, signal: string | null = null) {
      emitExit(code, signal)
    },
    emitError(err: Error) {
      emitter.emit('error', err)
    },
    getStdinWrites(): string[] {
      return stdinChunks
    },
  }
}

interface MockGeminiAcpRuntime {
  requests: Array<{ id?: number; method?: string; params?: unknown }>
  promptTexts: string[]
}

function installMockGeminiAcpRuntime(): MockGeminiAcpRuntime {
  const requests: Array<{ id?: number; method?: string; params?: unknown }> = []
  const promptTexts: string[] = []
  let sessionCounter = 0

  const buildProcess = () => createMockChildProcess((data) => {
    for (const line of data.split(/\r?\n/g)) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      const parsed = JSON.parse(trimmed) as {
        id?: number
        method?: string
        params?: unknown
      }
      requests.push(parsed)

      if (typeof parsed.id !== 'number' || typeof parsed.method !== 'string') {
        continue
      }

      switch (parsed.method) {
        case 'initialize':
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
            },
          })}\n`)
          break
        case 'session/new': {
          sessionCounter += 1
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { sessionId: `gemini-session-${sessionCounter}` },
          })}\n`)
          break
        }
        case 'session/load': {
          const params = (parsed.params && typeof parsed.params === 'object')
            ? parsed.params as { sessionId?: unknown }
            : {}
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'gemini-session-restored'
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'history should be ignored' },
              },
            },
          })}\n`)
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {},
          })}\n`)
          break
        }
        case 'session/set_mode':
          processMock.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} })}\n`)
          break
        case 'session/prompt': {
          const params = (parsed.params && typeof parsed.params === 'object')
            ? parsed.params as { sessionId?: unknown; prompt?: Array<{ text?: unknown }> }
            : {}
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'gemini-session-1'
          const text = Array.isArray(params.prompt) && typeof params.prompt[0]?.text === 'string'
            ? params.prompt[0].text
            : ''
          promptTexts.push(text)
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'pondering...' },
              },
            },
          })}\n`)
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `reply ${promptTexts.length}` },
              },
            },
          })}\n`)
          processMock.emitStdout(`${JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              stopReason: 'end_turn',
              usage: {
                inputTokens: 5,
                outputTokens: 7,
                totalTokens: 12,
              },
            },
          })}\n`)
          break
        }
        default:
          processMock.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} })}\n`)
          break
      }
    }
  })

  let processMock = buildProcess()

  mockedSpawn.mockImplementation((command, args) => {
    if (command === 'gemini' && Array.isArray(args) && args[0] === '--acp') {
      processMock = buildProcess()
      return processMock.cp as never
    }

    if (command === 'ssh' && Array.isArray(args)) {
      const remoteCommand = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : ''
      if (remoteCommand.includes('gemini') && remoteCommand.includes('--acp')) {
        processMock = buildProcess()
        return processMock.cp as never
      }
    }

    return createMockChildProcess().cp as never
  })

  return {
    requests,
    promptTexts,
  }
}

type CodexTurnStartBehavior = 'success' | 'error'

interface MockCodexSidecar {
  closeConnection(code?: number, reason?: string): Promise<void>
  closeConnectionForThread(threadId: string, code?: number, reason?: string): Promise<void>
  closeServer(): Promise<void>
  emitProcessError(error: Error): void
  emitProcessErrorForThread(threadId: string, error: Error): void
  emitProcessExit(code?: number, signal?: string | null): void
  emitProcessExitForThread(threadId: string, code?: number, signal?: string | null): void
  emitNotification(method: string, params: Record<string, unknown>): void
  emitStderr(data: string): void
  getProcessKillCallCount(threadId: string): number
  getRequests(method?: string): Array<{ id?: number; method?: string; params?: unknown }>
  getRuntimeSpawnCount(): number
  getStartedThreadIds(): string[]
  setThreadReadResult(result: unknown): void
  setThreadReadError(message: string | null): void
  setTurnStartBehavior(behavior: CodexTurnStartBehavior): void
  suppressPongResponses(): void
}

interface MockCodexRuntime {
  id: number
  transport: 'ws' | 'stdio'
  processMock: ReturnType<typeof createMockChildProcess>
  server: WebSocketServer | null
  socket: WebSocket | null
  turnStartBehavior: CodexTurnStartBehavior
  threadReadResult: unknown
  threadReadError: string | null
}

function installMockCodexSidecar(): MockCodexSidecar {
  const requests: Array<{ id?: number; method?: string; params?: unknown }> = []
  const runtimes = new Map<number, MockCodexRuntime>()
  const threadToRuntime = new Map<string, MockCodexRuntime>()
  const startedThreadIds: string[] = []
  let runtimeCounter = 0
  let threadCounter = 0
  let defaultTurnStartBehavior: CodexTurnStartBehavior = 'success'
  let defaultThreadReadResult: unknown = { thread: { id: 'thread-1', turns: [] } }
  let defaultThreadReadError: string | null = null
  let hasCustomThreadReadResult = false

  const firstRuntime = (): MockCodexRuntime | null => {
    for (const runtime of runtimes.values()) {
      return runtime
    }
    return null
  }

  const runtimeForThread = (threadId: string): MockCodexRuntime => {
    const runtime = threadToRuntime.get(threadId)
    if (!runtime) {
      throw new Error(`No Codex runtime registered for thread ${threadId}`)
    }
    return runtime
  }

  const resolveRuntime = (threadId?: string): MockCodexRuntime => {
    if (threadId) {
      return runtimeForThread(threadId)
    }
    const runtime = firstRuntime()
    if (!runtime) {
      throw new Error('No active Codex runtimes')
    }
    return runtime
  }

  const runtimeSocket = (runtime: MockCodexRuntime): WebSocket => {
    if (!runtime.socket) {
      throw new Error(`Codex runtime ${runtime.id} socket not connected`)
    }
    return runtime.socket
  }

  const sendRuntimeMessage = (runtime: MockCodexRuntime, payload: Record<string, unknown>) => {
    const encoded = JSON.stringify(payload)
    if (runtime.transport === 'stdio') {
      runtime.processMock.emitStdout(`${encoded}\n`)
      return
    }
    runtimeSocket(runtime).send(encoded)
  }

  const handleRequest = (
    runtime: MockCodexRuntime,
    parsed: { id?: number; method?: string; params?: unknown },
  ) => {
    requests.push(parsed)

    if (parsed.id === undefined) {
      return
    }

    switch (parsed.method) {
      case 'initialize':
        sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: {} })
        break
      case 'thread/start': {
        threadCounter += 1
        const threadId = `thread-${threadCounter}`
        startedThreadIds.push(threadId)
        threadToRuntime.set(threadId, runtime)
        if (!hasCustomThreadReadResult) {
          runtime.threadReadResult = { thread: { id: threadId, turns: [] } }
        }
        sendRuntimeMessage(runtime, {
          jsonrpc: '2.0',
          id: parsed.id,
          result: { thread: { id: threadId } },
        })
        break
      }
      case 'thread/resume': {
        const params = (parsed.params ?? {}) as { threadId?: unknown }
        if (typeof params.threadId === 'string' && params.threadId.length > 0) {
          if (!startedThreadIds.includes(params.threadId)) {
            startedThreadIds.push(params.threadId)
          }
          threadToRuntime.set(params.threadId, runtime)
        }
        sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: {} })
        break
      }
      case 'thread/archive':
        sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: {} })
        break
      case 'thread/read':
        if (runtime.threadReadError) {
          sendRuntimeMessage(runtime, {
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32001, message: runtime.threadReadError },
          })
        } else {
          sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: runtime.threadReadResult })
        }
        break
      case 'turn/start':
        if (runtime.turnStartBehavior === 'error') {
          sendRuntimeMessage(runtime, {
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32000, message: 'Injected turn/start failure' },
          })
        } else {
          sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: { accepted: true } })
        }
        break
      default:
        sendRuntimeMessage(runtime, { jsonrpc: '2.0', id: parsed.id, result: {} })
        break
    }
  }

  mockedSpawn.mockImplementation((command, args) => {
    if (command === 'ssh' && Array.isArray(args)) {
      const remoteCommand = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : ''
      if (remoteCommand.includes('codex') && remoteCommand.includes('app-server') && remoteCommand.includes('stdio://')) {
        const processMock = createMockChildProcess((data) => {
          for (const line of data.split(/\r?\n/g)) {
            const trimmed = line.trim()
            if (!trimmed) {
              continue
            }
            const parsed = JSON.parse(trimmed) as { id?: number; method?: string; params?: unknown }
            handleRequest(runtime, parsed)
          }
        })
        const runtimeId = ++runtimeCounter
        const runtime: MockCodexRuntime = {
          id: runtimeId,
          transport: 'stdio',
          processMock,
          server: null,
          socket: null,
          turnStartBehavior: defaultTurnStartBehavior,
          threadReadResult: defaultThreadReadResult,
          threadReadError: defaultThreadReadError,
        }
        runtimes.set(runtimeId, runtime)
        return processMock.cp as never
      }
    }

    if (command !== 'codex' || !Array.isArray(args)) {
      return createMockChildProcess().cp as never
    }

    const listenIndex = args.indexOf('--listen')
    if (listenIndex === -1 || typeof args[listenIndex + 1] !== 'string') {
      throw new Error('Missing --listen URL for mocked Codex sidecar')
    }

    const listenUrl = new URL(args[listenIndex + 1])
    const processMock = createMockChildProcess()
    const runtimeId = ++runtimeCounter
    const server = new WebSocketServer({
      host: listenUrl.hostname,
      port: Number(listenUrl.port),
    })
    const runtime: MockCodexRuntime = {
      id: runtimeId,
      transport: 'ws',
      processMock,
      server,
      socket: null,
      turnStartBehavior: defaultTurnStartBehavior,
      threadReadResult: defaultThreadReadResult,
      threadReadError: defaultThreadReadError,
    }
    runtimes.set(runtimeId, runtime)

    server.on('connection', (client) => {
      runtime.socket = client as unknown as WebSocket
      client.on('close', () => {
        if (runtime.socket === (client as unknown as WebSocket)) {
          runtime.socket = null
        }
      })
      client.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { id?: number; method?: string; params?: unknown }
        handleRequest(runtime, parsed)
      })
    })

    return processMock.cp as never
  })

  return {
    async closeConnection(code = 1011, reason = 'Injected transport failure') {
      const runtime = resolveRuntime()
      const socket = runtimeSocket(runtime)
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close(code, reason)
      })
    },
    async closeConnectionForThread(threadId, code = 1011, reason = 'Injected transport failure') {
      const runtime = resolveRuntime(threadId)
      const socket = runtimeSocket(runtime)
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.close(code, reason)
      })
    },
    async closeServer() {
      const closeJobs = [...runtimes.values()].map(async (runtime) => {
        if (!runtime.server) {
          runtime.processMock.emitExit(0, null)
          return
        }
        for (const client of runtime.server.clients) {
          client.terminate()
        }
        await new Promise<void>((resolve, reject) => {
          runtime.server!.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
        runtime.socket = null
      })
      await Promise.all(closeJobs)
      runtimes.clear()
      threadToRuntime.clear()
    },
    emitProcessError(error: Error) {
      const runtime = resolveRuntime()
      runtime.processMock.emitError(error)
    },
    emitProcessErrorForThread(threadId: string, error: Error) {
      const runtime = resolveRuntime(threadId)
      runtime.processMock.emitError(error)
    },
    emitProcessExit(code = 1, signal: string | null = null) {
      const runtime = resolveRuntime()
      runtime.processMock.emitExit(code, signal)
    },
    emitProcessExitForThread(threadId: string, code = 1, signal: string | null = null) {
      const runtime = resolveRuntime(threadId)
      runtime.processMock.emitExit(code, signal)
    },
    emitNotification(method, params) {
      const runtime = resolveRuntime(typeof params.threadId === 'string' ? params.threadId : undefined)
      sendRuntimeMessage(runtime, {
        jsonrpc: '2.0',
        method,
        params,
      })
    },
    emitStderr(data) {
      const runtime = resolveRuntime()
      runtime.processMock.cp.stderr.emit('data', Buffer.from(data))
    },
    getProcessKillCallCount(threadId) {
      const runtime = resolveRuntime(threadId)
      const kill = runtime.processMock.cp.kill as unknown as { mock?: { calls: unknown[][] } }
      return kill.mock?.calls.length ?? 0
    },
    getRequests(method) {
      return method ? requests.filter((request) => request.method === method) : [...requests]
    },
    getRuntimeSpawnCount() {
      return runtimes.size
    },
    getStartedThreadIds() {
      return [...startedThreadIds]
    },
    setThreadReadResult(result) {
      defaultThreadReadResult = result
      defaultThreadReadError = null
      hasCustomThreadReadResult = true
      for (const runtime of runtimes.values()) {
        runtime.threadReadResult = result
        runtime.threadReadError = null
      }
    },
    setThreadReadError(message) {
      defaultThreadReadError = message
      for (const runtime of runtimes.values()) {
        runtime.threadReadError = message
      }
    },
    setTurnStartBehavior(behavior) {
      defaultTurnStartBehavior = behavior
      for (const runtime of runtimes.values()) {
        runtime.turnStartBehavior = behavior
      }
    },
    suppressPongResponses() {
      const runtime = resolveRuntime()
      const socket = runtimeSocket(runtime)
      const interceptedPong = vi.fn(() => socket)
      Object.defineProperty(socket, 'pong', {
        value: interceptedPong,
        configurable: true,
      })
    },
  }
}

describe('stream sessions', () => {
  function installMockProcess() {
    const mock = createMockChildProcess()
    mockedSpawn.mockReturnValue(mock.cp as never)
    return mock
  }

  afterEach(() => {
    mockedSpawn.mockRestore()
  })

  it('creates a stream session via POST /sessions with sessionType=stream', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-01',
        mode: 'default',
        sessionType: 'stream',
        task: 'Fix the auth bug',
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toEqual({
      sessionName: 'stream-01',
      mode: 'default',
      sessionType: 'stream',
      agentType: 'claude',
      created: true,
    })

    // Verify spawn was called with correct args
    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--effort', 'max'],
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
          CLAUDECODE: undefined,
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    )

    // Verify initial task was written to stdin
    expect(mock.getStdinWrites().length).toBeGreaterThan(0)
    const firstWrite = mock.getStdinWrites()[0]
    const parsed = JSON.parse(firstWrite.replace('\n', ''))
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Fix the auth bug' },
    })

    await server.close()
  })

  it('uses the requested Claude effort for stream sessions and exposes it in the session list', async () => {
    installMockProcess()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-effort-01',
          mode: 'default',
          sessionType: 'stream',
          effort: 'medium',
        }),
      })

      expect(createResponse.status).toBe(201)
      expect(mockedSpawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--effort', 'medium'],
        expect.any(Object),
      )

      const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(listResponse.status).toBe(200)
      const sessions = await listResponse.json() as Array<{ name: string; effort?: string }>
      expect(sessions.find((session) => session.name === 'stream-effort-01')?.effort).toBe('medium')
    } finally {
      await server.close()
    }
  })

  it('appends commander stream events to JSONL transcript', async () => {
    const mock = installMockProcess()
    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-commander-jsonl-'))
    setTranscriptStoreRoot(join(workDir, 'data', 'agents', 'sessions'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir)
    let server: RunningServer | null = null

    try {
      server = await startServer()

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'commander-alpha',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      const initEvent = { type: 'system', subtype: 'init', session_id: 'claude-commander-123' }
      const deltaEvent = {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 3, output_tokens: 1 },
      }

      mock.emitStdout(`${JSON.stringify(initEvent)}\n`)
      mock.emitStdout(`${JSON.stringify(deltaEvent)}\n`)

      const transcriptPath = join(
        workDir,
        'data',
        'commanders',
        'alpha',
        'sessions',
        'claude-commander-123.jsonl',
      )
      const sharedTranscriptPath = join(
        workDir,
        'data',
        'agents',
        'sessions',
        'commander-alpha',
        'transcript.v1.jsonl',
      )
      const metaPath = join(
        workDir,
        'data',
        'agents',
        'sessions',
        'commander-alpha',
        'meta.json',
      )

      await vi.waitFor(async () => {
        const raw = await readFile(transcriptPath, 'utf8')
        const events = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(events).toHaveLength(2)
        expect(events[0]).toEqual(initEvent)
        expect(events[1]).toEqual(deltaEvent)

        const sharedRaw = await readFile(sharedTranscriptPath, 'utf8')
        const sharedEvents = sharedRaw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(sharedEvents).toEqual(events)

        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
          agentType?: string
          claudeSessionId?: string
        }
        expect(meta.agentType).toBe('claude')
        expect(meta.claudeSessionId).toBe('claude-commander-123')
      })
    } finally {
      if (server) {
        await server.close()
      }
      cwdSpy.mockRestore()
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('writes Claude stream events to the shared transcript store without dropping persisted replay events', async () => {
    const mock = installMockProcess()
    const transcriptRoot = await mkdtemp(join(tmpdir(), 'hammurabi-stream-transcript-'))
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    setTranscriptStoreRoot(transcriptRoot)

    let server: RunningServer | null = null

    try {
      server = await startServer({ sessionStorePath })

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-transcript-01',
          mode: 'default',
          sessionType: 'stream',
          cwd: '/home/ec2-user/projects/transcript-demo',
        }),
      })
      expect(createResponse.status).toBe(201)

      const initEvent = { type: 'system', subtype: 'init', session_id: 'claude-stream-123' }
      const messageStartEvent = { type: 'message_start' }
      const resultEvent = { type: 'result', subtype: 'success', result: 'done' }

      mock.emitStdout(`${JSON.stringify(initEvent)}\n`)
      mock.emitStdout(`${JSON.stringify(messageStartEvent)}\n`)
      mock.emitStdout(`${JSON.stringify(resultEvent)}\n`)

      const transcriptPath = join(transcriptRoot, 'stream-transcript-01', 'transcript.v1.jsonl')
      const metaPath = join(transcriptRoot, 'stream-transcript-01', 'meta.json')

      await vi.waitFor(async () => {
        const raw = await readFile(transcriptPath, 'utf8')
        const events = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)

        expect(events).toEqual([initEvent, messageStartEvent, resultEvent])

        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
          agentType?: string
          cwd?: string
          claudeSessionId?: string
        }
        expect(meta).toEqual(expect.objectContaining({
          agentType: 'claude',
          cwd: '/home/ec2-user/projects/transcript-demo',
          claudeSessionId: 'claude-stream-123',
        }))

        const persisted = JSON.parse(await readFile(sessionStorePath, 'utf8')) as {
          sessions: Array<{ name: string; events?: unknown[] }>
        }
        expect(persisted.sessions.find((session) => session.name === 'stream-transcript-01')?.events).toEqual([
          initEvent,
          messageStartEvent,
          resultEvent,
        ])
      })
    } finally {
      if (server) {
        await server.close()
      }
      await rm(transcriptRoot, { recursive: true, force: true })
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('reports command-room stream sessions as completed after result without waiting for exit', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'command-room-task-01',
        mode: 'default',
        sessionType: 'stream',
        task: '/daily-review',
      }),
    })
    expect(createResponse.status).toBe(201)

    mock.emitStdout('{"type":"result","subtype":"success","result":"Daily review complete.","total_cost_usd":0.12}\n')

    await vi.waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions/command-room-task-01`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        completed: boolean
        status: string
        result?: { status: string; finalComment: string; costUsd: number }
      }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
      expect(payload.result).toMatchObject({
        status: 'success',
        finalComment: 'Daily review complete.',
        costUsd: 0.12,
      })
    })

    const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    expect(listResponse.status).toBe(200)
    const listed = await listResponse.json() as Array<{ name: string }>
    expect(listed.some((session) => session.name === 'command-room-task-01')).toBe(false)

    expect(mock.cp.kill).not.toHaveBeenCalled()

    await server.close()
  })

  it('reports command-room stream sessions as completed on exit without result (cron fix)', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'command-room-task-exit-no-result',
        mode: 'default',
        sessionType: 'stream',
        task: 'test',
      }),
    })
    expect(createResponse.status).toBe(201)

    // Exit without emitting result — e.g. AskUserQuestion block, crash, or Codex format.
    mock.emitExit(0)

    await vi.waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions/command-room-task-exit-no-result`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        completed: boolean
        status: string
        result?: { status: string; finalComment: string; costUsd: number }
      }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
      expect(payload.result?.finalComment).toContain('Process exited with code 0')
    })

    await server.close()
  })

  it('never persists command-room sessions for auto-resume', async () => {
    const mock = installMockProcess()
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const server = await startServer({ sessionStorePath })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'command-room-task-02',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      mock.emitStdout('{"type":"system","subtype":"init","session_id":"claude-command-room-123"}\n')

      mock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'command-room-task-02')
        expect(saved).toBeUndefined()
      })
    } finally {
      await server.close()
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('creates a new Claude stream session from a previous resumable session', async () => {
    const firstMock = createMockChildProcess()
    const secondMock = createMockChildProcess()
    mockedSpawn
      .mockImplementationOnce(() => firstMock.cp as never)
      .mockImplementationOnce(() => secondMock.cp as never)

    const server = await startServer()

    try {
      const createSourceResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'claude-source',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'claude',
        }),
      })
      expect(createSourceResponse.status).toBe(201)

      firstMock.emitStdout('{"type":"system","subtype":"init","session_id":"claude-source-session-id"}\n')
      firstMock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')
      firstMock.emitExit(0)

      await vi.waitFor(async () => {
        const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionsResponse.status).toBe(200)
        const listedSessions = await sessionsResponse.json() as Array<{
          name: string
          processAlive?: boolean
          resumeAvailable?: boolean
        }>
        const source = listedSessions.find((session) => session.name === 'claude-source')
        expect(source?.processAlive).toBe(false)
        expect(source?.resumeAvailable).toBe(true)
      })

      const createResumedResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'claude-resumed-custom',
          mode: 'acceptEdits',
          sessionType: 'stream',
          resumeFromSession: 'claude-source',
          task: 'Continue from the previous context',
        }),
      })
      expect(createResumedResponse.status).toBe(201)

      const resumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-source-session-id') &&
          args.includes('--permission-mode') &&
          args.includes('acceptEdits')
        )
      })
      expect(resumeCall).toBeDefined()
      expect(secondMock.getStdinWrites()).toContain(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Continue from the previous context' } })}\n`,
      )

      const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionsResponse.status).toBe(200)
      const listedSessions = await sessionsResponse.json() as Array<{
        name: string
        processAlive?: boolean
        resumedFrom?: string
      }>
      const resumed = listedSessions.find((session) => session.name === 'claude-resumed-custom')
      expect(resumed?.processAlive).toBe(true)
      expect(resumed?.resumedFrom).toBe('claude-source')
    } finally {
      await server.close()
    }
  })

  it('keeps manually deleted Claude stream sessions available in the resume picker', async () => {
    const firstMock = createMockChildProcess()
    const secondMock = createMockChildProcess()
    mockedSpawn
      .mockImplementationOnce(() => firstMock.cp as never)
      .mockImplementationOnce(() => secondMock.cp as never)

    const server = await startServer()

    try {
      const createSourceResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'claude-killed-source',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'claude',
        }),
      })
      expect(createSourceResponse.status).toBe(201)

      firstMock.emitStdout('{"type":"system","subtype":"init","session_id":"claude-killed-source-session-id"}\n')
      firstMock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/claude-killed-source`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)
      expect(await deleteResponse.json()).toEqual({ killed: true })

      await vi.waitFor(async () => {
        const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionsResponse.status).toBe(200)
        const listedSessions = await sessionsResponse.json() as Array<{
          name: string
          processAlive?: boolean
          status?: string
          resumeAvailable?: boolean
        }>
        const source = listedSessions.find((session) => session.name === 'claude-killed-source')
        expect(source).toEqual(expect.objectContaining({
          name: 'claude-killed-source',
          processAlive: false,
          status: 'exited',
          resumeAvailable: true,
        }))
      })

      const createResumedResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'claude-killed-resumed',
          mode: 'acceptEdits',
          sessionType: 'stream',
          resumeFromSession: 'claude-killed-source',
          task: 'Continue after manual stop',
        }),
      })
      expect(createResumedResponse.status).toBe(201)

      const resumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-killed-source-session-id')
        )
      })
      expect(resumeCall).toBeDefined()
      expect(secondMock.getStdinWrites()).toContain(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Continue after manual stop' } })}\n`,
      )
    } finally {
      await server.close()
    }
  })

  it('auto-resumes persisted claude stream sessions on server restart', async () => {
    const firstMock = installMockProcess()
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    let firstServer: RunningServer | null = null
    let secondServer: RunningServer | null = null

    try {
      firstServer = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      const createResponse = await fetch(`${firstServer.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-resume-01',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      firstMock.emitStdout(
        '{"type":"system","subtype":"init","session_id":"claude-resume-123"}\n',
      )

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; claudeSessionId?: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'stream-resume-01')
        expect(saved?.claudeSessionId).toBe('claude-resume-123')
      })

      await firstServer.close()
      firstServer = null

      mockedSpawn.mockClear()
      installMockProcess()

      secondServer = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      await vi.waitFor(async () => {
        const response = await fetch(`${secondServer.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(response.status).toBe(200)
        const sessions = await response.json() as Array<{ name: string }>
        expect(sessions.some((session) => session.name === 'stream-resume-01')).toBe(true)
      })

      const resumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-resume-123')
        )
      })
      expect(resumeCall).toBeDefined()
    } finally {
      if (secondServer) {
        await secondServer.close()
      }
      if (firstServer) {
        await firstServer.close()
      }
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('restores startup replay from transcript tail before persisted fallback events', async () => {
    installMockProcess()
    const transcriptRoot = await mkdtemp(join(tmpdir(), 'hammurabi-transcript-restore-'))
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const sessionName = 'stream-transcript-tail-restore'
    const createdAt = '2026-04-08T00:00:00.000Z'
    const expectedReplayEvents: Array<Record<string, unknown>> = []
    let server: RunningServer | null = null

    setTranscriptStoreRoot(transcriptRoot)

    try {
      await writeFile(
        sessionStorePath,
        JSON.stringify({
          sessions: [
            {
              name: sessionName,
              agentType: 'claude',
              mode: 'default',
              cwd: '/home/ec2-user/projects/transcript-restore',
              createdAt,
              claudeSessionId: 'claude-stale-from-store',
              events: [{ type: 'system', marker: 'persisted-fallback-only' }],
            },
          ],
        }),
        'utf8',
      )

      await writeSessionMeta(sessionName, {
        agentType: 'claude',
        cwd: '/home/ec2-user/projects/transcript-restore',
        createdAt,
        claudeSessionId: 'claude-transcript-123',
      })

      for (let turn = 1; turn <= 22; turn += 1) {
        const turnId = String(turn).padStart(2, '0')
        const userEvent = { type: 'user', marker: `turn-${turnId}-user` }
        const resultEvent = turn === 22
          ? {
              type: 'result',
              marker: `turn-${turnId}-result`,
              usage: { input_tokens: 222, output_tokens: 111 },
              total_cost_usd: 0.12,
            }
          : { type: 'result', marker: `turn-${turnId}-result` }
        await appendTranscriptEvent(sessionName, userEvent)
        await appendTranscriptEvent(sessionName, resultEvent)
        if (turn > 2) {
          expectedReplayEvents.push(userEvent, resultEvent)
        }
      }

      const partialAssistant = { type: 'assistant', marker: 'partial-assistant' }
      const partialAsk = {
        type: 'tool_use',
        id: 'ask-1',
        name: 'AskUserQuestion',
        marker: 'partial-ask',
      }
      await appendTranscriptEvent(sessionName, partialAssistant)
      await appendTranscriptEvent(sessionName, partialAsk)
      expectedReplayEvents.push(partialAssistant, partialAsk)

      server = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      await vi.waitFor(async () => {
        const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(response.status).toBe(200)
        const sessions = await response.json() as Array<{ name: string }>
        expect(sessions.some((session) => session.name === sessionName)).toBe(true)
      })

      const { ws, replay } = await connectWsWithReplay(server.baseUrl, sessionName)
      expect(replay.events).toEqual(expectedReplayEvents)
      expect(replay.events).not.toContainEqual({ type: 'system', marker: 'persisted-fallback-only' })
      expect(replay.usage).toEqual({
        inputTokens: 222,
        outputTokens: 111,
        costUsd: 0.12,
      })

      const transcriptResumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-transcript-123')
        )
      })
      expect(transcriptResumeCall).toBeDefined()
      expect(mockedSpawn.mock.calls.some(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--resume') &&
          args.includes('claude-stale-from-store')
        )
      })).toBe(false)

      ws.close()
    } finally {
      if (server) {
        await server.close()
      }
      await rm(transcriptRoot, { recursive: true, force: true })
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('falls back to persisted replay events on startup when transcript tail is unavailable', async () => {
    installMockProcess()
    const transcriptRoot = await mkdtemp(join(tmpdir(), 'hammurabi-transcript-fallback-'))
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const sessionName = 'stream-persisted-fallback-restore'
    const persistedEvents: Array<Record<string, unknown>> = [
      {
        type: 'message_delta',
        delta: { type: 'text_delta', text: 'persisted-only' },
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        type: 'result',
        marker: 'persisted-result',
        usage: { input_tokens: 120, output_tokens: 60 },
        total_cost_usd: 0.09,
      },
    ]
    let server: RunningServer | null = null

    setTranscriptStoreRoot(transcriptRoot)

    try {
      await writeFile(
        sessionStorePath,
        JSON.stringify({
          sessions: [
            {
              name: sessionName,
              agentType: 'claude',
              mode: 'default',
              cwd: '/home/ec2-user/projects/persisted-fallback',
              createdAt: '2026-04-08T00:00:00.000Z',
              claudeSessionId: 'claude-fallback-123',
              events: persistedEvents,
            },
          ],
        }),
        'utf8',
      )

      server = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      await vi.waitFor(async () => {
        const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(response.status).toBe(200)
        const sessions = await response.json() as Array<{ name: string }>
        expect(sessions.some((session) => session.name === sessionName)).toBe(true)
      })

      const { ws, replay } = await connectWsWithReplay(server.baseUrl, sessionName)
      expect(replay.events).toEqual(persistedEvents)
      expect(replay.usage).toEqual({
        inputTokens: 120,
        outputTokens: 60,
        costUsd: 0.09,
      })

      const fallbackResumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-fallback-123')
        )
      })
      expect(fallbackResumeCall).toBeDefined()

      ws.close()
    } finally {
      if (server) {
        await server.close()
      }
      await rm(transcriptRoot, { recursive: true, force: true })
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('does not auto-resume interrupted claude stream sessions on server restart', async () => {
    const firstMock = installMockProcess()
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    let firstServer: RunningServer | null = null
    let secondServer: RunningServer | null = null

    try {
      firstServer = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      const createResponse = await fetch(`${firstServer.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-interrupted-01',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      firstMock.emitStdout(
        '{"type":"system","subtype":"init","session_id":"claude-interrupted-123"}\n',
      )

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; claudeSessionId?: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'stream-interrupted-01')
        expect(saved?.claudeSessionId).toBe('claude-interrupted-123')
      })

      // Simulate a server restart while Claude is still mid-assistant turn.
      firstMock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; claudeSessionId?: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'stream-interrupted-01')
        expect(saved).toBeUndefined()
      })

      await firstServer.close()
      firstServer = null

      mockedSpawn.mockClear()
      installMockProcess()

      secondServer = await startServer({
        autoResumeSessions: true,
        sessionStorePath,
      })

      const resumeCall = mockedSpawn.mock.calls.find(([command, args]) => {
        return (
          command === 'claude' &&
          Array.isArray(args) &&
          args.includes('--effort') &&
          args.includes('max') &&
          args.includes('--resume') &&
          args.includes('claude-interrupted-123')
        )
      })
      expect(resumeCall).toBeUndefined()

      const response = await fetch(`${secondServer.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)
      const sessions = await response.json() as Array<{ name: string }>
      expect(sessions.some((session) => session.name === 'stream-interrupted-01')).toBe(false)
    } finally {
      if (secondServer) {
        await secondServer.close()
      }
      if (firstServer) {
        await firstServer.close()
      }
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('creates a remote stream session over SSH when host is provided', async () => {
    installMockProcess()
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'local', label: 'Local', host: null },
        {
          id: 'gpu-1',
          label: 'GPU',
          host: '10.0.1.50',
          user: 'ec2-user',
          port: 22,
          cwd: '/home/ec2-user/workspace',
        },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-remote-01',
          mode: 'default',
          sessionType: 'stream',
          host: 'gpu-1',
        }),
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        sessionName: 'stream-remote-01',
        mode: 'default',
        sessionType: 'stream',
        agentType: 'claude',
        host: 'gpu-1',
        created: true,
      })

      expect(mockedSpawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining(['-p', '22', 'ec2-user@10.0.1.50']),
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
            CLAUDECODE: undefined,
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )
      const sshArgs = mockedSpawn.mock.calls[0][1]
      expect(sshArgs[sshArgs.length - 1]).toContain("cd '/home/ec2-user/workspace'")
      expect(sshArgs[sshArgs.length - 1]).toContain('$SHELL -lic')
      expect(sshArgs[sshArgs.length - 1]).toContain('export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1')
      expect(sshArgs[sshArgs.length - 1]).toContain('unset CLAUDECODE')
      expect(sshArgs[sshArgs.length - 1]).toContain('claude')
      expect(sshArgs[sshArgs.length - 1]).toContain('--effort')
      expect(sshArgs[sshArgs.length - 1]).toContain('max')
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('creates remote codex stream sessions over ssh', async () => {
    const sidecar = installMockCodexSidecar()
    const registry = await createTempMachinesRegistry({
      machines: [
        { id: 'gpu-1', label: 'GPU', host: '10.0.1.50', user: 'ec2-user' },
      ],
    })
    const server = await startServer({ machinesFilePath: registry.filePath })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-remote-codex',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
          host: 'gpu-1',
          task: 'Run remotely',
        }),
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({
        sessionName: 'stream-remote-codex',
        mode: 'default',
        sessionType: 'stream',
        agentType: 'codex',
        host: 'gpu-1',
        created: true,
      })

      expect(mockedSpawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining(['ec2-user@10.0.1.50']),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )
      const sshArgs = mockedSpawn.mock.calls[0][1]
      expect(sshArgs[sshArgs.length - 1]).toContain('codex')
      expect(sshArgs[sshArgs.length - 1]).toContain('app-server')
      expect(sshArgs[sshArgs.length - 1]).toContain('stdio://')
      expect(sidecar.getRequests('thread/start')).toHaveLength(1)
      expect(sidecar.getRequests('turn/start')).toHaveLength(1)
    } finally {
      await sidecar.closeServer()
      await server.close()
      await registry.cleanup()
    }
  })

  it('bootstraps Codex commander sessions with developer instructions and readiness as first turn', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const systemPrompt = 'You are the Codex commander seed prompt.'
      await server.agents.sessionsInterface.createCommanderSession({
        name: 'commander-codex-bootstrap',
        systemPrompt,
        agentType: 'codex',
      })

      const threadRequests = sidecar.getRequests('thread/start')
      expect(threadRequests).toHaveLength(1)
      expect(threadRequests[0].params).toEqual(expect.objectContaining({
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        developerInstructions: systemPrompt,
      }))

      expect(sidecar.getRequests('turn/start')).toHaveLength(0)

      const sent = await server.agents.sessionsInterface.sendToSession(
        'commander-codex-bootstrap',
        'Commander runtime started. Acknowledge readiness and await instructions.',
      )
      expect(sent).toBe(true)

      const turnRequests = sidecar.getRequests('turn/start')
      expect(turnRequests).toHaveLength(1)
      expect(turnRequests[0].params).toEqual({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Commander runtime started. Acknowledge readiness and await instructions.' }],
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('makes Codex commander sessions visible to Agents Monitor without the old sidecar stall', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const startedAt = Date.now()
      await server.agents.sessionsInterface.createCommanderSession({
        name: 'commander-codex-visible',
        systemPrompt: 'You are a Codex commander.',
        agentType: 'codex',
      })
      const elapsedMs = Date.now() - startedAt

      expect(elapsedMs).toBeLessThan(1200)

      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)

      const sessions = await response.json() as Array<{
        name: string
        sessionType?: string
        agentType?: string
        processAlive?: boolean
      }>
      expect(sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'commander-codex-visible',
          sessionType: 'stream',
          agentType: 'codex',
          processAlive: true,
        }),
      ]))
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('keeps Codex stream session task bootstrap as first user turn', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const initialTask = 'Summarize open pull requests.'
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-task-bootstrap',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
          task: initialTask,
        }),
      })
      expect(createResponse.status).toBe(201)

      const threadRequests = sidecar.getRequests('thread/start')
      expect(threadRequests).toHaveLength(1)
      const threadStartParams = threadRequests[0].params as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(threadStartParams, 'developerInstructions')).toBe(false)

      const turnRequests = sidecar.getRequests('turn/start')
      expect(turnRequests).toHaveLength(1)
      expect(turnRequests[0].params).toEqual({
        threadId: 'thread-1',
        input: [{ type: 'text', text: initialTask }],
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('tears down the Codex runtime when initial task bootstrap fails during session creation', async () => {
    const sidecar = installMockCodexSidecar()
    sidecar.setTurnStartBehavior('error')
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-bootstrap-failure',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
          task: 'bootstrap me',
        }),
      })

      expect(createResponse.status).toBe(500)
      expect(await createResponse.json()).toEqual({
        error: expect.stringContaining('Injected turn/start failure'),
      })

      await vi.waitFor(() => {
        expect(sidecar.getStartedThreadIds()).toEqual(['thread-1'])
        expect(sidecar.getProcessKillCallCount('thread-1')).toBeGreaterThan(0)
      })

      const archiveRequests = sidecar.getRequests('thread/archive').filter((request) => {
        const params = (request.params ?? {}) as { threadId?: unknown }
        return params.threadId === 'thread-1'
      })
      expect(archiveRequests.length).toBeGreaterThan(0)

      const sessionResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-bootstrap-failure`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionResponse.status).toBe(404)
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('delivers REST send requests to Codex sessions through the sidecar transport', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-rest-send',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-rest-send')
      const received: Array<{ type: string; message?: { content?: string } }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; message?: { content?: string } }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-rest-send/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })

      expect(sendResponse.status).toBe(200)
      expect(await sendResponse.json()).toEqual({ sent: true })

      await vi.waitFor(() => {
        const userEvent = received.find((event) => event.type === 'user')
        expect(userEvent).toBeDefined()
        expect(userEvent?.message?.content).toBe('status?')
      })

      const turnRequests = sidecar.getRequests('turn/start')
      expect(turnRequests).toHaveLength(1)
      expect(turnRequests[0].params).toEqual({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'status?' }],
      })

      const sessionResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-rest-send`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionResponse.status).toBe(200)
      expect(await sessionResponse.json()).toMatchObject({
        name: 'codex-rest-send',
        completed: false,
        status: 'running',
        agentType: 'codex',
      })

      ws.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('does not duplicate user events when Codex echoes item/started userMessage after send', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-user-echo-dedupe',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-user-echo-dedupe')
      const received: Array<{ type: string; message?: { content?: string } }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; message?: { content?: string } }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-user-echo-dedupe/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })

      expect(sendResponse.status).toBe(200)
      expect(await sendResponse.json()).toEqual({ sent: true })

      await vi.waitFor(() => {
        const userEvents = received.filter(
          (event) => event.type === 'user' && event.message?.content === 'status?',
        )
        expect(userEvents).toHaveLength(1)
      })

      sidecar.emitNotification('item/started', {
        threadId: 'thread-1',
        item: {
          id: 'user-item-1',
          type: 'userMessage',
          content: [{ type: 'input_text', text: 'status?' }],
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      const userEvents = received.filter(
        (event) => event.type === 'user' && event.message?.content === 'status?',
      )
      expect(userEvents).toHaveLength(1)

      const session = server.agents.sessionsInterface.getSession('codex-user-echo-dedupe')
      const storedUserEvents = (session?.events ?? []).filter((event) => {
        if (event.type !== 'user') {
          return false
        }
        const userEvent = event as { message?: { content?: unknown } }
        return userEvent.message?.content === 'status?'
      })
      expect(storedUserEvents).toHaveLength(1)

      ws.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('surfaces Codex turn/start rejection and marks the session failed instead of running', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-turn-start-error',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-turn-start-error')
      const received: Array<{ type: string; text?: string; message?: { content?: string } }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string; message?: { content?: string } }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      sidecar.setTurnStartBehavior('error')
      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-turn-start-error/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })

      expect(sendResponse.status).toBe(503)
      expect(await sendResponse.json()).toEqual({
        sent: false,
        error: 'Stream session unavailable',
      })

      await vi.waitFor(() => {
        const systemEvent = received.find((event) => event.type === 'system')
        expect(systemEvent?.text).toContain('Injected turn/start failure')
      })

      expect(received.some((event) => event.type === 'user' && event.message?.content === 'status?')).toBe(false)
      expect(received.some((event) => event.type === 'exit')).toBe(true)

      await vi.waitFor(async () => {
        const sessionResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-turn-start-error`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionResponse.status).toBe(200)
        expect(await sessionResponse.json()).toMatchObject({
          name: 'codex-turn-start-error',
          completed: true,
          status: 'failed',
          result: {
            status: 'failed',
            finalComment: expect.stringContaining('Injected turn/start failure'),
          },
        })
      })

      const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await listResponse.json() as Array<{ name: string; processAlive?: boolean }>
      const exited = sessions.find((session) => session.name === 'codex-turn-start-error')
      expect(exited?.processAlive).toBe(false)
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('marks a Codex session failed when its runtime transport closes', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-sidecar-close',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-sidecar-close')
      const received: Array<{ type: string; text?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      await sidecar.closeConnection(1011, 'Injected transport failure')

      await vi.waitFor(() => {
        const systemEvent = received.find((event) => event.type === 'system')
        expect(systemEvent?.text).toContain('Injected transport failure')
      })
      expect(received.some((event) => event.type === 'exit')).toBe(true)

      await vi.waitFor(async () => {
        const sessionResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-sidecar-close`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionResponse.status).toBe(200)
        expect(await sessionResponse.json()).toMatchObject({
          name: 'codex-sidecar-close',
          completed: true,
          status: 'failed',
          result: {
            status: 'failed',
            finalComment: expect.stringContaining('Injected transport failure'),
          },
        })
      })

      const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await listResponse.json() as Array<{ name: string; processAlive?: boolean }>
      const exited = sessions.find((session) => session.name === 'codex-sidecar-close')
      expect(exited?.processAlive).toBe(false)
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('isolates Codex runtime transport failures to the affected session', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createA = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-isolation-a',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createA.status).toBe(201)

      const createB = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-isolation-b',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createB.status).toBe(201)

      await vi.waitFor(() => {
        expect(sidecar.getRuntimeSpawnCount()).toBe(2)
        expect(sidecar.getStartedThreadIds()).toHaveLength(2)
      })

      const [threadA, threadB] = sidecar.getStartedThreadIds()
      expect(threadA).toBeDefined()
      expect(threadB).toBeDefined()
      expect(threadA).not.toBe(threadB)

      const wsA = await connectWs(server.baseUrl, 'codex-isolation-a')
      const wsB = await connectWs(server.baseUrl, 'codex-isolation-b')
      const receivedA: Array<{ type: string; text?: string }> = []
      const receivedB: Array<{ type: string; text?: string }> = []

      wsA.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          receivedA.push(parsed)
        }
      })
      wsB.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          receivedB.push(parsed)
        }
      })

      await sidecar.closeConnectionForThread(threadA!, 1011, 'Injected runtime-A transport failure')

      await vi.waitFor(() => {
        const systemEvent = receivedA.find((event) => event.type === 'system')
        expect(systemEvent?.text).toContain('Injected runtime-A transport failure')
      })
      expect(receivedA.some((event) => event.type === 'exit')).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(receivedB.some((event) => event.type === 'exit')).toBe(false)

      const sendB = await fetch(`${server.baseUrl}/api/agents/sessions/codex-isolation-b/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'still alive?' }),
      })
      expect(sendB.status).toBe(200)
      expect(await sendB.json()).toEqual({ sent: true })

      await vi.waitFor(() => {
        const turnRequest = sidecar.getRequests('turn/start').find((request) => {
          const params = (request.params ?? {}) as {
            threadId?: unknown
            input?: Array<{ text?: unknown }>
          }
          const turnText = Array.isArray(params.input) && typeof params.input[0]?.text === 'string'
            ? params.input[0].text
            : undefined
          return params.threadId === threadB && turnText === 'still alive?'
        })
        expect(turnRequest).toBeDefined()
      })

      const sessionB = await fetch(`${server.baseUrl}/api/agents/sessions/codex-isolation-b`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionB.status).toBe(200)
      expect(await sessionB.json()).toMatchObject({
        name: 'codex-isolation-b',
        completed: false,
        status: 'running',
      })

      wsA.close()
      wsB.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('tears down only the deleted Codex runtime when two sessions are active', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createA = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-delete-a',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createA.status).toBe(201)

      const createB = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-delete-b',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createB.status).toBe(201)

      await vi.waitFor(() => {
        expect(sidecar.getStartedThreadIds()).toHaveLength(2)
      })
      const [threadA, threadB] = sidecar.getStartedThreadIds()

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-delete-a`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)
      expect(await deleteResponse.json()).toEqual({ killed: true })

      await vi.waitFor(() => {
        expect(sidecar.getProcessKillCallCount(threadA!)).toBeGreaterThan(0)
      })
      expect(sidecar.getProcessKillCallCount(threadB!)).toBe(0)

      const archiveRequests = sidecar.getRequests('thread/archive').filter((request) => {
        const params = (request.params ?? {}) as { threadId?: unknown }
        return params.threadId === threadA
      })
      expect(archiveRequests.length).toBeGreaterThan(0)

      const sendB = await fetch(`${server.baseUrl}/api/agents/sessions/codex-delete-b/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'session b still active' }),
      })
      expect(sendB.status).toBe(200)
      expect(await sendB.json()).toEqual({ sent: true })

      await vi.waitFor(() => {
        const turnRequest = sidecar.getRequests('turn/start').find((request) => {
          const params = (request.params ?? {}) as {
            threadId?: unknown
            input?: Array<{ text?: unknown }>
          }
          const turnText = Array.isArray(params.input) && typeof params.input[0]?.text === 'string'
            ? params.input[0].text
            : undefined
          return params.threadId === threadB && turnText === 'session b still active'
        })
        expect(turnRequest).toBeDefined()
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('reaps all active Codex runtimes on sessions shutdown when runtime API exposes shutdown', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createA = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-shutdown-a',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createA.status).toBe(201)

      const createB = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-shutdown-b',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createB.status).toBe(201)

      await vi.waitFor(() => {
        expect(sidecar.getStartedThreadIds()).toHaveLength(2)
      })

      const [threadA, threadB] = sidecar.getStartedThreadIds()
      const maybeShutdown = (server.agents.sessionsInterface as { shutdown?: () => void | Promise<void> }).shutdown
      if (typeof maybeShutdown !== 'function') {
        return
      }

      await maybeShutdown()

      await vi.waitFor(() => {
        expect(sidecar.getProcessKillCallCount(threadA!)).toBeGreaterThan(0)
        expect(sidecar.getProcessKillCallCount(threadB!)).toBeGreaterThan(0)
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('fails Codex sessions when runtime keepalive stops receiving pong frames', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer({
      wsKeepAliveIntervalMs: 20,
      codexTurnWatchdogTimeoutMs: 1000,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-sidecar-keepalive-timeout',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      sidecar.suppressPongResponses()

      const ws = await connectWs(server.baseUrl, 'codex-sidecar-keepalive-timeout')
      const received: Array<{ type: string; text?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      await vi.waitFor(() => {
        const systemEvent = received.find((event) => event.type === 'system')
        expect(systemEvent?.text).toContain('keepalive timeout')
      })
      expect(received.some((event) => event.type === 'exit')).toBe(true)

      await vi.waitFor(async () => {
        const sessionResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-sidecar-keepalive-timeout`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionResponse.status).toBe(200)
        expect(await sessionResponse.json()).toMatchObject({
          completed: true,
          status: 'failed',
        })
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('logs Codex runtime stderr output for diagnostics', async () => {
    const sidecar = installMockCodexSidecar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-sidecar-stderr-log',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      sidecar.emitStderr('Injected sidecar stderr line')

      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some(
          ([message]) => typeof message === 'string'
            && message.includes('[agents][codex')
            && message.includes('[stderr]')
            && message.includes('Injected sidecar stderr line'),
        )).toBe(true)
      })
    } finally {
      warnSpy.mockRestore()
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('logs and surfaces unsupported Codex approval requests', async () => {
    const sidecar = installMockCodexSidecar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-approval-request-log',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-approval-request-log')
      const received: Array<{ type: string; text?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      sidecar.emitNotification('item/commandExecution/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        reason: 'Command writes outside the workspace',
        risk: 'Potentially destructive shell command',
      })

      await vi.waitFor(() => {
        const systemEvent = received.find(
          (event) => event.type === 'system' && event.text?.includes('Codex is waiting for command execution approval'),
        )
        expect(systemEvent?.text).toContain('Command writes outside the workspace')
      })

      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some(
          ([message]) => typeof message === 'string'
            && message.includes('Unsupported Codex approval request')
            && message.includes('item/commandExecution/requestApproval')
            && message.includes('codex-approval-request-log'),
        )).toBe(true)
      })

      ws.close()
    } finally {
      warnSpy.mockRestore()
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('synthesizes Codex turn completion from thread/read when notifications stall after turn acceptance', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer({
      codexTurnWatchdogTimeoutMs: 40,
    })

    try {
      sidecar.setThreadReadResult({
        thread: {
          id: 'thread-1',
          tokenUsage: {
            inputTokens: 40,
            outputTokens: 12,
            totalCostUsd: 0.07,
          },
          turns: [
            {
              id: 'turn-1',
              status: 'completed',
              tokenUsage: {
                inputTokens: 40,
                outputTokens: 12,
                totalCostUsd: 0.07,
              },
            },
          ],
        },
      })

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-watchdog-complete',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-watchdog-complete')
      const received: Array<{ type: string; result?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; result?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-watchdog-complete/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })
      expect(sendResponse.status).toBe(200)

      await vi.waitFor(() => {
        const resultEvent = received.find((event) => event.type === 'result')
        expect(resultEvent?.result).toBe('Turn completed')
      })

      await vi.waitFor(() => {
        const threadReadRequests = sidecar.getRequests('thread/read')
        expect(threadReadRequests.length).toBeGreaterThan(0)
      })

      await vi.waitFor(async () => {
        const worldResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
          headers: AUTH_HEADERS,
        })
        expect(worldResponse.status).toBe(200)
        const world = await worldResponse.json() as Array<{ id: string; status: string; usage: { costUsd: number } }>
        const entry = world.find((item) => item.id === 'codex-watchdog-complete')
        expect(entry?.status).toBe('completed')
        expect(entry?.usage.costUsd).toBe(0.07)
      })

      ws.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('marks Codex sessions stale when watchdog cannot confirm turn completion', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer({
      codexTurnWatchdogTimeoutMs: 40,
    })

    try {
      sidecar.setThreadReadResult({
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: 'turn-1',
              status: 'inProgress',
            },
          ],
        },
      })

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-watchdog-stale',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-watchdog-stale')
      const received: Array<{ type: string; text?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-watchdog-stale/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })
      expect(sendResponse.status).toBe(200)

      await vi.waitFor(() => {
        const staleEvent = received.find((event) => event.type === 'system')
        expect(staleEvent?.text).toContain('Codex turn is stale')
      })

      await vi.waitFor(async () => {
        const worldResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
          headers: AUTH_HEADERS,
        })
        expect(worldResponse.status).toBe(200)
        const world = await worldResponse.json() as Array<{ id: string; status: string; phase: string }>
        const entry = world.find((item) => item.id === 'codex-watchdog-stale')
        expect(entry?.status).toBe('stale')
        expect(entry?.phase).toBe('stale')
      })

      await vi.waitFor(async () => {
        const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionsResponse.status).toBe(200)
        const listedSessions = await sessionsResponse.json() as Array<{
          name: string
          status?: string
          resumeAvailable?: boolean
        }>
        const entry = listedSessions.find((item) => item.name === 'codex-watchdog-stale')
        expect(entry?.status).toBe('stale')
        expect(entry?.resumeAvailable).toBe(true)
      })

      expect(received.some((event) => event.type === 'result')).toBe(false)
      ws.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('logs watchdog reconciliation failures before marking Codex sessions stale', async () => {
    const sidecar = installMockCodexSidecar()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = await startServer({
      codexTurnWatchdogTimeoutMs: 40,
    })

    try {
      sidecar.setThreadReadError('Injected thread/read failure')

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-watchdog-thread-read-error',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-watchdog-thread-read-error')
      const received: Array<{ type: string; text?: string }> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
      })

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-watchdog-thread-read-error/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'status?' }),
      })
      expect(sendResponse.status).toBe(200)

      await vi.waitFor(() => {
        const staleEvent = received.find(
          (event) => event.type === 'system' && event.text?.includes('Codex turn is stale'),
        )
        expect(staleEvent).toBeDefined()
      })

      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some(
          ([message]) => typeof message === 'string'
            && message.includes('Codex watchdog thread/read reconciliation failed')
            && message.includes('Injected thread/read failure'),
        )).toBe(true)
      })
    } finally {
      warnSpy.mockRestore()
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('resumes stale live Codex sessions in place', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer({
      codexTurnWatchdogTimeoutMs: 40,
    })

    try {
      sidecar.setThreadReadResult({
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: 'turn-1',
              status: 'inProgress',
            },
          ],
        },
      })

      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-stale-resume-source',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-stale-resume-source/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'resume this turn' }),
      })
      expect(sendResponse.status).toBe(200)

      await vi.waitFor(async () => {
        const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionsResponse.status).toBe(200)
        const listedSessions = await sessionsResponse.json() as Array<{
          name: string
          status?: string
          resumeAvailable?: boolean
        }>
        const entry = listedSessions.find((item) => item.name === 'codex-stale-resume-source')
        expect(entry?.status).toBe('stale')
        expect(entry?.resumeAvailable).toBe(true)
      })

      const resumeResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-stale-resume-source/resume`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(resumeResponse.status).toBe(201)
      const resumed = await resumeResponse.json() as { name: string; resumedFrom: string }
      expect(resumed.name).toBe('codex-stale-resume-source')
      expect(resumed.resumedFrom).toBe('codex-stale-resume-source')

      expect(sidecar.getRequests('thread/resume')).toHaveLength(1)

      await vi.waitFor(async () => {
        const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          headers: AUTH_HEADERS,
        })
        expect(sessionsResponse.status).toBe(200)
        const listedSessions = await sessionsResponse.json() as Array<{
          name: string
          processAlive?: boolean
          resumedFrom?: string
          status?: string
          resumeAvailable?: boolean
        }>
        const matching = listedSessions.filter((item) => item.name === 'codex-stale-resume-source')
        expect(matching).toHaveLength(1)
        expect(matching[0]?.processAlive).toBe(true)
        expect(matching[0]?.resumeAvailable).toBe(false)
        expect(matching[0]?.resumedFrom).toBeUndefined()
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('hides Resume for exited Codex sessions when the rollout file is missing', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'hammurabi-codex-home-'))
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-codex-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const originalHome = process.env.HOME

    await writeFile(
      sessionStorePath,
      JSON.stringify({
        sessions: [
          {
            name: 'hamkid',
            agentType: 'codex',
            mode: 'dangerouslySkipPermissions',
            cwd: '/home/ec2-user/App',
            createdAt: '2026-04-07T23:24:35.181Z',
            codexThreadId: '019d6a43-1781-70b2-b8e0-eb1fda3dead3',
            sessionState: 'exited',
            hadResult: false,
            events: [],
          },
        ],
      }),
      'utf8',
    )

    process.env.HOME = homeDir
    const server = await startServer({
      autoResumeSessions: true,
      sessionStorePath,
    })

    try {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)

      const sessions = await response.json() as Array<{
        name: string
        resumeAvailable?: boolean
        status?: string
      }>
      const hamkid = sessions.find((session) => session.name === 'hamkid')
      expect(hamkid?.status).toBe('exited')
      expect(hamkid?.resumeAvailable).toBe(false)
    } finally {
      await server.close()
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      await rm(homeDir, { recursive: true, force: true })
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('returns 409 and clears stale Codex resume metadata when rollout is gone', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'hammurabi-codex-home-'))
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-codex-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const originalHome = process.env.HOME

    await writeFile(
      sessionStorePath,
      JSON.stringify({
        sessions: [
          {
            name: 'hamkid',
            agentType: 'codex',
            mode: 'dangerouslySkipPermissions',
            cwd: '/home/ec2-user/App',
            createdAt: '2026-04-07T23:24:35.181Z',
            codexThreadId: '019d6a43-1781-70b2-b8e0-eb1fda3dead3',
            sessionState: 'exited',
            hadResult: false,
            events: [],
          },
        ],
      }),
      'utf8',
    )

    process.env.HOME = homeDir
    const server = await startServer({
      autoResumeSessions: true,
      sessionStorePath,
    })

    try {
      const resumeResponse = await fetch(`${server.baseUrl}/api/agents/sessions/hamkid/resume`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(resumeResponse.status).toBe(409)
      expect(await resumeResponse.json()).toEqual({
        error: 'Session "hamkid" can no longer be resumed because its Codex rollout is unavailable',
      })

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as { sessions: Array<{ name: string; codexThreadId?: string }> }
        expect(parsed.sessions.find((session) => session.name === 'hamkid')).toBeUndefined()
      })

      const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionsResponse.status).toBe(200)
      const sessions = await sessionsResponse.json() as Array<{
        name: string
        resumeAvailable?: boolean
      }>
      expect(sessions.find((session) => session.name === 'hamkid')).toEqual(
        expect.objectContaining({
          name: 'hamkid',
          resumeAvailable: false,
        }),
      )
    } finally {
      await server.close()
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      await rm(homeDir, { recursive: true, force: true })
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('pre-kill-debrief returns immediately for stream sessions so kill can proceed', async () => {
    installMockProcess()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-kill-debrief',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      const preResp = await fetch(`${server.baseUrl}/api/agents/sessions/stream-kill-debrief/pre-kill-debrief`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(preResp.status).toBe(200)
      expect(await preResp.json()).toEqual({
        debriefStarted: false,
        reason: 'not-supported-yet',
      })

      const statusResp = await fetch(`${server.baseUrl}/api/agents/sessions/stream-kill-debrief/debrief-status`, {
        headers: AUTH_HEADERS,
      })
      expect(statusResp.status).toBe(200)
      expect(await statusResp.json()).toEqual({ status: 'none' })
    } finally {
      await server.close()
    }
  })

  it('accounts for Codex thread/tokenUsage/updated notifications in replay usage totals', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-usage-notifications',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      sidecar.emitNotification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        tokenUsage: {
          inputTokens: 90,
          outputTokens: 33,
          totalCostUsd: 0.11,
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      const wsUrl = server.baseUrl.replace('http://', 'ws://') +
        '/api/agents/sessions/codex-usage-notifications/terminal?api_key=test-key'
      const ws = new WebSocket(wsUrl)
      const replayPromise = new Promise<{
        type: string
        events: Array<{ type: string; usage?: unknown; usage_is_total?: boolean }>
        usage: { inputTokens: number; outputTokens: number; costUsd: number }
      }>((resolve) => {
        ws.on('message', (data) => {
          const parsed = JSON.parse(data.toString()) as {
            type: string
            events?: Array<{ type: string; usage?: unknown; usage_is_total?: boolean }>
            usage?: { inputTokens: number; outputTokens: number; costUsd: number }
          }
          if (parsed.type === 'replay' && parsed.events && parsed.usage) {
            resolve({
              type: parsed.type,
              events: parsed.events,
              usage: parsed.usage,
            })
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })

      const replay = await replayPromise

      expect(replay.usage).toEqual({
        inputTokens: 90,
        outputTokens: 33,
        costUsd: 0.11,
      })
      const usageEvent = replay.events.find((event) => event.type === 'message_delta')
      expect(usageEvent).toMatchObject({
        usage: { input_tokens: 90, output_tokens: 33 },
        usage_is_total: true,
      })

      ws.close()
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('routes sessionsInterface.sendToSession through Codex transport', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-interface-send',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const sent = await server.agents.sessionsInterface.sendToSession('codex-interface-send', 'heartbeat')
      expect(sent).toBe(true)

      await vi.waitFor(() => {
        const turnRequests = sidecar.getRequests('turn/start')
        expect(turnRequests).toHaveLength(1)
        expect(turnRequests[0].params).toEqual({
          threadId: 'thread-1',
          input: [{ type: 'text', text: 'heartbeat' }],
        })
      })

      const session = server.agents.sessionsInterface.getSession('codex-interface-send')
      expect(session?.events.some((event) => event.type === 'user')).toBe(true)
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('bootstraps Codex commander sessions with developerInstructions and no seed turn', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const systemPrompt = 'You are Athena. Follow commander runtime policy.'
      await server.agents.sessionsInterface.createCommanderSession({
        name: 'commander-codex-bootstrap',
        systemPrompt,
        agentType: 'codex',
        cwd: '/tmp',
      })

      await vi.waitFor(() => {
        const threadRequests = sidecar.getRequests('thread/start')
        expect(threadRequests).toHaveLength(1)
        expect(threadRequests[0]?.params).toEqual(expect.objectContaining({
          cwd: '/tmp',
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          developerInstructions: systemPrompt,
        }))
      })
      expect(sidecar.getRequests('turn/start')).toHaveLength(0)

      const startupMessage = 'Commander runtime started. Acknowledge readiness and await instructions.'
      const sent = await server.agents.sessionsInterface.sendToSession('commander-codex-bootstrap', startupMessage)
      expect(sent).toBe(true)

      await vi.waitFor(() => {
        const turnRequests = sidecar.getRequests('turn/start')
        expect(turnRequests).toHaveLength(1)
        expect(turnRequests[0]?.params).toEqual({
          threadId: 'thread-1',
          input: [{ type: 'text', text: startupMessage }],
        })
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('keeps non-commander Codex task bootstrap as the first user turn', async () => {
    const sidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const task = 'Summarize failing tests before coding.'
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-task-bootstrap',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
          task,
        }),
      })
      expect(createResponse.status).toBe(201)

      await vi.waitFor(() => {
        const threadRequests = sidecar.getRequests('thread/start')
        expect(threadRequests).toHaveLength(1)
      })

      const threadStartParams = sidecar.getRequests('thread/start')[0]?.params as
        | Record<string, unknown>
        | undefined
      expect(threadStartParams?.developerInstructions).toBeUndefined()

      await vi.waitFor(() => {
        const turnRequests = sidecar.getRequests('turn/start')
        expect(turnRequests).toHaveLength(1)
        expect(turnRequests[0]?.params).toEqual({
          threadId: 'thread-1',
          input: [{ type: 'text', text: task }],
        })
      })
    } finally {
      await sidecar.closeServer()
      await server.close()
    }
  })

  it('stream session appears in session list with sessionType=stream', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-list-01',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const sessions = (await response.json()) as Array<{ name: string; sessionType?: string; pid: number }>

    expect(sessions).toHaveLength(1)
    expect(sessions[0].name).toBe('stream-list-01')
    expect(sessions[0].sessionType).toBe('stream')
    expect(sessions[0].pid).toBe(99999)

    await server.close()
  })

  it('spawns with --acceptEdits flag for acceptEdits mode', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-accept',
        mode: 'acceptEdits',
        sessionType: 'stream',
      }),
    })

    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--effort',
        'max',
        '--permission-mode',
        'acceptEdits',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
          CLAUDECODE: undefined,
        }),
      }),
    )

    await server.close()
  })

  it('spawns with --dangerously-skip-permissions for dangerouslySkipPermissions mode', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-dangerous',
        mode: 'dangerouslySkipPermissions',
        sessionType: 'stream',
      }),
    })

    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--effort',
        'max',
        '--dangerously-skip-permissions',
      ],
      expect.any(Object),
    )

    await server.close()
  })

  it('parses NDJSON from stdout and broadcasts to WebSocket clients', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-ndjson',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-ndjson')
    const received: unknown[] = []

    const messagePromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        // Skip replay messages
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
        if (received.length >= 2) {
          resolve()
        }
      })
    })

    // Emit two NDJSON events as a single stdout chunk with newlines
    mock.emitStdout(
      '{"type":"message_start","message":{"id":"msg1","role":"assistant"}}\n' +
      '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n',
    )

    await messagePromise
    expect(received).toHaveLength(2)
    expect((received[0] as { type: string }).type).toBe('message_start')
    expect((received[1] as { type: string }).type).toBe('content_block_start')

    ws.close()
    await server.close()
  })

  it('handles partial NDJSON lines split across stdout chunks', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-partial',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-partial')
    const received: unknown[] = []

    const messagePromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
        if (received.length >= 1) {
          resolve()
        }
      })
    })

    // Split a single JSON line across two stdout chunks
    mock.emitStdout('{"type":"message_sta')
    mock.emitStdout('rt","message":{"id":"m1","role":"assistant"}}\n')

    await messagePromise
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe('message_start')

    ws.close()
    await server.close()
  })

  it('sends buffered events as replay on WebSocket connect', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-replay',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Emit events BEFORE WebSocket connects
    mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
    mock.emitStdout('{"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n')

    // Small delay to ensure events are buffered
    await new Promise((r) => setTimeout(r, 50))

    // Register message handler BEFORE open to catch the replay sent on upgrade
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-replay/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; events?: unknown[] }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Wait for the replay message to arrive
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    expect(replay!.events).toHaveLength(2)
    expect((replay!.events![0] as { type: string }).type).toBe('message_start')
    expect((replay!.events![1] as { type: string }).type).toBe('content_block_start')

    ws.close()
    await server.close()
  })

  it('normalizes Claude plan-mode events before replay while keeping AskUserQuestion intact', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-plan-mode',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    mock.emitStdout('{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"plan-enter","name":"EnterPlanMode"}]}}\n')
    mock.emitStdout('{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"plan-exit","name":"ExitPlanMode","input":{"plan":"1. Inspect stream handling\\n2. Patch replay"}}]}}\n')
    mock.emitStdout('{"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[{"question":"Proceed?","header":"Confirm","multiSelect":false,"options":[{"label":"Yes","description":"Continue"}]}]}}]}}\n')
    mock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"plan-exit","content":"{\\"approved\\":true,\\"message\\":\\"Proceeding with the approved plan.\\"}"}]}}\n')

    await new Promise((resolve) => setTimeout(resolve, 50))

    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-plan-mode/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; events?: unknown[] }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((message) => message.type === 'replay')
    expect(replay).toBeDefined()

    const replayEvents = replay!.events as Array<Record<string, unknown>>
    expect(replayEvents).toEqual([
      {
        type: 'planning',
        action: 'enter',
      },
      {
        type: 'planning',
        action: 'proposed',
        plan: '1. Inspect stream handling\n2. Patch replay',
      },
      {
        type: 'assistant',
        message: {
          id: 'm3',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'ask-1',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Proceed?',
                    header: 'Confirm',
                    multiSelect: false,
                    options: [{ label: 'Yes', description: 'Continue' }],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'planning',
        action: 'decision',
        approved: true,
        message: 'Proceeding with the approved plan.',
      },
    ])

    ws.close()
    await server.close()
  })

  it('replays buffered stream events and usage after client reconnect', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-replay-reconnect',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // First client attaches, then disconnects.
    const firstWs = await connectWs(server.baseUrl, 'stream-replay-reconnect')
    firstWs.close()
    await new Promise<void>((resolve) => firstWs.on('close', () => resolve()))

    // Events that happen across disconnect windows must be replayed together.
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":20,"output_tokens":10}}\n')
    mock.emitStdout('{"type":"result","result":"done","total_cost_usd":0.02,"usage":{"input_tokens":35,"output_tokens":15}}\n')
    await new Promise((r) => setTimeout(r, 50))

    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-replay-reconnect/terminal?api_key=test-key'
    const secondWs = new WebSocket(wsUrl)
    const messages: Array<{
      type: string
      events?: Array<{ type: string }>
      usage?: { inputTokens: number; outputTokens: number; costUsd: number }
    }> = []

    secondWs.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      secondWs.on('open', () => resolve())
      secondWs.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((message) => message.type === 'replay')
    expect(replay).toBeDefined()
    expect(replay!.events?.map((event) => event.type)).toEqual(['message_delta', 'result'])
    expect(replay!.usage).toEqual({
      inputTokens: 35,
      outputTokens: 15,
      costUsd: 0.02,
    })

    secondWs.close()
    await server.close()
  })

  it('forwards user input from WebSocket to process stdin', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-input',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-input')

    // Send user input through WebSocket
    ws.send(JSON.stringify({ type: 'input', text: 'What files handle auth?' }))

    await vi.waitFor(() => {
      // First write is the initial task (empty string task still won't write),
      // the user input should appear as a stdin write
      const writes = mock.getStdinWrites()
      const userWrites = writes.filter((w) => w.includes('What files handle auth?'))
      expect(userWrites.length).toBeGreaterThan(0)
    })

    const userWrite = mock.getStdinWrites().find((w) => w.includes('What files handle auth?'))!
    const parsed = JSON.parse(userWrite.replace('\n', ''))
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: 'What files handle auth?' },
    })

    ws.close()
    await server.close()
  })

  it('clears lastTurnCompleted immediately when WS input is received for completed session', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'completed-input-test',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Drive the session through a full turn so lastTurnCompleted is set.
    mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
    mock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')

    // Confirm session is 'completed' before sending new input.
    await vi.waitFor(async () => {
      const resp = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      const payload = await resp.json() as Array<{ id: string; status: string }>
      const entry = payload.find((e) => e.id === 'completed-input-test')
      expect(entry?.status).toBe('completed')
    })

    // Connect via WebSocket and send new input.
    const ws = await connectWs(server.baseUrl, 'completed-input-test')
    ws.send(JSON.stringify({ type: 'input', text: 'new task after completion' }))

    // World status should immediately flip back to non-completed after input.
    await vi.waitFor(async () => {
      const resp = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      const payload = await resp.json() as Array<{ id: string; status: string }>
      const entry = payload.find((e) => e.id === 'completed-input-test')
      expect(entry?.status).not.toBe('completed')
    })

    ws.close()
    await server.close()
  })

  it('does not clear lastTurnCompleted for command-room sessions on WS input', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'command-room-no-clear-test',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Drive to completed.
    mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
    mock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')

    await vi.waitFor(async () => {
      const resp = await fetch(`${server.baseUrl}/api/agents/world`, {
        headers: AUTH_HEADERS,
      })
      const payload = await resp.json() as Array<{ id: string; status: string }>
      const entry = payload.find((e) => e.id === 'command-room-no-clear-test')
      expect(entry?.status).toBe('completed')
    })

    // Send input — command-room sessions should stay completed.
    const ws = await connectWs(server.baseUrl, 'command-room-no-clear-test')
    ws.send(JSON.stringify({ type: 'input', text: 'more input' }))

    // Wait briefly to let the WS message be processed.
    await new Promise((r) => setTimeout(r, 100))

    const resp = await fetch(`${server.baseUrl}/api/agents/world`, {
      headers: AUTH_HEADERS,
    })
    const payload = await resp.json() as Array<{ id: string; status: string }>
    const entry = payload.find((e) => e.id === 'command-room-no-clear-test')
    expect(entry?.status).toBe('completed')

    ws.close()
    await server.close()
  })

  it('broadcasts exit event and cleans up on process exit', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-exit',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-exit')
    const exitPromise = new Promise<{ type: string; exitCode: number }>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; exitCode?: number }
        if (parsed.type === 'exit') {
          resolve(parsed as { type: string; exitCode: number })
        }
      })
    })

    mock.emitExit(0)

    const exitEvent = await exitPromise
    expect(exitEvent.type).toBe('exit')
    expect(exitEvent.exitCode).toBe(0)

    // Session should be removed from the list
    await vi.waitFor(async () => {
      const resp = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await resp.json() as Array<{ name: string; processAlive?: boolean }>
      const exited = sessions.find((session) => session.name === 'stream-exit')
      expect(exited?.processAlive).toBe(false)
    })

    await server.close()
  })

  it('includes stderr summary in exit event payload', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-exit-stderr',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-exit-stderr')
    const exitPromise = new Promise<{ type: string; exitCode: number; stderr?: string; text?: string }>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as {
          type: string
          exitCode?: number
          stderr?: string
          text?: string
        }
        if (parsed.type === 'exit') {
          resolve(parsed as { type: string; exitCode: number; stderr?: string; text?: string })
        }
      })
    })

    mock.cp.stderr.emit('data', Buffer.from('prep line\nclaude: command not found\n'))
    mock.emitExit(127)

    const exitEvent = await exitPromise
    expect(exitEvent.type).toBe('exit')
    expect(exitEvent.exitCode).toBe(127)
    expect(exitEvent.stderr).toBe('claude: command not found')
    expect(exitEvent.text).toContain('Process exited with code 127')
    expect(exitEvent.text).toContain('stderr: claude: command not found')

    ws.close()
    await server.close()
  })

  it('broadcasts system event on process error and cleans up session', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-error',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Register message handler before open to avoid missing events
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-error/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const received: Array<{ type: string; text?: string }> = []

    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Emit error after WS is connected
    mock.emitError(new Error('spawn ENOENT'))

    await vi.waitFor(() => {
      const systemMsg = received.find((m) => m.type === 'system')
      expect(systemMsg).toBeDefined()
    })

    const errorEvent = received.find((m) => m.type === 'system')!
    expect(errorEvent.text).toContain('spawn ENOENT')

    // Session should be cleaned up after process error (prevents zombie entries)
    await vi.waitFor(async () => {
      const resp = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await resp.json() as Array<{ name: string; processAlive?: boolean }>
      const exited = sessions.find((session) => session.name === 'stream-error')
      expect(exited?.processAlive).toBe(false)
    })

    ws.close()
    await server.close()
  })

  it('relays stderr output as system events', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-stderr',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-stderr')
    const received: Array<{ type: string; text?: string }> = []

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
      if (parsed.type !== 'replay') {
        received.push(parsed)
      }
    })

    // Emit stderr data from the child process
    mock.cp.stderr.emit('data', Buffer.from('Error: auth token expired'))

    await vi.waitFor(() => {
      const stderrMsg = received.find((m) => m.type === 'system' && m.text?.includes('stderr:'))
      expect(stderrMsg).toBeDefined()
    })

    const stderrEvent = received.find((m) => m.type === 'system' && m.text?.includes('stderr:'))!
    expect(stderrEvent.text).toContain('auth token expired')

    ws.close()
    await server.close()
  })

  it('kills stream session process on DELETE', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-kill',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions/stream-kill`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ killed: true })
    expect(mock.cp.kill).toHaveBeenCalledWith('SIGTERM')

    await server.close()
  })

  it('tracks usage from message_delta events', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-usage',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Emit a message_delta with usage info
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":50}}\n')

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50))

    // Register message handler before open to catch the replay
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-usage/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; events?: Array<{ type: string; usage?: unknown }> }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // Wait for replay
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    const usageEvent = replay!.events!.find((e) => e.type === 'message_delta')
    expect(usageEvent).toBeDefined()
    expect(usageEvent?.usage).toEqual({ input_tokens: 100, output_tokens: 50 })

    ws.close()
    await server.close()
  })

  it('skips unparseable NDJSON lines without crashing', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-badjson',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-badjson')
    const received: unknown[] = []

    const messagePromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type !== 'replay') {
          received.push(parsed)
        }
        if (received.length >= 1) {
          resolve()
        }
      })
    })

    // Send a bad line followed by a good line
    mock.emitStdout('this is not json\n')
    mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

    await messagePromise
    // Only the valid line should come through
    expect(received).toHaveLength(1)
    expect((received[0] as { type: string }).type).toBe('message_start')

    ws.close()
    await server.close()
  })

  it('caps event buffer at MAX_STREAM_EVENTS', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-cap',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Emit more than 1000 events (the MAX_STREAM_EVENTS constant)
    const batch: string[] = []
    for (let i = 0; i < 1010; i++) {
      batch.push(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `chunk-${i}` } }))
    }
    // Send in chunks to avoid enormous single write
    mock.emitStdout(batch.slice(0, 500).join('\n') + '\n')
    mock.emitStdout(batch.slice(500).join('\n') + '\n')

    // Wait for processing
    await new Promise((r) => setTimeout(r, 100))

    // Connect and check replay
    const ws = await connectWs(server.baseUrl, 'stream-cap')
    const replayPromise = new Promise<{ events: unknown[] }>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as { type: string; events?: unknown[] }
        if (parsed.type === 'replay') {
          resolve(parsed as { events: unknown[] })
        }
      })
    })

    const replay = await replayPromise
    // Should be capped at 1000
    expect(replay.events.length).toBeLessThanOrEqual(1000)
    // The last event should be the most recent (chunk-1009)
    const lastEvent = replay.events[replay.events.length - 1] as { delta: { text: string } }
    expect(lastEvent.delta.text).toBe('chunk-1009')

    ws.close()
    await server.close()
  })

  it('does not write to stdin when task is empty', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-no-task',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // No task was provided, so stdin should not have been written to
    expect(mock.getStdinWrites()).toHaveLength(0)

    await server.close()
  })

  it('ignores invalid WebSocket messages for stream sessions', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-bad-ws',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-bad-ws')

    // Send various invalid messages - should not crash
    ws.send('not json')
    ws.send(JSON.stringify({ type: 'unknown' }))
    ws.send(JSON.stringify({ type: 'input' })) // missing text
    ws.send(JSON.stringify({ type: 'input', text: '' })) // empty text
    ws.send(JSON.stringify({ type: 'input', text: '   ' })) // whitespace-only

    // Give time for messages to be processed
    await new Promise((r) => setTimeout(r, 100))

    // WebSocket should still be open (not crashed)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.close()
    await server.close()
  })

  it('includes accumulated usage in replay message to prevent double-counting', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-replay-usage',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Emit message_delta with usage and a result with cost
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":50}}\n')
    mock.emitStdout('{"type":"result","result":"done","cost_usd":0.05,"usage":{"input_tokens":200,"output_tokens":80}}\n')

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50))

    // Connect and check the replay message includes usage totals
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-replay-usage/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; events?: unknown[]; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    // The replay must include pre-accumulated usage so the client can set
    // totals directly instead of re-processing individual events additively
    expect(replay!.usage).toBeDefined()
    // result event overrides totals: inputTokens=200, outputTokens=80
    // message_delta added 100+50, then result set absolute 200+80
    expect(replay!.usage!.inputTokens).toBe(200)
    expect(replay!.usage!.outputTokens).toBe(80)
    expect(replay!.usage!.costUsd).toBe(0.05)

    ws.close()
    await server.close()
  })

  it('accumulates usage across multiple message_delta events from different turns', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-multi-usage',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Simulate two turns, each with their own message_delta usage.
    // Turn 1: input_tokens=100, output_tokens=50
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":100,"output_tokens":50}}\n')
    // Turn 2: input_tokens=120, output_tokens=60
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":120,"output_tokens":60}}\n')

    // Wait for processing
    await new Promise((r) => setTimeout(r, 50))

    // Connect and check accumulated usage in replay
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-multi-usage/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    // Usage should be accumulated: 100+120=220 input, 50+60=110 output
    expect(replay!.usage!.inputTokens).toBe(220)
    expect(replay!.usage!.outputTokens).toBe(110)

    ws.close()
    await server.close()
  })

  it('result event overrides accumulated usage with session-level totals', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-result-override',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Two turns accumulate usage
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":100,"output_tokens":50}}\n')
    mock.emitStdout('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":120,"output_tokens":60}}\n')
    // Result event carries session-level cumulative totals — should override
    mock.emitStdout('{"type":"result","result":"done","cost_usd":0.10,"usage":{"input_tokens":500,"output_tokens":200}}\n')

    await new Promise((r) => setTimeout(r, 50))

    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-result-override/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    // result.usage should override: 500 input, 200 output (not accumulated 220+500)
    expect(replay!.usage!.inputTokens).toBe(500)
    expect(replay!.usage!.outputTokens).toBe(200)
    expect(replay!.usage!.costUsd).toBe(0.10)

    ws.close()
    await server.close()
  })

  it('uses result.total_cost_usd when cost_usd is not present', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-total-cost',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    mock.emitStdout(
      '{"type":"result","result":"done","total_cost_usd":0.12,"usage":{"input_tokens":10,"output_tokens":5}}\n',
    )

    await new Promise((r) => setTimeout(r, 50))

    const wsUrl =
      server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-total-cost/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{
      type: string
      usage?: { inputTokens: number; outputTokens: number; costUsd: number }
    }> = []

    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    expect(replay!.usage).toBeDefined()
    expect(replay!.usage!.inputTokens).toBe(10)
    expect(replay!.usage!.outputTokens).toBe(5)
    expect(replay!.usage!.costUsd).toBe(0.12)

    ws.close()
    await server.close()
  })

  it('uses custom cwd for stream sessions', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-cwd',
        mode: 'default',
        sessionType: 'stream',
        cwd: '/home/ec2-user/projects/my-repo',
      }),
    })

    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({
        cwd: '/home/ec2-user/projects/my-repo',
      }),
    )

    await server.close()
  })

  it('handles error followed by exit without double-cleanup', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-race',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-race')
    const received: Array<{ type: string; text?: string }> = []

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as { type: string; text?: string }
      if (parsed.type !== 'replay') {
        received.push(parsed)
      }
    })

    // Fire error first, then exit — simulates spawn ENOENT where both
    // events fire.  The second handler should be a no-op (idempotent guard).
    mock.emitError(new Error('spawn ENOENT'))
    mock.emitExit(1)

    // Give time for both events to process
    await new Promise((r) => setTimeout(r, 100))

    // The error system event should have been broadcast, but NOT the exit
    // event (session was already deleted when error handler ran).
    const systemMsgs = received.filter((m) => m.type === 'system')
    expect(systemMsgs).toHaveLength(1)
    expect(systemMsgs[0].text).toContain('spawn ENOENT')

    // No exit event should have been sent (guard prevented it)
    const exitMsgs = received.filter((m) => m.type === 'exit')
    expect(exitMsgs).toHaveLength(0)

    // Session should be cleaned up
    const resp = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const sessions = await resp.json() as Array<{ name: string; processAlive?: boolean }>
    const exited = sessions.find((session) => session.name === 'stream-race')
    expect(exited?.processAlive).toBe(false)

    await server.close()
  })

  it('registers stdin error handler to prevent unhandled error crashes', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-stdin-error',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    // Verify the stdin error handler was registered (via the EventEmitter).
    // Without this handler, emitting 'error' on stdin would throw an
    // unhandled error and crash the process.
    expect(mock.cp.stdin.listenerCount('error')).toBeGreaterThan(0)

    // Emitting an error on stdin should NOT throw (handler swallows it).
    expect(() => {
      mock.cp.stdin.emit('error', new Error('write EPIPE'))
    }).not.toThrow()

    await server.close()
  })

  it('creates, prompts, and resumes Gemini ACP sessions without replaying provider history', async () => {
    const geminiAcp = installMockGeminiAcpRuntime()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'gemini-acp',
          mode: 'acceptEdits',
          agentType: 'gemini',
        }),
      })

      expect(createResponse.status).toBe(201)
      expect(geminiAcp.requests.some((request) => request.method === 'session/new')).toBe(true)
      expect(
        geminiAcp.requests.some((request) =>
          request.method === 'session/set_mode'
          && (request.params as { modeId?: string } | undefined)?.modeId === 'autoEdit'),
      ).toBe(true)

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/gemini-acp/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello gemini' }),
      })

      expect(sendResponse.status).toBe(200)
      expect(geminiAcp.promptTexts).toEqual(['hello gemini'])

      const liveSession = server.agents.sessionsInterface.getSession('gemini-acp')
      expect(liveSession?.agentType).toBe('gemini')
      expect(liveSession?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'message_start',
          source: { provider: 'gemini', backend: 'acp' },
        }),
        expect.objectContaining({
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'pondering...' },
          source: { provider: 'gemini', backend: 'acp' },
        }),
        expect.objectContaining({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'reply 1' },
          source: { provider: 'gemini', backend: 'acp' },
        }),
        expect.objectContaining({
          type: 'message_delta',
          usage: { input_tokens: 5, output_tokens: 7 },
          source: { provider: 'gemini', backend: 'acp' },
        }),
        expect.objectContaining({
          type: 'result',
          result: 'Turn completed',
          source: { provider: 'gemini', backend: 'acp' },
        }),
      ]))

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/gemini-acp`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)

      const resumeResponse = await fetch(`${server.baseUrl}/api/agents/sessions/gemini-acp/resume`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(resumeResponse.status).toBe(201)
      expect(geminiAcp.requests.some((request) => request.method === 'session/load')).toBe(true)

      const resumedSession = server.agents.sessionsInterface.getSession('gemini-acp')
      expect(resumedSession?.agentType).toBe('gemini')
      expect(resumedSession?.events).toEqual([])

      const resumedSendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/gemini-acp/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'hello again' }),
      })

      expect(resumedSendResponse.status).toBe(200)
      expect(geminiAcp.promptTexts).toEqual(['hello gemini', 'hello again'])
    } finally {
      await server.close()
    }
  })
})
