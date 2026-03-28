import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createCommandersRouter, type CommandersRouterOptions } from '../routes'
import type { CommanderSessionsInterface } from '../../agents/routes'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

interface RunningServer {
  baseUrl: string
  httpServer: Server
  close: () => Promise<void>
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

function createMockSessionsInterface(): CommanderSessionsInterface {
  const activeSessions = new Set<string>()

  return {
    async createCommanderSession(params) {
      activeSessions.add(params.name)
      return { kind: 'stream', name: params.name } as unknown as Awaited<ReturnType<
        CommanderSessionsInterface['createCommanderSession']
      >>
    },
    async sendToSession(name) {
      return activeSessions.has(name)
    },
    deleteSession(name) {
      activeSessions.delete(name)
    },
    getSession(name) {
      if (!activeSessions.has(name)) return undefined
      return {
        kind: 'stream',
        name,
        agentType: 'claude',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      } as unknown as ReturnType<CommanderSessionsInterface['getSession']>
    },
    subscribeToEvents() {
      return () => {}
    },
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function startServer(
  options: Partial<CommandersRouterOptions> = {},
): Promise<RunningServer> {
  const sessionStorePath = options.sessionStorePath
    ?? join(await createTempDir('hammurabi-heartbeat-priority-session-store-'), 'sessions.json')
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

async function createCommander(baseUrl: string, host: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/commanders`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      host,
      taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
    }),
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { id: string }
  return body.id
}

async function startCommander(baseUrl: string, commanderId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/commanders/${commanderId}/start`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    },
  })
  expect(response.status).toBe(200)
}

async function getHeartbeatEntryCount(baseUrl: string, commanderId: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/commanders/${commanderId}/heartbeat-log`, {
    headers: AUTH_HEADERS,
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { entries?: unknown[] }
  return body.entries?.length ?? 0
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ),
  )
})

describe('commanders heartbeat interval priority', () => {
  it('uses COMMANDER.md heartbeat.interval as fallback when no interval override exists', async () => {
    const dir = await createTempDir('hammurabi-heartbeat-priority-fallback-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: createMockSessionsInterface(),
    })

    try {
      const commanderId = await createCommander(server.baseUrl, 'worker-priority-fallback')
      const commanderRoot = join(memoryBasePath, commanderId)
      await mkdir(commanderRoot, { recursive: true })
      await writeFile(
        join(commanderRoot, 'COMMANDER.md'),
        [
          '---',
          'heartbeat.interval: 30',
          '---',
          'WORKFLOW HEARTBEAT FALLBACK',
        ].join('\n'),
        'utf8',
      )

      await startCommander(server.baseUrl, commanderId)

      await vi.waitFor(async () => {
        const entryCount = await getHeartbeatEntryCount(server.baseUrl, commanderId)
        expect(entryCount).toBeGreaterThanOrEqual(2)
      }, { timeout: 600 })
    } finally {
      await server.close()
    }
  })

  it('keeps UI heartbeat PATCH interval when COMMANDER.md defines heartbeat.interval', async () => {
    const dir = await createTempDir('hammurabi-heartbeat-priority-ui-override-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const server = await startServer({
      sessionStorePath: storePath,
      memoryBasePath,
      sessionsInterface: createMockSessionsInterface(),
    })

    try {
      const commanderId = await createCommander(server.baseUrl, 'worker-priority-ui-override')
      const commanderRoot = join(memoryBasePath, commanderId)
      await mkdir(commanderRoot, { recursive: true })
      await writeFile(
        join(commanderRoot, 'COMMANDER.md'),
        [
          '---',
          'heartbeat.interval: 200',
          '---',
          'WORKFLOW HEARTBEAT OVERRIDE',
        ].join('\n'),
        'utf8',
      )

      await startCommander(server.baseUrl, commanderId)

      const patchResponse = await fetch(`${server.baseUrl}/api/commanders/${commanderId}/heartbeat`, {
        method: 'PATCH',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          intervalMs: 40,
        }),
      })
      expect(patchResponse.status).toBe(200)
      const patchBody = (await patchResponse.json()) as {
        heartbeat: { intervalMs: number }
      }
      expect(patchBody.heartbeat.intervalMs).toBe(40)

      await vi.waitFor(async () => {
        const entryCount = await getHeartbeatEntryCount(server.baseUrl, commanderId)
        expect(entryCount).toBeGreaterThanOrEqual(2)
      }, { timeout: 350 })
    } finally {
      await server.close()
    }
  })
})
