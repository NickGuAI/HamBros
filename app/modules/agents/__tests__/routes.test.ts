import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

import {
  createAgentsRouter,
  type AgentsRouterOptions,
  type CommanderSessionsInterface,
  type PtyHandle,
  type PtySpawner,
} from '../routes'
import { CommanderSessionStore, type CommanderSession } from '../../commanders/store'
import { extractMessages, readCommanderTranscript } from '../session-messages'
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
  sessionsInterface: ReturnType<typeof createAgentsRouter>['sessionsInterface']
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
    httpServer,
    sessionsInterface: agents.sessionsInterface,
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

async function seedCommanderSessionFixture(options: {
  commanderDataDir: string
  commanderId: string
  cwd?: string
  agentType?: 'claude' | 'codex'
  workflowPrompt: string
  identityBody: string
}) {
  const {
    commanderDataDir,
    commanderId,
    cwd = '/tmp',
    agentType = 'claude',
    workflowPrompt,
    identityBody,
  } = options

  const commanderRoot = join(commanderDataDir, commanderId)
  const memoryRoot = join(commanderRoot, '.memory')
  await mkdir(join(memoryRoot, 'journal'), { recursive: true })
  await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
  await mkdir(join(memoryRoot, 'repos'), { recursive: true })
  await writeFile(join(commanderRoot, 'COMMANDER.md'), workflowPrompt, 'utf8')
  await writeFile(
    join(memoryRoot, 'identity.md'),
    [
      '---',
      `id: "${commanderId}"`,
      '---',
      '',
      '# Identity',
      '',
      identityBody,
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(memoryRoot, 'MEMORY.md'), '# Commander Memory\n\n- Keep changes surgical.\n', 'utf8')

  const store = new CommanderSessionStore(join(commanderDataDir, 'sessions.json'))
  const session: CommanderSession = {
    id: commanderId,
    host: 'test-host',
    pid: 123,
    state: 'running',
    created: '2026-03-20T00:00:00Z',
    agentType,
    cwd,
    heartbeat: {
      intervalMs: 60_000,
      messageTemplate: 'heartbeat',
      lastSentAt: null,
    },
    lastHeartbeat: null,
    taskSource: null,
    currentTask: null,
    completedTasks: 0,
    totalCostUsd: 0,
  }
  await store.create(session)
}

function installMockProcess(options?: { pid?: number }) {
  const mock = createMockChildProcess(options?.pid)
  mockedSpawn.mockReturnValue(mock.cp as never)
  return mock
}

async function waitForPersistedSessionFlush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50)
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.spyOn(CommanderSessionStore.prototype, 'list').mockResolvedValue([])
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

  it('labels commander sessions by host from the commander session store', async () => {
    installMockProcess()
    vi.mocked(CommanderSessionStore.prototype.list).mockResolvedValue([
      {
        id: 'alpha',
        host: 'athena',
        pid: null,
        state: 'running',
        created: '2026-03-13T00:00:00.000Z',
        heartbeat: {
          intervalMs: 300000,
          messageTemplate: 'ping',
          lastSentAt: null,
        },
        lastHeartbeat: null,
        taskSource: null,
        currentTask: null,
        completedTasks: 0,
        totalCostUsd: 0,
      },
    ] satisfies CommanderSession[])

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
          name: 'commander-alpha',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const payload = await response.json() as Array<{ name: string; label?: string }>

      expect(response.status).toBe(200)
      expect(payload).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'commander-alpha',
          label: 'athena',
        }),
      ]))
    } finally {
      await server.close()
    }
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
        agentType: 'codex',
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
        agentType: string
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
          role: 'commander',
          status: 'active',
          phase: 'thinking',
        }),
        expect.objectContaining({
          id: 'commander-beta',
          agentType: 'codex',
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

  it('commander sessions never show completed status after result event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const baseTime = new Date('2026-03-05T00:00:00.000Z')
      vi.setSystemTime(baseTime)

      const streamMock = createMockChildProcess()
      mockedSpawn.mockReturnValueOnce(streamMock.cp as never)
      const server = await startServer()

      try {
        // Create a commander stream session
        const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'commander-athena',
            mode: 'default',
            sessionType: 'stream',
          }),
        })
        expect(createResponse.status).toBe(201)

        // Simulate a turn completing with a result event
        streamMock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
        streamMock.emitStdout('{"type":"result","result":"quest completed"}\n')

        // Commander should NOT be classified as 'completed'
        const worldResponse = await fetch(`${server.baseUrl}/api/agents/world`, {
          headers: AUTH_HEADERS,
        })
        expect(worldResponse.status).toBe(200)
        const payload = await worldResponse.json() as Array<{
          id: string
          status: string
          phase: string
        }>

        const commander = payload.find((agent) => agent.id === 'commander-athena')
        expect(commander).toBeDefined()
        expect(commander!.status).not.toBe('completed')
        expect(commander!.phase).not.toBe('completed')
      } finally {
        await server.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('done workers auto-evict from worker list after TTL expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const baseTime = new Date('2026-03-05T00:00:00.000Z')
      vi.setSystemTime(baseTime)

      // Create mock processes for parent + worker
      const parentMock = createMockChildProcess()
      const workerMock = createMockChildProcess()
      mockedSpawn.mockReturnValueOnce(parentMock.cp as never)
      mockedSpawn.mockReturnValueOnce(workerMock.cp as never)
      const server = await startServer()

      try {
        // Create parent session
        const parentResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'commander-parent',
            mode: 'default',
            sessionType: 'stream',
          }),
        })
        expect(parentResponse.status).toBe(201)

        // Create worker session
        const workerResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'factory-worker-01',
            mode: 'default',
            sessionType: 'stream',
            parentSession: 'commander-parent',
          }),
        })
        expect(workerResponse.status).toBe(201)

        // Worker completes with result, then exits
        workerMock.emitStdout('{"type":"result","result":"done"}\n')
        workerMock.emitExit(0)

        // Immediately after exit: worker should appear as 'done'
        const workersBeforeTTL = await fetch(
          `${server.baseUrl}/api/agents/sessions/commander-parent/workers`,
          { headers: AUTH_HEADERS },
        )
        const beforeList = await workersBeforeTTL.json() as Array<{ name: string; status: string }>
        expect(beforeList.some((w) => w.name === 'factory-worker-01' && w.status === 'done')).toBe(true)

        // Advance past 30-minute TTL
        vi.setSystemTime(new Date('2026-03-05T00:31:00.000Z'))

        // After TTL: worker should be evicted from list (filtered as 'down')
        const workersAfterTTL = await fetch(
          `${server.baseUrl}/api/agents/sessions/commander-parent/workers`,
          { headers: AUTH_HEADERS },
        )
        const afterList = await workersAfterTTL.json() as Array<{ name: string; status: string }>
        expect(afterList.some((w) => w.name === 'factory-worker-01')).toBe(false)
      } finally {
        await server.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('DELETE /sessions/:name/workers/done clears done workers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const baseTime = new Date('2026-03-05T00:00:00.000Z')
      vi.setSystemTime(baseTime)

      const parentMock = createMockChildProcess()
      const workerMock = createMockChildProcess()
      mockedSpawn.mockReturnValueOnce(parentMock.cp as never)
      mockedSpawn.mockReturnValueOnce(workerMock.cp as never)
      const server = await startServer()

      try {
        // Create parent session
        await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'commander-clear-test',
            mode: 'default',
            sessionType: 'stream',
          }),
        })

        // Create worker
        await fetch(`${server.baseUrl}/api/agents/sessions`, {
          method: 'POST',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'factory-worker-clear',
            mode: 'default',
            sessionType: 'stream',
            parentSession: 'commander-clear-test',
          }),
        })

        // Worker exits with result
        workerMock.emitStdout('{"type":"result","result":"done"}\n')
        workerMock.emitExit(0)

        // Verify worker is visible as 'done'
        const beforeClear = await fetch(
          `${server.baseUrl}/api/agents/sessions/commander-clear-test/workers`,
          { headers: AUTH_HEADERS },
        )
        const beforeList = await beforeClear.json() as Array<{ name: string; status: string }>
        expect(beforeList.some((w) => w.name === 'factory-worker-clear' && w.status === 'done')).toBe(true)

        // Clear done workers
        const clearResponse = await fetch(
          `${server.baseUrl}/api/agents/sessions/commander-clear-test/workers/done`,
          { method: 'DELETE', headers: AUTH_HEADERS },
        )
        expect(clearResponse.status).toBe(200)
        const clearPayload = await clearResponse.json() as { cleared: number; workers: Array<{ name: string }> }
        expect(clearPayload.cleared).toBe(1)
        expect(clearPayload.workers.some((w) => w.name === 'factory-worker-clear')).toBe(false)

        // Verify workers endpoint also shows cleared state
        const afterClear = await fetch(
          `${server.baseUrl}/api/agents/sessions/commander-clear-test/workers`,
          { headers: AUTH_HEADERS },
        )
        const afterList = await afterClear.json() as Array<{ name: string }>
        expect(afterList.some((w) => w.name === 'factory-worker-clear')).toBe(false)
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
      'unset CLAUDECODE && claude --permission-mode acceptEdits\r',
    )

    await server.close()
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

  it('does not count completed factory workers against the max tracked sessions limit', async () => {
    const firstMock = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(firstMock.cp as never)
    mockedSpawn.mockImplementation(() => createMockChildProcess().cp as never)
    const server = await startServer({ maxSessions: 1 })

    const firstResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'factory-feat-limit-1',
        mode: 'default',
        sessionType: 'stream',
        task: '/legion-investigate test',
      }),
    })
    expect(firstResponse.status).toBe(201)

    firstMock.emitStdout('{"type":"result","subtype":"success","result":"done"}\n')

    await vi.waitFor(async () => {
      const statusResponse = await fetch(`${server.baseUrl}/api/agents/sessions/factory-feat-limit-1`, {
        headers: AUTH_HEADERS,
      })
      expect(statusResponse.status).toBe(200)
      const payload = await statusResponse.json() as { completed: boolean; status: string }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
    })

    const secondResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent-limit-after-factory-complete',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    expect(secondResponse.status).toBe(201)

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
      'unset CLAUDECODE && claude --dangerously-skip-permissions\r',
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
function createMockChildProcess(pid: number = process.pid) {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stdinChunks: string[] = []
  const stdinEmitter = new EventEmitter()

  const stdout = Object.assign(stdoutEmitter, {
    // Provide enough of the Readable interface for the routes code
    pipe: vi.fn(),
    on: stdoutEmitter.on.bind(stdoutEmitter),
  })

  const stdin = Object.assign(stdinEmitter, {
    writable: true,
    write: vi.fn((data: string) => {
      stdinChunks.push(data)
      return true
    }),
    on: stdinEmitter.on.bind(stdinEmitter),
    once: stdinEmitter.once.bind(stdinEmitter),
  })

  // Build a mock ChildProcess with the EventEmitter cast pattern used by routes.ts
  const cp = Object.assign(emitter, {
    pid,
    stdout,
    stdin,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    // For stdinChunks inspection in tests
    _stdinChunks: stdinChunks,
  })

  return {
    cp,
    emitStdout(data: string) {
      stdoutEmitter.emit('data', Buffer.from(data))
    },
    emitStdoutEnd() {
      stdoutEmitter.emit('end')
    },
    emitExit(code: number, signal: string | null = null) {
      emitter.emit('exit', code, signal)
    },
    emitError(err: Error) {
      emitter.emit('error', err)
    },
    getStdinWrites(): string[] {
      return stdinChunks
    },
  }
}

describe('stream sessions', () => {
  function installMockCodexSidecar() {
    const turnStartInputs: string[] = []
    const requests: Array<{ method: string; params: unknown }> = []
    const turnScripts: Array<{
      error?: string
      notifications?: Array<{ method: string; params: Record<string, unknown> }>
    }> = []
    const sidecarEmitter = new EventEmitter()
    const sidecarProcess = Object.assign(sidecarEmitter, {
      pid: process.pid,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
    })
    let sidecarServer: WebSocketServer | null = null

    mockedSpawn.mockImplementation((command, args) => {
      if (command === 'codex' && args[0] === 'app-server' && args[1] === '--listen') {
        const listenTarget = args[2]
        const match = typeof listenTarget === 'string' ? listenTarget.match(/:(\d+)$/) : null
        if (!match) {
          throw new Error('Missing codex sidecar listen port')
        }
        const port = Number(match[1])
        sidecarServer = new WebSocketServer({ host: '127.0.0.1', port })
        sidecarServer.on('connection', (socket) => {
          socket.on('message', (data) => {
            const raw = JSON.parse(data.toString()) as {
              id?: number
              method?: string
              params?: unknown
            }
            if (typeof raw.id !== 'number' || typeof raw.method !== 'string') {
              return
            }
            requests.push({ method: raw.method, params: raw.params })

            if (raw.method === 'thread/start') {
              socket.send(JSON.stringify({ id: raw.id, result: { thread: { id: 'thread-test' } } }))
              return
            }

            if (raw.method === 'turn/start') {
              const params = (raw.params && typeof raw.params === 'object')
                ? raw.params as { input?: Array<{ text?: unknown }>; threadId?: unknown }
                : {}
              const textValue = Array.isArray(params.input)
                && params.input.length > 0
                && typeof params.input[0]?.text === 'string'
                ? params.input[0].text
                : ''
              const threadId = typeof params.threadId === 'string' ? params.threadId : 'thread-test'
              turnStartInputs.push(textValue)
              const script = turnScripts.shift()
              if (script?.error) {
                socket.send(JSON.stringify({ id: raw.id, error: { message: script.error } }))
                return
              }
              socket.send(JSON.stringify({ id: raw.id, result: { turn: { id: `turn-${turnStartInputs.length}` } } }))
              for (const notification of script?.notifications ?? []) {
                socket.send(JSON.stringify({
                  method: notification.method,
                  params: {
                    threadId,
                    ...notification.params,
                  },
                }))
              }
              return
            }

            socket.send(JSON.stringify({ id: raw.id, result: {} }))
          })
        })
        return sidecarProcess as never
      }

      return createMockChildProcess().cp as never
    })

    return {
      turnStartInputs,
      requests,
      queueTurnScript: (script: {
        error?: string
        notifications?: Array<{ method: string; params: Record<string, unknown> }>
      }) => {
        turnScripts.push(script)
      },
      close: async () => {
        if (!sidecarServer) {
          return
        }
        for (const client of sidecarServer.clients) {
          client.close()
        }
        await new Promise<void>((resolve, reject) => {
          sidecarServer!.close((error) => {
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
      ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-6'],
      expect.objectContaining({
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

  it('appends commander stream events to JSONL transcript', async () => {
    const mock = installMockProcess()
    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-commander-jsonl-'))
    const commanderDataDir = join(workDir, 'commanders-data')
    let server: RunningServer | null = null

    try {
      server = await startServer({
        commanderSessionStorePath: join(commanderDataDir, 'sessions.json'),
      })

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
        commanderDataDir,
        'alpha',
        'sessions',
        'claude-commander-123.jsonl',
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
      })
    } finally {
      if (server) {
        await server.close()
      }
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('auto-rotates commander stream sessions after the configured entry threshold', async () => {
    const processMocks: Array<ReturnType<typeof createMockChildProcess>> = []
    mockedSpawn.mockImplementation(() => {
      const mock = createMockChildProcess()
      processMocks.push(mock)
      return mock.cp as never
    })

    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-commander-rotate-'))
    const commanderDataDir = join(workDir, 'commanders-data')
    const sessionStorePath = join(workDir, 'stream-sessions.json')
    let server: RunningServer | null = null

    try {
      await seedCommanderSessionFixture({
        commanderDataDir,
        commanderId: 'alpha',
        workflowPrompt: 'Commander Alpha workflow prompt',
        identityBody: 'Commander Alpha identity body.',
      })

      server = await startServer({
        autoRotateEntryThreshold: 1,
        commanderSessionStorePath: join(commanderDataDir, 'sessions.json'),
        sessionStorePath,
      })

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
      expect(processMocks).toHaveLength(1)

      const ws = await connectWs(server.baseUrl, 'commander-alpha')
      const streamedEvents: Array<Record<string, unknown>> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>
        if (parsed.type !== 'replay') {
          streamedEvents.push(parsed)
        }
      })

      processMocks[0].emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')
      processMocks[0].emitStdout('{"type":"system","subtype":"init","session_id":"claude-rotate-old"}\n')
      processMocks[0].emitStdout('{"type":"result","result":"turn-1 done"}\n')

      await vi.waitFor(() => {
        expect(processMocks).toHaveLength(2)
      })

      await vi.waitFor(() => {
        expect(streamedEvents.some((event) => (
          event.type === 'system' && event.subtype === 'session_rotated'
        ))).toBe(true)
      })

      processMocks[1].emitStdout('{"type":"system","subtype":"init","session_id":"claude-rotate-new"}\n')

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; claudeSessionId?: string; conversationEntryCount?: number }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'commander-alpha')
        expect(saved?.claudeSessionId).toBe('claude-rotate-new')
        expect(saved?.conversationEntryCount).toBe(0)
      })

      const oldTranscriptPath = join(
        commanderDataDir,
        'alpha',
        'sessions',
        'claude-rotate-old.jsonl',
      )
      const newTranscriptPath = join(
        commanderDataDir,
        'alpha',
        'sessions',
        'claude-rotate-new.jsonl',
      )

      await vi.waitFor(async () => {
        const raw = await readFile(oldTranscriptPath, 'utf8')
        const events = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(events.some((event) => event.subtype === 'session_rotated')).toBe(true)
      })

      await vi.waitFor(async () => {
        const raw = await readFile(newTranscriptPath, 'utf8')
        const events = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(events).toEqual([
          { type: 'system', subtype: 'init', session_id: 'claude-rotate-new' },
        ])
      })

      const claudeSpawnCalls = mockedSpawn.mock.calls.filter(([command]) => command === 'claude')
      expect(claudeSpawnCalls).toHaveLength(2)
      expect(claudeSpawnCalls[1][1]).not.toContain('--resume')
      expect(claudeSpawnCalls[1][1]).not.toContain('--max-turns')
      expect(claudeSpawnCalls[1][1]).toContain('--system-prompt')
      const promptArgIndex = claudeSpawnCalls[1][1].indexOf('--system-prompt')
      const rotatedPrompt = claudeSpawnCalls[1][1][promptArgIndex + 1]
      expect(rotatedPrompt).toContain('Commander Alpha workflow prompt')
      expect(rotatedPrompt).toContain('Commander Alpha identity body.')

      await vi.waitFor(() => {
        expect(processMocks[1].getStdinWrites().some((write) => (
          write.includes('Session rotated. Continuing as commander.')
        ))).toBe(true)
      })

      ws.close()
    } finally {
      if (server) {
        await server.close()
      }
      await rm(workDir, { recursive: true, force: true })
    }
  }, 15000)

  it('respects COMMANDER_DATA_DIR and avoids repo-local commander transcript writes', async () => {
    const mock = installMockProcess()
    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-commander-jsonl-env-'))
    const commanderDataDir = join(workDir, 'external-commander-root')
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir)
    const originalCommanderDataDir = process.env.COMMANDER_DATA_DIR
    let server: RunningServer | null = null

    try {
      process.env.COMMANDER_DATA_DIR = commanderDataDir
      server = await startServer({ commanderSessionStorePath: undefined })

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

      const event = { type: 'system', subtype: 'init', session_id: 'claude-commander-env-123' }
      mock.emitStdout(`${JSON.stringify(event)}\n`)

      const expectedTranscriptPath = join(
        commanderDataDir,
        'alpha',
        'sessions',
        'claude-commander-env-123.jsonl',
      )
      const leakedRepoLocalTranscriptPath = join(
        workDir,
        'data',
        'commanders',
        'alpha',
        'sessions',
        'claude-commander-env-123.jsonl',
      )

      await vi.waitFor(async () => {
        const raw = await readFile(expectedTranscriptPath, 'utf8')
        const parsed = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(parsed).toEqual([event])
      })

      await expect(readFile(leakedRepoLocalTranscriptPath, 'utf8')).rejects.toThrow()
    } finally {
      if (server) {
        await server.close()
      }
      if (originalCommanderDataDir === undefined) {
        delete process.env.COMMANDER_DATA_DIR
      } else {
        process.env.COMMANDER_DATA_DIR = originalCommanderDataDir
      }
      cwdSpy.mockRestore()
      await rm(workDir, { recursive: true, force: true })
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

  it('reports factory stream sessions as completed after result without waiting for exit', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'factory-feat-result-only',
        mode: 'default',
        sessionType: 'stream',
        task: '/legion-investigate test',
      }),
    })
    expect(createResponse.status).toBe(201)

    mock.emitStdout('{"type":"result","subtype":"success","result":"investigation complete","total_cost_usd":0.21}\n')

    await vi.waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions/factory-feat-result-only`, {
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
        finalComment: 'investigation complete',
        costUsd: 0.21,
      })
    })

    const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    expect(listResponse.status).toBe(200)
    const listed = await listResponse.json() as Array<{ name: string }>
    expect(listed.some((session) => session.name === 'factory-feat-result-only')).toBe(false)
    expect(mock.cp.kill).not.toHaveBeenCalled()

    await server.close()
  })

  it('does not reset command-room completion when message_start arrives after result', async () => {
    // Regression test: newer Claude CLI may emit message_start after the result
    // event. Completion state must survive that so the executor can detect it.
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'command-room-msg-start-after-result',
        mode: 'default',
        sessionType: 'stream',
        task: 'test',
      }),
    })

    // Emit result then a spurious message_start (as newer CLI may do).
    mock.emitStdout('{"type":"result","subtype":"success","result":"done","total_cost_usd":0.05}\n')
    mock.emitStdout('{"type":"message_start","message":{"id":"m2","role":"assistant"}}\n')

    await vi.waitFor(async () => {
      const response = await fetch(
        `${server.baseUrl}/api/agents/sessions/command-room-msg-start-after-result`,
        { headers: AUTH_HEADERS },
      )
      expect(response.status).toBe(200)
      const payload = await response.json() as { completed: boolean; status: string }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
    })

    await server.close()
  })

  it('flushes stdout buffer on end event so result is detected without trailing newline', async () => {
    // Regression test: if the result JSON line arrives without a trailing '\n',
    // it stays in stdoutBuffer. The end handler must flush it before exit fires.
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'command-room-no-newline',
        mode: 'default',
        sessionType: 'stream',
        task: 'test',
      }),
    })

    // Emit result without trailing newline so it stays in stdoutBuffer.
    mock.emitStdout('{"type":"result","subtype":"success","result":"flushed","total_cost_usd":0.01}')
    // Trigger end — routes should flush the buffer.
    mock.emitStdoutEnd()

    await vi.waitFor(async () => {
      const response = await fetch(
        `${server.baseUrl}/api/agents/sessions/command-room-no-newline`,
        { headers: AUTH_HEADERS },
      )
      expect(response.status).toBe(200)
      const payload = await response.json() as { completed: boolean; status: string; result?: { finalComment: string } }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
      expect(payload.result?.finalComment).toBe('flushed')
    })

    await server.close()
  })

  it('adds synthetic completion for command-room sessions on DELETE so executor detects termination', async () => {
    // Regression test: if a command-room session is deleted while the executor
    // is monitoring it, the executor must get { completed: true } on the next
    // poll rather than a 404 that would eventually time out.
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'command-room-delete-test',
        mode: 'default',
        sessionType: 'stream',
        task: 'test',
      }),
    })

    // Session is mid-run (no result yet). Delete it via the API.
    const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/command-room-delete-test`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    })
    expect(deleteResponse.status).toBe(200)

    // Subsequent poll must return completed (not 404) so the executor does not
    // time out.
    const statusResponse = await fetch(
      `${server.baseUrl}/api/agents/sessions/command-room-delete-test`,
      { headers: AUTH_HEADERS },
    )
    expect(statusResponse.status).toBe(200)
    const payload = await statusResponse.json() as { completed: boolean; status: string }
    expect(payload.completed).toBe(true)

    expect(mock.cp.kill).toHaveBeenCalled()
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
      await waitForPersistedSessionFlush()
      await rm(sessionStoreDir, { recursive: true, force: true })
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
        const activeServer = secondServer
        expect(activeServer).not.toBeNull()
        if (!activeServer) {
          throw new Error('Expected restart server to be available')
        }
        const response = await fetch(`${activeServer.baseUrl}/api/agents/sessions`, {
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
      await waitForPersistedSessionFlush()
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('persists and reuses codex thread ids for commander bridge restart flow', async () => {
    const codexSidecar = installMockCodexSidecar()
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    let server: RunningServer | null = null

    try {
      server = await startServer({ sessionStorePath })

      await server.sessionsInterface.createCommanderSession({
        name: 'commander-codex-bridge',
        systemPrompt: 'Commander system prompt',
        agentType: 'codex',
      })
      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['Commander system prompt'])
      })

      let persistedThreadId = ''
      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; agentType?: string; codexThreadId?: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'commander-codex-bridge')
        expect(saved?.agentType).toBe('codex')
        expect(saved?.codexThreadId).toBe('thread-test')
        persistedThreadId = saved?.codexThreadId ?? ''
      })

      expect(persistedThreadId).toBe('thread-test')
      server.sessionsInterface.deleteSession('commander-codex-bridge')
      await server.sessionsInterface.createCommanderSession({
        name: 'commander-codex-bridge',
        systemPrompt: 'Commander system prompt',
        agentType: 'codex',
        resumeCodexThreadId: persistedThreadId,
      })

      const restored = server.sessionsInterface.getSession('commander-codex-bridge')
      expect(restored?.agentType).toBe('codex')
      expect(restored?.codexThreadId).toBe('thread-test')
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25)
      })
      expect(codexSidecar.turnStartInputs).toEqual(['Commander system prompt'])

      const threadStartRequests = codexSidecar.requests.filter((request) => request.method === 'thread/start')
      expect(threadStartRequests).toHaveLength(1)
    } finally {
      if (server) {
        await server.close()
      }
      await waitForPersistedSessionFlush()
      await codexSidecar.close()
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
      await waitForPersistedSessionFlush()
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
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )
      const sshArgs = mockedSpawn.mock.calls[0][1]
      expect(sshArgs[sshArgs.length - 1]).toContain("cd '/home/ec2-user/workspace'")
      expect(sshArgs[sshArgs.length - 1]).toContain('$SHELL -lic')
      expect(sshArgs[sshArgs.length - 1]).toContain('claude')
    } finally {
      await server.close()
      await registry.cleanup()
    }
  })

  it('rejects remote codex stream sessions with clear error', async () => {
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
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Remote stream sessions are currently supported for claude only',
      })
      expect(mockedSpawn).not.toHaveBeenCalled()
    } finally {
      await server.close()
      await registry.cleanup()
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
    expect(sessions[0].pid).toBe(process.pid)

    await server.close()
  })

  it('includes processAlive=true for live stream sessions in /sessions list', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-process-alive',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const response = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const sessions = (await response.json()) as Array<{ name: string; processAlive?: boolean }>
    const listed = sessions.find((session) => session.name === 'stream-process-alive')

    expect(listed).toBeDefined()
    expect(listed?.processAlive).toBe(true)

    await server.close()
  })

  it('keeps dead non-one-shot stream sessions in /sessions list with processAlive=false', async () => {
    installMockProcess({ pid: 99999 })
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-dead-prune',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const listed = await listResponse.json() as Array<{ name: string; processAlive?: boolean }>
    const deadStream = listed.find((session) => session.name === 'stream-dead-prune')
    expect(deadStream).toBeDefined()
    expect(deadStream?.processAlive).toBe(false)

    const statusResponse = await fetch(`${server.baseUrl}/api/agents/sessions/stream-dead-prune`, {
      headers: AUTH_HEADERS,
    })
    expect(statusResponse.status).toBe(200)

    await server.close()
  })

  it('keeps alive parent sessions with all workers done and reports done summary', async () => {
    installMockProcess()
    const server = await startServer()
    const parentSessionName = 'commander-parent-workers-done'
    const workerSessionName = 'factory-parent-done-worker'

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: parentSessionName,
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const parentSession = server.sessionsInterface.getSession(parentSessionName)
    expect(parentSession).toBeDefined()
    parentSession?.spawnedWorkers.push(workerSessionName)

    const completeResponse = await fetch(
      `${server.baseUrl}/api/agents/sessions/${encodeURIComponent(workerSessionName)}/complete`,
      {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'success', comment: 'done' }),
      },
    )
    expect(completeResponse.status).toBe(200)

    const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const listed = await listResponse.json() as Array<{
      name: string
      processAlive?: boolean
      workerSummary?: {
        total: number
        running: number
        starting: number
        down: number
        done: number
      }
    }>
    const parent = listed.find((session) => session.name === parentSessionName)

    expect(parent).toBeDefined()
    expect(parent?.processAlive).toBe(true)
    expect(parent?.workerSummary).toEqual({
      total: 1,
      running: 0,
      starting: 0,
      down: 0,
      done: 1,
    })

    await server.close()
  })

  it('filters dead parent sessions whose spawned workers are all done', async () => {
    installMockProcess({ pid: 99999 })
    const server = await startServer()
    const parentSessionName = 'commander-parent-workers-done-dead'
    const workerSessionName = 'factory-parent-dead-worker'

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: parentSessionName,
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const parentSession = server.sessionsInterface.getSession(parentSessionName)
    expect(parentSession).toBeDefined()
    parentSession?.spawnedWorkers.push(workerSessionName)

    const completeResponse = await fetch(
      `${server.baseUrl}/api/agents/sessions/${encodeURIComponent(workerSessionName)}/complete`,
      {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'success', comment: 'done' }),
      },
    )
    expect(completeResponse.status).toBe(200)

    const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      headers: AUTH_HEADERS,
    })
    const listed = await listResponse.json() as Array<{ name: string }>
    expect(listed.some((session) => session.name === parentSessionName)).toBe(false)

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
      ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-6', '--permission-mode', 'acceptEdits'],
      expect.any(Object),
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
      ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-6', '--dangerously-skip-permissions'],
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

  it('does not duplicate user messages in replay when Claude echoes them back', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-no-dup',
        mode: 'default',
        sessionType: 'stream',
      }),
    })

    const ws = await connectWs(server.baseUrl, 'stream-no-dup')

    // Send user input — server synthesizes a 'user' event in session.events
    ws.send(JSON.stringify({ type: 'input', text: 'Hello agent' }))
    await new Promise((r) => setTimeout(r, 50))

    // Claude's stdout echoes the user message back as a 'user' envelope event.
    // The fix should skip this so session.events doesn't store a duplicate.
    mock.emitStdout('{"type":"user","message":{"role":"user","content":"Hello agent"}}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}\n')
    await new Promise((r) => setTimeout(r, 50))

    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))

    // Reconnect and check replay — should have exactly one user event
    const ws2Url = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-no-dup/terminal?api_key=test-key'
    const ws2 = new WebSocket(ws2Url)
    const messages: Array<{ type: string; events?: Array<{ type: string }> }> = []

    ws2.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    await new Promise<void>((resolve, reject) => {
      ws2.on('open', () => resolve())
      ws2.on('error', reject)
    })

    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0)
    })

    const replay = messages.find((m) => m.type === 'replay')
    expect(replay).toBeDefined()
    const userEvents = replay!.events!.filter((e) => e.type === 'user')
    expect(userEvents).toHaveLength(1)

    ws2.close()
    await server.close()
  })

  it('persists initial task as user event in replay', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'stream-task-replay',
        mode: 'default',
        sessionType: 'stream',
        task: 'Explain auth flow',
      }),
    })

    // Wait for the initial task to be written to stdin and stored
    await new Promise((r) => setTimeout(r, 50))

    // Attach message handler BEFORE open to catch the replay sent on upgrade
    const wsUrl = server.baseUrl.replace('http://', 'ws://') +
      '/api/agents/sessions/stream-task-replay/terminal?api_key=test-key'
    const ws = new WebSocket(wsUrl)
    const messages: Array<{
      type: string
      events?: Array<{ type: string; message?: { content: string } }>
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
    const userEvents = replay!.events!.filter((e) => e.type === 'user')
    expect(userEvents).toHaveLength(1)
    expect(userEvents[0].message?.content).toBe('Explain auth flow')

    ws.close()
    await server.close()
  })

  it('accepts message body shape on POST /sessions/:name/send', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    try {
      await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-send-message-shape',
          mode: 'default',
          sessionType: 'stream',
        }),
      })

      const response = await fetch(`${server.baseUrl}/api/agents/sessions/stream-send-message-shape/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'send route message field' }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ sent: true })
      expect(mock.getStdinWrites().some((write) => write.includes('send route message field'))).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('queues HTTP /message requests and flushes FIFO by turn completion', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    try {
      await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-http-queue',
          mode: 'default',
          sessionType: 'stream',
        }),
      })

      // Block queue dispatch until result is emitted.
      mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

      const first = await fetch(`${server.baseUrl}/api/agents/sessions/stream-http-queue/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'first queued message' }),
      })
      expect(first.status).toBe(202)
      expect(await first.json()).toEqual({ queued: true, queueDepth: 1 })

      const second = await fetch(`${server.baseUrl}/api/agents/sessions/stream-http-queue/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'second queued message' }),
      })
      expect(second.status).toBe(202)
      expect(await second.json()).toEqual({ queued: true, queueDepth: 2 })

      expect(mock.getStdinWrites().some((write) => write.includes('queued message'))).toBe(false)

      mock.emitStdout('{"type":"result","result":"done"}\n')
      await vi.waitFor(() => {
        expect(mock.getStdinWrites().filter((write) => write.includes('queued message'))).toHaveLength(1)
      })
      expect(mock.getStdinWrites().some((write) => write.includes('second queued message'))).toBe(false)

      mock.emitStdout('{"type":"result","result":"done"}\n')
      await vi.waitFor(() => {
        expect(mock.getStdinWrites().filter((write) => write.includes('queued message'))).toHaveLength(2)
      })

      const queuedWrites = mock
        .getStdinWrites()
        .filter((write) => write.includes('queued message'))
        .map((write) => JSON.parse(write.replace('\n', '')) as { message: { content: string } })
        .map((payload) => payload.message.content)
      expect(queuedWrites).toEqual(['first queued message', 'second queued message'])
    } finally {
      await server.close()
    }
  })

  it('resets commander stream sessions in place via HTTP /message /reset', async () => {
    const processMocks: Array<ReturnType<typeof createMockChildProcess>> = []
    mockedSpawn.mockImplementation(() => {
      const mock = createMockChildProcess()
      processMocks.push(mock)
      return mock.cp as never
    })
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-stream-session-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const commanderDataDir = join(sessionStoreDir, 'commanders-data')
    await seedCommanderSessionFixture({
      commanderDataDir,
      commanderId: 'reset-test',
      workflowPrompt: 'Reset workflow prompt from COMMANDER.md',
      identityBody: 'Reset identity body from identity.md.',
    })
    const server = await startServer({
      sessionStorePath,
      commanderSessionStorePath: join(commanderDataDir, 'sessions.json'),
    })

    try {
      await server.sessionsInterface.createCommanderSession({
        name: 'commander-reset-test',
        systemPrompt: 'Old commander prompt',
        agentType: 'claude',
        cwd: '/tmp',
        maxTurns: 7,
      })
      expect(processMocks).toHaveLength(1)

      processMocks[0].emitStdout('{"type":"system","subtype":"init","session_id":"claude-reset-old"}\n')

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; claudeSessionId?: string }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'commander-reset-test')
        expect(saved?.claudeSessionId).toBe('claude-reset-old')
      })

      // Keep turn active so /reset must wait for completion before clearing.
      processMocks[0].emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

      let resetSettled = false
      const resetPromise = fetch(`${server.baseUrl}/api/agents/sessions/commander-reset-test/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '/reset' }),
      }).then(async (response) => {
        resetSettled = true
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ reset: true })
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resetSettled).toBe(false)

      processMocks[0].emitStdout('{"type":"result","result":"done"}\n')
      await resetPromise
      expect(processMocks).toHaveLength(2)
      expect(processMocks[0].cp.kill).toHaveBeenCalledWith('SIGTERM')

      const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionsResponse.status).toBe(200)
      const listedSessions = await sessionsResponse.json() as Array<{ name: string }>
      expect(listedSessions.some((session) => session.name === 'commander-reset-test')).toBe(true)

      const secondCall = mockedSpawn.mock.calls[1]
      expect(secondCall[0]).toBe('claude')
      const secondArgs = secondCall[1] as string[]
      expect(secondArgs).toContain('--system-prompt')
      expect(secondArgs).not.toContain('--resume')
      expect(secondArgs).not.toContain('--max-turns')
      const promptIndex = secondArgs.indexOf('--system-prompt')
      const resetPrompt = secondArgs[promptIndex + 1]
      expect(resetPrompt).toContain('Reset workflow prompt from COMMANDER.md')
      expect(resetPrompt).toContain('Reset identity body from identity.md.')
      expect(resetPrompt).not.toBe('Old commander prompt')

      await vi.waitFor(() => {
        expect(processMocks[1].getStdinWrites().some((write) => (
          write.includes('Session rotated. Continuing as commander.')
        ))).toBe(true)
      })

      const followUpResponse = await fetch(`${server.baseUrl}/api/agents/sessions/commander-reset-test/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'message after reset' }),
      })
      expect(followUpResponse.status).toBe(202)
      expect(await followUpResponse.json()).toEqual({ queued: true, queueDepth: 1 })

      await vi.waitFor(() => {
        expect(processMocks[1].getStdinWrites().some((write) => write.includes('message after reset'))).toBe(true)
      })
      expect(processMocks[0].getStdinWrites().some((write) => write.includes('message after reset'))).toBe(false)
    } finally {
      await server.close()
      await waitForPersistedSessionFlush()
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  })

  it('passes /reset through to non-commander stream sessions', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-reset-pass-through',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      const messageResponse = await fetch(`${server.baseUrl}/api/agents/sessions/stream-reset-pass-through/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: '/reset' }),
      })

      expect(messageResponse.status).toBe(202)
      expect(await messageResponse.json()).toEqual({ queued: true, queueDepth: 1 })

      await vi.waitFor(() => {
        expect(mock.getStdinWrites().some((write) => write.includes('/reset'))).toBe(true)
      })

      const resetWrite = mock.getStdinWrites().find((write) => write.includes('/reset'))
      expect(resetWrite).toBeDefined()
      const parsed = JSON.parse(resetWrite!.replace('\n', '')) as { message: { content: string } }
      expect(parsed.message.content).toBe('/reset')
    } finally {
      await server.close()
    }
  })

  it('returns 429 when HTTP /message queue reaches max depth', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    try {
      await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'stream-queue-overflow',
          mode: 'default',
          sessionType: 'stream',
        }),
      })

      // Hold queue processing so pending count grows.
      mock.emitStdout('{"type":"message_start","message":{"id":"m1","role":"assistant"}}\n')

      for (let i = 0; i < 50; i += 1) {
        const response = await fetch(`${server.baseUrl}/api/agents/sessions/stream-queue-overflow/message`, {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ message: `queued ${i}` }),
        })
        expect(response.status).toBe(202)
      }

      const overflowResponse = await fetch(`${server.baseUrl}/api/agents/sessions/stream-queue-overflow/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'overflow' }),
      })

      expect(overflowResponse.status).toBe(429)
      expect(await overflowResponse.json()).toEqual({ error: 'Queue full' })
    } finally {
      await server.close()
    }
  })

  it('routes HTTP /message through codex turn/start for codex sessions', async () => {
    const codexSidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-http-message',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })

      expect(createResponse.status).toBe(201)

      const messageResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-http-message/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'codex queued input' }),
      })

      expect(messageResponse.status).toBe(202)
      expect(await messageResponse.json()).toEqual({ queued: true, queueDepth: 1 })

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['codex queued input'])
      })
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  })

  it('auto-rotates non-commander codex sessions at the entry threshold', async () => {
    const codexSidecar = installMockCodexSidecar()
    const sessionStoreDir = await mkdtemp(join(tmpdir(), 'hammurabi-codex-rotate-store-'))
    const sessionStorePath = join(sessionStoreDir, 'stream-sessions.json')
    const server = await startServer({
      autoRotateEntryThreshold: 1,
      sessionStorePath,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-auto-rotate',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-auto-rotate')
      const streamedEvents: Array<Record<string, unknown>> = []
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>
        if (parsed.type !== 'replay') {
          streamedEvents.push(parsed)
        }
      })

      codexSidecar.queueTurnScript({
        notifications: [
          {
            method: 'turn/started',
            params: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
          },
          {
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
          },
        ],
      })

      const firstMessageResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-auto-rotate/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'first codex turn' }),
      })
      expect(firstMessageResponse.status).toBe(202)

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['first codex turn'])
      })

      await vi.waitFor(() => {
        const threadStarts = codexSidecar.requests.filter((request) => request.method === 'thread/start')
        expect(threadStarts.length).toBeGreaterThanOrEqual(2)
      })

      await vi.waitFor(() => {
        expect(streamedEvents.some((event) => (
          event.type === 'system' && event.subtype === 'session_rotated'
        ))).toBe(true)
      })

      await vi.waitFor(async () => {
        const raw = await readFile(sessionStorePath, 'utf8')
        const parsed = JSON.parse(raw) as {
          sessions: Array<{ name: string; conversationEntryCount?: number }>
        }
        const saved = parsed.sessions.find((session) => session.name === 'codex-auto-rotate')
        expect(saved?.conversationEntryCount).toBe(0)
      })

      codexSidecar.queueTurnScript({})
      const secondMessageResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-auto-rotate/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'second codex turn' }),
      })
      expect(secondMessageResponse.status).toBe(202)

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['first codex turn', 'second codex turn'])
      })

      const sessionsResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      expect(sessionsResponse.status).toBe(200)
      const listed = await sessionsResponse.json() as Array<{ name: string }>
      expect(listed.filter((session) => session.name === 'codex-auto-rotate')).toHaveLength(1)

      ws.close()
    } finally {
      await server.close()
      await codexSidecar.close()
      await rm(sessionStoreDir, { recursive: true, force: true })
    }
  }, 15000)

  it('pre-kill-debrief returns immediately and debrief-status tracks completion for Codex stream session', async () => {
    const codexSidecar = installMockCodexSidecar()
    codexSidecar.queueTurnScript({
      notifications: [
        {
          method: 'turn/started',
          params: { turn: { id: 'turn-debrief', status: 'inProgress', items: [] } },
        },
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-debrief', status: 'completed', items: [] } },
        },
      ],
    })
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-kill-debrief',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const preResp = await fetch(`${server.baseUrl}/api/agents/sessions/codex-kill-debrief/pre-kill-debrief`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(preResp.status).toBe(200)
      const preJson = await preResp.json()
      expect(preJson).toMatchObject({ debriefStarted: true, timeoutMs: 60000 })

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['$debrief hotwash'])
      })

      await vi.waitFor(async () => {
        const statusResp = await fetch(`${server.baseUrl}/api/agents/sessions/codex-kill-debrief/debrief-status`, {
          headers: AUTH_HEADERS,
        })
        const { status } = await statusResp.json()
        expect(status).toBe('completed')
      })

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-kill-debrief`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)
      expect(await deleteResponse.json()).toEqual({ killed: true })
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  })

  it('streams Codex text deltas, avoids duplicate user echoes, and tracks usage', async () => {
    const codexSidecar = installMockCodexSidecar()
    codexSidecar.queueTurnScript({
      notifications: [
        {
          method: 'turn/started',
          params: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
        },
        {
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: 'research please' }],
            },
          },
        },
        {
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: { id: 'assistant-1', type: 'agentMessage', text: '' },
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: { turnId: 'turn-1', itemId: 'assistant-1', delta: 'Hello ' },
        },
        {
          method: 'item/agentMessage/delta',
          params: { turnId: 'turn-1', itemId: 'assistant-1', delta: 'world' },
        },
        {
          method: 'item/completed',
          params: {
            turnId: 'turn-1',
            item: { id: 'assistant-1', type: 'agentMessage', text: 'Hello world' },
          },
        },
        {
          method: 'thread/tokenUsage/updated',
          params: {
            turnId: 'turn-1',
            tokenUsage: {
              last: {
                cachedInputTokens: 0,
                inputTokens: 13,
                outputTokens: 34,
                reasoningOutputTokens: 0,
                totalTokens: 47,
              },
              total: {
                cachedInputTokens: 0,
                inputTokens: 13,
                outputTokens: 34,
                reasoningOutputTokens: 0,
                totalTokens: 47,
              },
            },
          },
        },
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
        },
      ],
    })
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-stream-live',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-stream-live')
      const messages: Array<Record<string, unknown>> = []
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      })

      ws.send(JSON.stringify({ type: 'input', text: 'research please' }))

      await vi.waitFor(() => {
        expect(messages.some((message) => message.type === 'result')).toBe(true)
      })

      expect(codexSidecar.turnStartInputs).toEqual(['research please'])

      const userMessages = messages.filter((message) => {
        if (message.type !== 'user') return false
        const payload = message.message as { content?: unknown } | undefined
        return payload?.content === 'research please'
      })
      expect(userMessages).toHaveLength(1)

      expect(messages.some((message) => message.type === 'content_block_start')).toBe(true)
      const streamedText = messages
        .filter((message) => message.type === 'content_block_delta')
        .map((message) => {
          const delta = message.delta as { text?: string } | undefined
          return delta?.text ?? ''
        })
        .join('')
      expect(streamedText).toBe('Hello world')
      expect(messages.some((message) => message.type === 'content_block_stop')).toBe(true)

      const usageEvent = messages.find((message) => {
        if (message.type !== 'message_delta') return false
        const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined
        return usage?.input_tokens === 13 && usage?.output_tokens === 34
      })
      expect(usageEvent).toBeDefined()

      const replayMessages: Array<{
        type: string
        usage?: { inputTokens: number; outputTokens: number; costUsd: number }
      }> = []
      const replayWsUrl = server.baseUrl.replace('http://', 'ws://') +
        '/api/agents/sessions/codex-stream-live/terminal?api_key=test-key'
      const replayWs = new WebSocket(replayWsUrl)
      replayWs.on('message', (data) => {
        replayMessages.push(JSON.parse(data.toString()) as {
          type: string
          usage?: { inputTokens: number; outputTokens: number; costUsd: number }
        })
      })
      await new Promise<void>((resolve, reject) => {
        replayWs.on('open', () => resolve())
        replayWs.on('error', reject)
      })

      await vi.waitFor(() => {
        expect(replayMessages.some((message) => message.type === 'replay')).toBe(true)
      })

      const replay = replayMessages.find((message) => message.type === 'replay')
      expect(replay).toBeDefined()
      expect(replay?.usage).toEqual({
        inputTokens: 13,
        outputTokens: 34,
        costUsd: 0,
      })

      ws.close()
      replayWs.close()
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  }, 15000)

  it('does not leave queued Codex /message sends stuck after a turn/start failure', async () => {
    const codexSidecar = installMockCodexSidecar()
    codexSidecar.queueTurnScript({ error: 'sidecar disconnected' })
    codexSidecar.queueTurnScript({
      notifications: [
        {
          method: 'turn/started',
          params: { turn: { id: 'turn-2', status: 'inProgress', items: [] } },
        },
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-2', status: 'completed', items: [] } },
        },
      ],
    })
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-message-retry',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createResponse.status).toBe(201)

      const ws = await connectWs(server.baseUrl, 'codex-message-retry')
      const messages: Array<Record<string, unknown>> = []
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      })

      const firstResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-message-retry/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'first try' }),
      })
      expect(firstResponse.status).toBe(202)

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['first try'])
      })
      await vi.waitFor(() => {
        expect(messages.some((message) => {
          if (message.type !== 'system') return false
          return typeof message.text === 'string' && message.text.includes('Codex request failed')
        })).toBe(true)
      })

      const secondResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-message-retry/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'second try' }),
      })
      expect(secondResponse.status).toBe(202)

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['first try', 'second try'])
      })

      ws.close()
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  })

  it('routes HTTP /message directly to OpenClaw hook dispatch', async () => {
    const originalFetch = globalThis.fetch.bind(globalThis)
    const hookCalls: Array<{ url: string; body: { message?: string } }> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input, init) => {
      const url = typeof input === 'string'
        ? input
        : (input instanceof URL ? input.toString() : input.url)
      if (url === 'http://localhost:18789/hooks/agent') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { message?: string } : {}
        hookCalls.push({ url, body })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return originalFetch(input, init)
    }) as typeof fetch)

    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'openclaw-http-message',
          mode: 'dangerouslySkipPermissions',
          sessionType: 'stream',
          agentType: 'openclaw',
        }),
      })
      expect(createResponse.status).toBe(201)

      const messageResponse = await fetch(`${server.baseUrl}/api/agents/sessions/openclaw-http-message/message`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'openclaw queued input' }),
      })

      expect(messageResponse.status).toBe(202)
      expect(await messageResponse.json()).toEqual({ queued: true, queueDepth: 0 })

      await vi.waitFor(() => {
        expect(hookCalls).toHaveLength(1)
      })
      expect(hookCalls[0].body.message).toBe('openclaw queued input')
    } finally {
      fetchSpy.mockRestore()
      await server.close()
    }
  })

  it('pre-kill-debrief returns unsupported for OpenClaw; DELETE never blocks on debrief', async () => {
    const originalFetch = globalThis.fetch.bind(globalThis)
    const hookCalls: Array<{ url: string; body: { message?: string } }> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((input, init) => {
      const url = typeof input === 'string'
        ? input
        : (input instanceof URL ? input.toString() : input.url)
      if (url === 'http://localhost:18789/hooks/agent') {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { message?: string } : {}
        hookCalls.push({ url, body })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return originalFetch(input, init)
    }) as typeof fetch)

    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'openclaw-kill-no-debrief',
          mode: 'dangerouslySkipPermissions',
          sessionType: 'stream',
          agentType: 'openclaw',
        }),
      })
      expect(createResponse.status).toBe(201)

      const preResp = await fetch(`${server.baseUrl}/api/agents/sessions/openclaw-kill-no-debrief/pre-kill-debrief`, {
        method: 'POST',
        headers: AUTH_HEADERS,
      })
      expect(preResp.status).toBe(200)
      expect(await preResp.json()).toMatchObject({
        debriefed: false,
        reason: 'unsupported-agent-type',
      })
      expect(hookCalls).toHaveLength(0)

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/openclaw-kill-no-debrief`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)
      expect(await deleteResponse.json()).toEqual({ killed: true })
    } finally {
      fetchSpy.mockRestore()
      await server.close()
    }
  })

  it('pre-kill-debrief returns pty-session for PTY sessions without attempting debrief', async () => {
    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'pty-no-debrief',
        mode: 'default',
        sessionType: 'pty',
      }),
    })
    expect(createResponse.status).toBe(201)

    const preResp = await fetch(`${server.baseUrl}/api/agents/sessions/pty-no-debrief/pre-kill-debrief`, {
      method: 'POST',
      headers: AUTH_HEADERS,
    })
    expect(preResp.status).toBe(200)
    expect(await preResp.json()).toEqual({ debriefed: false, reason: 'pty-session' })

    const statusResp = await fetch(`${server.baseUrl}/api/agents/sessions/pty-no-debrief/debrief-status`, {
      headers: AUTH_HEADERS,
    })
    expect((await statusResp.json()).status).toBe('none')

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
      const resp = await fetch(`${server.baseUrl}/api/agents/sessions/command-room-no-clear-test`, {
        headers: AUTH_HEADERS,
      })
      const payload = await resp.json() as { completed: boolean; status?: string }
      expect(payload.completed).toBe(true)
    })

    // Completed command-room sessions should be excluded from /world.
    const worldResp = await fetch(`${server.baseUrl}/api/agents/world`, {
      headers: AUTH_HEADERS,
    })
    const worldPayload = await worldResp.json() as Array<{ id: string }>
    expect(worldPayload.find((e) => e.id === 'command-room-no-clear-test')).toBeUndefined()

    // Send input — command-room sessions should stay completed.
    const ws = await connectWs(server.baseUrl, 'command-room-no-clear-test')
    ws.send(JSON.stringify({ type: 'input', text: 'more input' }))

    // Wait briefly to let the WS message be processed.
    await new Promise((r) => setTimeout(r, 100))

    const resp = await fetch(`${server.baseUrl}/api/agents/sessions/command-room-no-clear-test`, {
      headers: AUTH_HEADERS,
    })
    const payload = await resp.json() as { completed: boolean; status?: string }
    expect(payload.completed).toBe(true)

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
      const sessions = await resp.json()
      expect(sessions).toHaveLength(0)
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
      const sessions = await resp.json()
      expect(sessions).toHaveLength(0)
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

  it('pre-kill-debrief returns immediately and debrief-status tracks completion for Claude stream session', async () => {
    const mock = installMockProcess()
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
      const preJson = await preResp.json()
      expect(preJson).toMatchObject({ debriefStarted: true, timeoutMs: 60000 })

      await vi.waitFor(() => {
        expect(mock.getStdinWrites().some((write) => write.includes('/debrief hotwash'))).toBe(true)
      })

      mock.emitStdout('{"type":"result","subtype":"success","duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"done","session_id":"test-session"}\n')

      await vi.waitFor(async () => {
        const statusResp = await fetch(`${server.baseUrl}/api/agents/sessions/stream-kill-debrief/debrief-status`, {
          headers: AUTH_HEADERS,
        })
        const { status } = await statusResp.json()
        expect(status).toBe('completed')
      })

      const deleteResponse = await fetch(`${server.baseUrl}/api/agents/sessions/stream-kill-debrief`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
      })
      expect(deleteResponse.status).toBe(200)
      expect(await deleteResponse.json()).toEqual({ killed: true })
      expect(mock.cp.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      await server.close()
    }
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
    const sessions = await resp.json()
    expect(sessions).toHaveLength(0)

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

  it('marks factory session as completed on process exit without result', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'factory-feat-123-1234567890',
        mode: 'default',
        sessionType: 'stream',
        task: 'implement feature',
      }),
    })
    expect(createResponse.status).toBe(201)

    // Factory worker exits without emitting result — exit handler should synthesize completion.
    mock.emitExit(0)

    await vi.waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/agents/sessions/factory-feat-123-1234567890`, {
        headers: AUTH_HEADERS,
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        completed: boolean
        status: string
        result?: { status: string; finalComment: string }
      }
      expect(payload.completed).toBe(true)
      expect(payload.status).toBe('success')
      expect(payload.result?.finalComment).toContain('Process exited with code 0')
    })

    await server.close()
  })

  it('marks factory session as completed via POST /sessions/:name/complete', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'factory-fix-456-9876543210',
        mode: 'default',
        sessionType: 'stream',
        task: 'fix bug',
      }),
    })
    expect(createResponse.status).toBe(201)

    // POST completion via the hook endpoint.
    const completeResponse = await fetch(
      `${server.baseUrl}/api/agents/sessions/factory-fix-456-9876543210/complete`,
      {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'success', comment: 'Stop hook fired' }),
      },
    )
    expect(completeResponse.status).toBe(200)
    const completePayload = (await completeResponse.json()) as { name: string; completed: boolean; status: string }
    expect(completePayload.completed).toBe(true)
    expect(completePayload.status).toBe('success')

    expect(mock.cp.kill).toHaveBeenCalledWith('SIGTERM')

    // GET should return completed.
    const getResponse = await fetch(
      `${server.baseUrl}/api/agents/sessions/factory-fix-456-9876543210`,
      { headers: AUTH_HEADERS },
    )
    expect(getResponse.status).toBe(200)
    const getPayload = (await getResponse.json()) as { completed: boolean; status: string }
    expect(getPayload.completed).toBe(true)

    await server.close()
  })

  it('POST /sessions/:name/complete is idempotent', async () => {
    installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'factory-idempotent-789',
        mode: 'default',
        sessionType: 'stream',
        task: 'test',
      }),
    })

    // First complete call.
    const first = await fetch(
      `${server.baseUrl}/api/agents/sessions/factory-idempotent-789/complete`,
      {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'success' }),
      },
    )
    expect(first.status).toBe(200)

    // Second complete call — should succeed without error.
    const second = await fetch(
      `${server.baseUrl}/api/agents/sessions/factory-idempotent-789/complete`,
      {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'success' }),
      },
    )
    expect(second.status).toBe(200)
    const payload = (await second.json()) as { completed: boolean }
    expect(payload.completed).toBe(true)

    await server.close()
  })

  it('POST /sessions/:name/reset rotates commander session with new process', async () => {
    const processMocks: Array<ReturnType<typeof createMockChildProcess>> = []
    mockedSpawn.mockImplementation(() => {
      const mock = createMockChildProcess()
      processMocks.push(mock)
      return mock.cp as never
    })

    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-command-reset-http-'))
    const commanderDataDir = join(workDir, 'commanders-data')
    await seedCommanderSessionFixture({
      commanderDataDir,
      commanderId: 'reset-test',
      workflowPrompt: 'HTTP reset workflow prompt from COMMANDER.md',
      identityBody: 'HTTP reset identity body from identity.md.',
    })
    const server = await startServer({
      commanderSessionStorePath: join(commanderDataDir, 'sessions.json'),
    })

    try {
      await server.sessionsInterface.createCommanderSession({
        name: 'commander-reset-test',
        systemPrompt: 'Stale reset prompt',
        agentType: 'claude',
        cwd: '/tmp',
        maxTurns: 9,
      })
      expect(processMocks).toHaveLength(1)

      // Emit a result so the session is in a completed-turn state.
      processMocks[0].emitStdout('{"type":"result","result":"done"}\n')
      await waitForPersistedSessionFlush()

      // Reset the session.
      const resetResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-reset-test/reset`,
        {
          method: 'POST',
          headers: AUTH_HEADERS,
        },
      )
      expect(resetResponse.status).toBe(200)
      const resetPayload = (await resetResponse.json()) as { reset: boolean; sessionName: string }
      expect(resetPayload.reset).toBe(true)
      expect(resetPayload.sessionName).toBe('commander-reset-test')

      // A new process should have been spawned.
      expect(processMocks).toHaveLength(2)

      // Old process should have been killed.
      expect(processMocks[0].cp.kill).toHaveBeenCalledWith('SIGTERM')

      // New process should NOT have --resume flag.
      const lastSpawnArgs = mockedSpawn.mock.calls[mockedSpawn.mock.calls.length - 1]
      expect(lastSpawnArgs[1]).not.toContain('--resume')
      expect(lastSpawnArgs[1]).not.toContain('--max-turns')
      expect(lastSpawnArgs[1]).toContain('--system-prompt')
      const promptIndex = lastSpawnArgs[1].indexOf('--system-prompt')
      const resetPrompt = lastSpawnArgs[1][promptIndex + 1]
      expect(resetPrompt).toContain('HTTP reset workflow prompt from COMMANDER.md')
      expect(resetPrompt).toContain('HTTP reset identity body from identity.md.')
      expect(resetPrompt).not.toBe('Stale reset prompt')

      // Session should still exist in the session list.
      const listResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{ name: string }>
      expect(sessions.some((s) => s.name === 'commander-reset-test')).toBe(true)

      await vi.waitFor(() => {
        expect(processMocks[1].getStdinWrites().some((write) => (
          write.includes('Session rotated. Continuing as commander.')
        ))).toBe(true)
      })
    } finally {
      await server.close()
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('POST /sessions/:name/reset rejects non-commander sessions', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'regular-session',
          mode: 'default',
          sessionType: 'stream',
        }),
      })
      expect(createResponse.status).toBe(201)

      mock.emitStdout('{"type":"result","result":"done"}\n')
      await waitForPersistedSessionFlush()

      const resetResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/regular-session/reset`,
        {
          method: 'POST',
          headers: AUTH_HEADERS,
        },
      )
      expect(resetResponse.status).toBe(400)
      const payload = (await resetResponse.json()) as { error: string }
      expect(payload.error).toContain('commander')
    } finally {
      await server.close()
    }
  })

  it('POST /sessions/:name/reset returns 404 for non-existent session', async () => {
    const server = await startServer()

    try {
      const resetResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-nonexistent/reset`,
        {
          method: 'POST',
          headers: AUTH_HEADERS,
        },
      )
      expect(resetResponse.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('passes --system-prompt to spawn when commander session is created with systemPrompt', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    server.sessionsInterface.createCommanderSession({
      name: 'commander-identity-test',
      systemPrompt: 'You are Commander Alpha',
      cwd: '/tmp',
    })

    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--system-prompt', 'You are Commander Alpha']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )

    // Clean up
    mock.cp.kill()
    server.sessionsInterface.deleteSession('commander-identity-test')
    await server.close()
  })

  it('keeps websocket clients connected when commander session is replaced', async () => {
    const firstMock = createMockChildProcess()
    const secondMock = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(firstMock.cp as never)
    mockedSpawn.mockReturnValueOnce(secondMock.cp as never)

    const server = await startServer()

    await server.sessionsInterface.createCommanderSession({
      name: 'commander-replace-test',
      systemPrompt: 'You are Commander Gamma',
      agentType: 'claude',
      cwd: '/tmp',
    })

    const ws = await connectWs(server.baseUrl, 'commander-replace-test')
    const closeSpy = vi.fn()
    ws.on('close', closeSpy)

    await server.sessionsInterface.createCommanderSession({
      name: 'commander-replace-test',
      systemPrompt: 'You are Commander Delta',
      agentType: 'claude',
      cwd: '/tmp',
    })

    await vi.waitFor(() => {
      expect(firstMock.cp.kill).toHaveBeenCalledWith('SIGTERM')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(closeSpy).not.toHaveBeenCalled()

    ws.close()
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
    })
    server.sessionsInterface.deleteSession('commander-replace-test')
    await server.close()
  })

  it('preserves systemPrompt on respawn when process exits and new message arrives via WS', async () => {
    const mock1 = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(mock1.cp as never)

    const workDir = await mkdtemp(join(tmpdir(), 'hammurabi-respawn-seed-'))
    const commanderDataDir = join(workDir, 'commanders-data')
    await seedCommanderSessionFixture({
      commanderDataDir,
      commanderId: 'respawn-test',
      workflowPrompt: 'Fresh respawn workflow prompt',
      identityBody: 'Fresh respawn identity body.',
    })

    const server = await startServer({
      commanderSessionStorePath: join(commanderDataDir, 'sessions.json'),
    })

    // Create a commander session with a system prompt
    server.sessionsInterface.createCommanderSession({
      name: 'commander-respawn-test',
      systemPrompt: 'You are Commander Beta',
      agentType: 'claude',
      cwd: '/tmp',
      maxTurns: 5,
    })

    // Verify first spawn includes system prompt
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    expect(mockedSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--system-prompt', 'You are Commander Beta']),
      expect.anything(),
    )

    // Simulate the init event so claudeSessionId gets set
    mock1.emitStdout('{"type":"system","subtype":"init","session_id":"claude-session-abc"}\n')
    await new Promise((r) => setTimeout(r, 50))

    // Connect WS *before* making stdin non-writable (session must still
    // be in the map; after process exit the session is deleted).
    const ws = await connectWs(server.baseUrl, 'commander-respawn-test')

    // Make stdin non-writable without triggering a full process exit —
    // this simulates a process that has finished its turn but whose exit
    // event has not yet fired.
    Object.defineProperty(mock1.cp.stdin, 'writable', { value: false })
    mock1.cp.stdin.write = vi.fn(() => false)

    // Prepare a second mock for the respawn
    const mock2 = createMockChildProcess()
    mockedSpawn.mockReturnValueOnce(mock2.cp as never)

    // Send a user message via WS — this triggers the respawn path
    ws.send(JSON.stringify({ type: 'input', text: 'check quest board' }))

    // Wait for the respawn to be triggered (it happens asynchronously via readMachineRegistry)
    await vi.waitFor(() => {
      expect(mockedSpawn).toHaveBeenCalledTimes(2)
    }, { timeout: 2000 })

    // The second spawn call (respawn) should include --system-prompt
    const secondCall = mockedSpawn.mock.calls[1]
    expect(secondCall[0]).toBe('claude')
    const args = secondCall[1] as string[]
    expect(args).toContain('--system-prompt')
    const spIdx = args.indexOf('--system-prompt')
    const respawnPrompt = args[spIdx + 1]
    expect(respawnPrompt).toContain('Fresh respawn workflow prompt')
    expect(respawnPrompt).toContain('Fresh respawn identity body.')
    expect(respawnPrompt).not.toBe('You are Commander Beta')

    // Also verify --max-turns is preserved
    expect(args).toContain('--max-turns')
    const mtIdx = args.indexOf('--max-turns')
    expect(args[mtIdx + 1]).toBe('5')

    // Also verify --resume is passed
    expect(args).toContain('--resume')

    ws.close()
    server.sessionsInterface.deleteSession('commander-respawn-test')
    await server.close()
    await rm(workDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Unit tests for session-messages.ts
// ---------------------------------------------------------------------------

describe('extractMessages', () => {
  it('extracts user and assistant messages from Claude envelope events', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] } },
      { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 20 } },
      { type: 'result', subtype: 'success', result: 'done' },
    ]

    const messages = extractMessages(events)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello' })
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' })
  })

  it('filters by role=assistant', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Q2' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A2' }] } },
    ]

    const messages = extractMessages(events, 'assistant')
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('A1')
    expect(messages[1].content).toBe('A2')
  })

  it('filters by role=user', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } },
    ]

    const messages = extractMessages(events, 'user')
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Q1')
  })

  it('applies last=N to return only the last N messages', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Q1' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Q2' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A2' }] } },
    ]

    const messages = extractMessages(events, 'all', 2)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('Q2')
    expect(messages[1].content).toBe('A2')
  })

  it('marks assistant messages with tool_use content', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    ]

    const messages = extractMessages(events)
    expect(messages).toHaveLength(1)
    expect(messages[0].toolUse).toBe(true)
  })

  it('returns empty array for events with no messages', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'message_delta', usage: { input_tokens: 10 } },
      { type: 'result', subtype: 'success' },
    ]

    const messages = extractMessages(events)
    expect(messages).toEqual([])
  })

  it('preserves timestamp from events', () => {
    const events = [
      {
        type: 'user',
        timestamp: '2026-03-20T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      },
    ]

    const messages = extractMessages(events)
    expect(messages[0].timestamp).toBe('2026-03-20T10:00:00Z')
  })

  it('handles string content in message', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: 'plain string content' } },
    ]

    const messages = extractMessages(events)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('plain string content')
  })

  it('preserves tool-only assistant envelopes (P2-4)', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { question: 'Continue?' } },
          ],
        },
      },
    ]

    const messages = extractMessages(events)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].content).toBe('')
    expect(messages[0].toolUse).toBe(true)
  })
})

describe('readCommanderTranscript', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-transcript-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('reads JSONL transcript file and returns events', async () => {
    const commanderId = 'test-commander'
    const transcriptId = 'session-abc'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    ]
    await writeFile(
      join(sessionsDir, `${transcriptId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const result = await readCommanderTranscript(commanderId, transcriptId, tmpDir)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
    expect(result![0].type).toBe('user')
    expect(result![1].type).toBe('assistant')
  })

  it('returns null for nonexistent transcript', async () => {
    const result = await readCommanderTranscript('no-commander', 'no-session', tmpDir)
    expect(result).toBeNull()
  })

  it('rejects path traversal in commanderId', async () => {
    const result = await readCommanderTranscript('../etc', 'passwd', tmpDir)
    expect(result).toBeNull()
  })

  it('rejects path traversal in transcriptId', async () => {
    const result = await readCommanderTranscript('valid-id', '../../etc/passwd', tmpDir)
    expect(result).toBeNull()
  })

  it('skips malformed JSONL lines gracefully', async () => {
    const commanderId = 'test-commander'
    const transcriptId = 'session-bad'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const content = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Good"}]}}',
      'this is not json',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}}',
    ].join('\n')
    await writeFile(join(sessionsDir, `${transcriptId}.jsonl`), content)

    const result = await readCommanderTranscript(commanderId, transcriptId, tmpDir)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Integration tests for GET /sessions/:name/messages endpoint
// ---------------------------------------------------------------------------

describe('session messages endpoint', () => {
  function installMockProcess() {
    const mock = createMockChildProcess()
    mockedSpawn.mockReturnValue(mock.cp as never)
    return mock
  }

  afterEach(() => {
    mockedSpawn.mockRestore()
  })

  it('returns messages from an active stream session', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    // Create a stream session with an initial task — the server synthesizes
    // a user event for the task at creation time. Stdout user events are
    // skipped as echoes, so we rely on the synthesized user event.
    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'peek-test', mode: 'default', sessionType: 'stream', task: 'What is 2+2?' }),
    })

    // Emit assistant response via stdout
    mock.emitStdout('{"type":"system","subtype":"init","session_id":"s1"}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"4"}]}}\n')

    // Allow events to be processed
    await new Promise((r) => setTimeout(r, 50))

    const res = await fetch(`${server.baseUrl}/api/agents/sessions/peek-test/messages`, {
      headers: AUTH_HEADERS,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session).toBe('peek-test')
    expect(body.source).toBe('live')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'What is 2+2?' })
    expect(body.messages[1]).toEqual({ role: 'assistant', content: '4' })

    await server.close()
  })

  it('filters messages by role', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'peek-role', mode: 'default', sessionType: 'stream' }),
    })

    mock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Q1"}]}}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A1"}]}}\n')
    mock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Q2"}]}}\n')
    await new Promise((r) => setTimeout(r, 50))

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/peek-role/messages?role=assistant`,
      { headers: AUTH_HEADERS },
    )
    const body = await res.json()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('A1')

    await server.close()
  })

  it('respects the last query parameter', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'peek-last', mode: 'default', sessionType: 'stream' }),
    })

    mock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Q1"}]}}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A1"}]}}\n')
    mock.emitStdout('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Q2"}]}}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A2"}]}}\n')
    await new Promise((r) => setTimeout(r, 50))

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/peek-last/messages?last=1`,
      { headers: AUTH_HEADERS },
    )
    const body = await res.json()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toBe('A2')

    await server.close()
  })

  it('returns 404 for nonexistent session', async () => {
    const server = await startServer()

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/does-not-exist/messages`,
      { headers: AUTH_HEADERS },
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Session not found' })

    await server.close()
  })

  it('returns 400 for invalid session name', async () => {
    const server = await startServer()

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/${encodeURIComponent('bad name!@#')}/messages`,
      { headers: AUTH_HEADERS },
    )
    expect(res.status).toBe(400)

    await server.close()
  })

  it('returns 400 for invalid last parameter', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'peek-bad-last', mode: 'default', sessionType: 'stream' }),
    })

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/peek-bad-last/messages?last=-1`,
      { headers: AUTH_HEADERS },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid last parameter: expected positive integer' })

    await server.close()
  })

  it('returns 400 for invalid role parameter', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'peek-bad-role', mode: 'default', sessionType: 'stream' }),
    })

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/peek-bad-role/messages?role=admin`,
      { headers: AUTH_HEADERS },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid role parameter: expected user, assistant, or all' })

    await server.close()
  })

  it('returns messages from commander transcript', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'commander-peek-'))
    const commanderId = 'cmdr-abc'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    // Write transcript JSONL
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Build the feature' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] } },
    ]
    const transcriptId = 'claude-session-123'
    await writeFile(
      join(sessionsDir, `${transcriptId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    // Mock commander session store to return this commander
    const commanderSession: CommanderSession = {
      id: commanderId,
      host: 'test-host',
      pid: 123,
      state: 'running',
      created: '2026-03-20T00:00:00Z',
      claudeSessionId: transcriptId,
      heartbeat: { lastSentAt: null, lastPayload: null },
      lastHeartbeat: null,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
    }

    vi.spyOn(CommanderSessionStore.prototype, 'get').mockResolvedValue(commanderSession)

    try {
      // Point commanderSessionStorePath inside tmpDir so commanderDataDir resolves correctly
      const server = await startServer({
        commanderSessionStorePath: join(tmpDir, 'sessions.json'),
      })

      const res = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-${commanderId}/messages`,
        { headers: AUTH_HEADERS },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.session).toBe(`commander-${commanderId}`)
      expect(body.source).toBe('transcript')
      expect(body.messages).toHaveLength(2)
      expect(body.messages[0].content).toBe('Build the feature')
      expect(body.messages[1].content).toBe('On it')

      await server.close()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns messages from Codex commander transcript via codexThreadId (P2-1)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'commander-codex-'))
    const commanderId = 'cmdr-codex'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const codexThreadId = 'codex-thread-xyz'
    const events = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Run tests' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests passed' }] } },
    ]
    await writeFile(
      join(sessionsDir, `${codexThreadId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const commanderSession: CommanderSession = {
      id: commanderId,
      host: 'test-host',
      pid: 123,
      state: 'running',
      created: '2026-03-20T00:00:00Z',
      agentType: 'codex',
      codexThreadId,
      heartbeat: { lastSentAt: null, lastPayload: null },
      lastHeartbeat: null,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
    }

    vi.spyOn(CommanderSessionStore.prototype, 'get').mockResolvedValue(commanderSession)

    try {
      const server = await startServer({
        commanderSessionStorePath: join(tmpDir, 'sessions.json'),
      })

      const res = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-${commanderId}/messages`,
        { headers: AUTH_HEADERS },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.source).toBe('transcript')
      expect(body.messages).toHaveLength(2)
      expect(body.messages[0].content).toBe('Run tests')

      await server.close()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('merges pre-init and post-init commander transcript files (P2-3)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'commander-merge-'))
    const commanderId = 'cmdr-merge'
    const sessionsDir = join(tmpDir, commanderId, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const sessionName = `commander-${commanderId}`
    const claudeSessionId = 'claude-session-456'

    // Pre-init file: written under session name before init event
    const preInitEvents = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Initial task' }] } },
    ]
    await writeFile(
      join(sessionsDir, `${sessionName}.jsonl`),
      preInitEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    // Post-init file: written under claudeSessionId after init event
    const postInitEvents = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } },
    ]
    await writeFile(
      join(sessionsDir, `${claudeSessionId}.jsonl`),
      postInitEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )

    const commanderSession: CommanderSession = {
      id: commanderId,
      host: 'test-host',
      pid: 123,
      state: 'running',
      created: '2026-03-20T00:00:00Z',
      claudeSessionId,
      heartbeat: { lastSentAt: null, lastPayload: null },
      lastHeartbeat: null,
      taskSource: null,
      currentTask: null,
      completedTasks: 0,
      totalCostUsd: 0,
    }

    vi.spyOn(CommanderSessionStore.prototype, 'get').mockResolvedValue(commanderSession)

    try {
      const server = await startServer({
        commanderSessionStorePath: join(tmpDir, 'sessions.json'),
      })

      const res = await fetch(
        `${server.baseUrl}/api/agents/sessions/${sessionName}/messages`,
        { headers: AUTH_HEADERS },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.source).toBe('transcript')
      // Both pre-init and post-init events should be merged
      expect(body.messages).toHaveLength(2)
      expect(body.messages[0].content).toBe('Initial task')
      expect(body.messages[1].content).toBe('Working on it')

      await server.close()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('serves messages for completed one-shot sessions (P2-5)', async () => {
    const mock = installMockProcess()
    const server = await startServer()

    // Create a command-room session (one-shot)
    await fetch(`${server.baseUrl}/api/agents/sessions`, {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'command-room-p2-5', mode: 'default', sessionType: 'stream', task: 'Do something' }),
    })

    // Emit assistant response
    mock.emitStdout('{"type":"system","subtype":"init","session_id":"s1"}\n')
    mock.emitStdout('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}\n')
    mock.emitStdout('{"type":"result","subtype":"success","result":"complete"}\n')
    await new Promise((r) => setTimeout(r, 50))

    // Simulate process exit so the session moves to completedSessions
    mock.emitExit(0)
    await new Promise((r) => setTimeout(r, 50))

    // Session should now be completed but messages should still be available
    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/command-room-p2-5/messages`,
      { headers: AUTH_HEADERS },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.messages.length).toBeGreaterThan(0)
    // Should contain the user task and assistant response
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user')
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(userMsg?.content).toBe('Do something')
    expect(assistantMsg?.content).toBe('Done')

    await server.close()
  })

  it('requires authentication', async () => {
    const server = await startServer()

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/any-session/messages`,
    )
    expect(res.status).toBe(401)

    await server.close()
  })

  it('allows read-only access', async () => {
    const server = await startServer()

    const res = await fetch(
      `${server.baseUrl}/api/agents/sessions/no-session/messages`,
      { headers: READ_ONLY_AUTH_HEADERS },
    )
    // 404 means auth passed, session just doesn't exist
    expect(res.status).toBe(404)

    await server.close()
  })

  it('serves workspace tree, preview, and save routes for local sessions', async () => {
    const tempWorkspaceRoot = await mkdtemp(join(tmpdir(), 'agent-workspace-'))
    const workspaceDir = join(tempWorkspaceRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(join(workspaceDir, 'src'), { recursive: true })
    await writeFile(join(workspaceDir, 'README.md'), '# workspace\n', 'utf8')

    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'workspace-local',
          mode: 'default',
          cwd: workspaceDir,
        }),
      })
      expect(createResponse.status).toBe(201)

      const treeResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/workspace-local/workspace/tree`,
        { headers: AUTH_HEADERS },
      )
      expect(treeResponse.status).toBe(200)
      const treeBody = await treeResponse.json()
      expect(treeBody.nodes.map((node: { name: string }) => node.name)).toEqual(['src', 'README.md'])

      const fileResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/workspace-local/workspace/file?path=README.md`,
        { headers: AUTH_HEADERS },
      )
      expect(fileResponse.status).toBe(200)
      const fileBody = await fileResponse.json()
      expect(fileBody.kind).toBe('text')
      expect(fileBody.content).toContain('# workspace')

      const saveResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/workspace-local/workspace/file`,
        {
          method: 'PUT',
          headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            path: 'README.md',
            content: '# updated\n',
          }),
        },
      )
      expect(saveResponse.status).toBe(200)
      expect(await readFile(join(workspaceDir, 'README.md'), 'utf8')).toBe('# updated\n')
    } finally {
      await rm(tempWorkspaceRoot, { recursive: true, force: true })
      await server.close()
    }
  })

  it('rejects workspace traversal outside the resolved root', async () => {
    const tempWorkspaceRoot = await mkdtemp(join(tmpdir(), 'agent-workspace-escape-'))
    const workspaceDir = join(tempWorkspaceRoot, 'workspace-escape')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'inside.txt'), 'ok\n', 'utf8')

    const { spawner } = createMockPtySpawner()
    const server = await startServer({ ptySpawner: spawner })

    try {
      await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'workspace-escape',
          mode: 'default',
          cwd: workspaceDir,
        }),
      })

      const response = await fetch(
        `${server.baseUrl}/api/agents/sessions/workspace-escape/workspace/file?path=../outside.txt`,
        { headers: AUTH_HEADERS },
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'Workspace path cannot escape the workspace root',
      })
    } finally {
      await rm(tempWorkspaceRoot, { recursive: true, force: true })
      await server.close()
    }
  })
})
