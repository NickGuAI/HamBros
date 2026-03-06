import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createCommandRoomRouter } from '../routes.js'
import { CommandRoomRunStore } from '../run-store.js'
import { CommandRoomTaskStore } from '../task-store.js'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
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
      scopes: ['commanders:read', 'commanders:write'],
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

async function startServer(options: {
  taskStore: CommandRoomTaskStore
  runStore: CommandRoomRunStore
  createSession: ReturnType<typeof vi.fn>
  monitorSession: ReturnType<typeof vi.fn>
}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  app.use(
    '/api/command-room',
    createCommandRoomRouter({
      taskStore: options.taskStore,
      runStore: options.runStore,
      apiKeyStore: createTestApiKeyStore(),
      agentSessionFactory: () => ({
        createSession: options.createSession,
        monitorSession: options.monitorSession,
      }),
      now: () => new Date('2026-03-02T01:00:00.000Z'),
    }),
  )

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

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) {
    return null as T
  }
  return JSON.parse(text) as T
}

describe('createCommandRoomRouter', () => {
  const cleanupDirs: string[] = []
  const servers: RunningServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('supports task CRUD, manual trigger, and run listing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'command-room-routes-'))
    cleanupDirs.push(dir)
    const taskStore = new CommandRoomTaskStore(join(dir, 'tasks.json'))
    const runStore = new CommandRoomRunStore(join(dir, 'runs.json'))

    const createSession = vi.fn(async () => ({ sessionId: 'session-1' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'session-1',
      status: 'SUCCESS' as const,
      finalComment: 'Run done.',
      filesChanged: 0,
      durationMin: 1,
      raw: { total_cost_usd: 0.11 },
    }))

    const server = await startServer({
      taskStore,
      runStore,
      createSession,
      monitorSession,
    })
    servers.push(server)

    const createResponse = await fetch(`${server.baseUrl}/api/command-room/tasks`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Nightly summary',
        schedule: '0 1 * * *',
        timezone: 'America/Los_Angeles',
        machine: 'machine-1',
        workDir: '/tmp/example-repo',
        agentType: 'claude',
        instruction: 'Summarize open issues',
        enabled: true,
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = await readJson<{ id: string; timezone?: string }>(createResponse)
    const taskId = created.id
    expect(taskId).toBeTruthy()
    expect(created.timezone).toBe('America/Los_Angeles')

    const listResponse = await fetch(`${server.baseUrl}/api/command-room/tasks`, {
      headers: AUTH_HEADERS,
    })
    expect(listResponse.status).toBe(200)
    const listed = await readJson<Array<{ id: string; lastRunStatus: string | null }>>(listResponse)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(taskId)
    expect(listed[0]?.lastRunStatus).toBeNull()

    const updateResponse = await fetch(`${server.baseUrl}/api/command-room/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        enabled: false,
        timezone: 'America/New_York',
      }),
    })
    expect(updateResponse.status).toBe(200)
    const updated = await readJson<{ enabled: boolean; timezone?: string }>(updateResponse)
    expect(updated.enabled).toBe(false)
    expect(updated.timezone).toBe('America/New_York')

    const triggerResponse = await fetch(
      `${server.baseUrl}/api/command-room/tasks/${taskId}/trigger`,
      {
        method: 'POST',
        headers: AUTH_HEADERS,
      },
    )
    expect(triggerResponse.status).toBe(201)
    const triggeredRun = await readJson<{ status: string; sessionId: string }>(triggerResponse)
    expect(triggeredRun.status).toBe('complete')
    expect(triggeredRun.sessionId).toBe('session-1')

    const runsResponse = await fetch(`${server.baseUrl}/api/command-room/tasks/${taskId}/runs`, {
      headers: AUTH_HEADERS,
    })
    expect(runsResponse.status).toBe(200)
    const runs = await readJson<Array<{ status: string; report: string }>>(runsResponse)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('complete')
    expect(runs[0]?.report).toContain('Run done.')

    const deleteResponse = await fetch(`${server.baseUrl}/api/command-room/tasks/${taskId}`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    })
    expect(deleteResponse.status).toBe(200)

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(monitorSession).toHaveBeenCalledWith('session-1', undefined)
  })

  it('rejects invalid timezone values on create and update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'command-room-routes-'))
    cleanupDirs.push(dir)
    const taskStore = new CommandRoomTaskStore(join(dir, 'tasks.json'))
    const runStore = new CommandRoomRunStore(join(dir, 'runs.json'))

    const server = await startServer({
      taskStore,
      runStore,
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      monitorSession: vi.fn(async () => ({
        sessionId: 'session-1',
        status: 'SUCCESS' as const,
        finalComment: 'Run done.',
        filesChanged: 0,
        durationMin: 1,
        raw: { total_cost_usd: 0.11 },
      })),
    })
    servers.push(server)

    const createInvalidTimezone = await fetch(`${server.baseUrl}/api/command-room/tasks`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Nightly summary',
        schedule: '0 1 * * *',
        timezone: 'Mars/Olympus_Mons',
        machine: 'machine-1',
        workDir: '/tmp/example-repo',
        agentType: 'claude',
        instruction: 'Summarize open issues',
        enabled: true,
      }),
    })
    expect(createInvalidTimezone.status).toBe(400)

    const createResponse = await fetch(`${server.baseUrl}/api/command-room/tasks`, {
      method: 'POST',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Nightly summary',
        schedule: '0 1 * * *',
        machine: 'machine-1',
        workDir: '/tmp/example-repo',
        agentType: 'claude',
        instruction: 'Summarize open issues',
        enabled: true,
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = await readJson<{ id: string }>(createResponse)

    const updateInvalidTimezone = await fetch(
      `${server.baseUrl}/api/command-room/tasks/${created.id}`,
      {
        method: 'PATCH',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          timezone: 'not/a-real-timezone',
        }),
      },
    )
    expect(updateInvalidTimezone.status).toBe(400)
  })
})
