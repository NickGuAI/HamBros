import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  }
})

vi.mock('../../factory/worktree.js', () => ({
  bootstrapFactoryWorktree: vi.fn(async ({ feature }: { feature: string }) => ({
    path: `/tmp/.factory/mock/${feature}`,
    branch: feature,
  })),
}))

import { spawn as spawnFn } from 'node:child_process'
import { bootstrapFactoryWorktree } from '../../factory/worktree.js'
import { createAgentsRouter, type AgentsRouterOptions } from '../routes'

const mockedSpawn = vi.mocked(spawnFn)
const mockedBootstrapFactoryWorktree = vi.mocked(bootstrapFactoryWorktree)

interface MockChildProcess {
  cp: ChildProcess
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
}

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
  httpServer: Server
}

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'dispatch-test-key',
}

let spawnedProcesses: MockChildProcess[] = []

function createMockChildProcess(pid: number): MockChildProcess {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const emitter = new EventEmitter()

  const cp = emitter as unknown as ChildProcess
  Object.assign(cp, {
    pid,
    stdout,
    stderr,
    stdin,
    kill: vi.fn((signal?: number | NodeJS.Signals) => {
      const normalizedSignal = typeof signal === 'string' ? signal : null
      emitter.emit('exit', 0, normalizedSignal)
      return true
    }),
  })

  return { cp, stdout, stderr, stdin }
}

function createTestApiKeyStore(): ApiKeyStoreLike {
  const record = {
    id: 'dispatch-key-id',
    name: 'Dispatch Test Key',
    keyHash: 'hash',
    prefix: 'hmrb_dispatch',
    createdBy: 'test',
    createdAt: '2026-03-25T00:00:00.000Z',
    lastUsedAt: null,
    scopes: ['agents:read', 'agents:write', 'factory:write'],
  }

  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey, options) => {
      if (rawKey !== 'dispatch-test-key') {
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

async function startServer(options: Partial<AgentsRouterOptions> = {}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const agents = createAgentsRouter({
    apiKeyStore: createTestApiKeyStore(),
    autoResumeSessions: false,
    commanderSessionStorePath: '/tmp/nonexistent-commander-sessions-dispatch-worker-test.json',
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

async function createCommanderSession(baseUrl: string, name = 'commander-main'): Promise<void> {
  const response = await fetch(`${baseUrl}/api/agents/sessions`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mode: 'default',
      sessionType: 'stream',
      cwd: '/tmp',
    }),
  })

  expect(response.status).toBe(201)
}

beforeEach(() => {
  let nextPid = 1000
  spawnedProcesses = []
  mockedBootstrapFactoryWorktree.mockClear()
  mockedSpawn.mockReset()
  mockedSpawn.mockImplementation(() => {
    const mock = createMockChildProcess(nextPid)
    spawnedProcesses.push(mock)
    nextPid += 1
    return mock.cp as never
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('dispatch-worker --type agent', () => {
  it('creates an agent worker without branch/issue and reports completion after result', async () => {
    const server = await startServer()

    try {
      await createCommanderSession(server.baseUrl)

      const dispatchResponse = await fetch(`${server.baseUrl}/api/agents/sessions/dispatch-worker`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parentSession: 'commander-main',
          workerType: 'agent',
          task: 'Investigate flaky worker status',
        }),
      })

      expect(dispatchResponse.status).toBe(202)
      const dispatchPayload = await dispatchResponse.json() as {
        name: string
        workerType: 'factory' | 'agent'
        cwd?: string
      }

      expect(dispatchPayload.workerType).toBe('agent')
      expect(dispatchPayload.name).toMatch(/^agent-\d+/)
      expect(dispatchPayload.cwd).toBe('/tmp')

      const workerName = dispatchPayload.name
      expect(spawnedProcesses.length).toBeGreaterThanOrEqual(2)
      const workerProcess = spawnedProcesses[1]

      workerProcess.stdout.write('{"type":"result","subtype":"success","result":"investigation complete","total_cost_usd":0.05}\n')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      const statusResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/${encodeURIComponent(workerName)}`,
        { headers: AUTH_HEADERS },
      )

      expect(statusResponse.status).toBe(200)
      const statusPayload = await statusResponse.json() as {
        completed: boolean
        status: string
        result?: {
          finalComment?: string
        }
      }

      expect(statusPayload.completed).toBe(true)
      expect(statusPayload.status).toBe('success')
      expect(statusPayload.result?.finalComment).toBe('investigation complete')

      const workersResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/commander-main/workers`,
        { headers: AUTH_HEADERS },
      )
      expect(workersResponse.status).toBe(200)
      const workers = await workersResponse.json() as Array<{ name: string; status: string }>
      expect(workers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: workerName, status: 'done' }),
      ]))
    } finally {
      await server.close()
    }
  })

  it('rejects standalone agent workers when parentSession is omitted', async () => {
    const server = await startServer()

    try {
      const dispatchResponse = await fetch(`${server.baseUrl}/api/agents/sessions/dispatch-worker`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workerType: 'agent',
          task: 'Investigate standalone worker',
        }),
      })

      expect(dispatchResponse.status).toBe(400)
      expect(await dispatchResponse.json()).toEqual({ error: 'Provide parentSession for agent workers' })
    } finally {
      await server.close()
    }
  })

  it('creates standalone factory workers with branch/task and no parent session', async () => {
    const server = await startServer()

    try {
      const dispatchResponse = await fetch(`${server.baseUrl}/api/agents/sessions/dispatch-worker`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          branch: 'feat-standalone',
          task: 'Handle standalone factory worker',
          issueUrl: 'https://github.com/example-user/example-repo/issues/818',
        }),
      })

      expect(dispatchResponse.status).toBe(202)
      const dispatchPayload = await dispatchResponse.json() as {
        name: string
        workerType: 'factory' | 'agent'
        branch?: string
        worktree?: string
      }

      expect(dispatchPayload.workerType).toBe('factory')
      expect(dispatchPayload.name).toMatch(/^factory-feat-standalone-\d+/)
      expect(dispatchPayload.branch).toBe('feat-standalone')
      expect(dispatchPayload.worktree).toBe('/tmp/.factory/mock/feat-standalone')
      expect(mockedBootstrapFactoryWorktree).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'example-user',
        repo: 'example-repo',
        feature: 'feat-standalone',
      }))

      const workerName = dispatchPayload.name
      const statusResponse = await fetch(
        `${server.baseUrl}/api/agents/sessions/${encodeURIComponent(workerName)}`,
        { headers: AUTH_HEADERS },
      )
      expect(statusResponse.status).toBe(200)
      const statusPayload = await statusResponse.json() as {
        completed: boolean
        agentType?: string
        parentSession?: string
      }
      expect(statusPayload.completed).toBe(false)
      expect(statusPayload.agentType).toBe('claude')
      expect(statusPayload.parentSession).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('keeps factory branch/issue requirement when --type is omitted or factory', async () => {
    const server = await startServer()

    try {
      await createCommanderSession(server.baseUrl)

      const defaultFactoryResponse = await fetch(`${server.baseUrl}/api/agents/sessions/dispatch-worker`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parentSession: 'commander-main',
          task: 'Do work',
        }),
      })

      expect(defaultFactoryResponse.status).toBe(400)
      expect(await defaultFactoryResponse.json()).toEqual({ error: 'Provide branch or issueUrl' })

      const explicitFactoryResponse = await fetch(`${server.baseUrl}/api/agents/sessions/dispatch-worker`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          parentSession: 'commander-main',
          workerType: 'factory',
          task: 'Do work',
        }),
      })

      expect(explicitFactoryResponse.status).toBe(400)
      expect(await explicitFactoryResponse.json()).toEqual({ error: 'Provide branch or issueUrl' })
    } finally {
      await server.close()
    }
  })
})
