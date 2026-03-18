import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { HeartbeatLog } from '../heartbeat-log.js'
import {
  createCommandersRouter,
  type CommandersRouterOptions,
} from '../routes.js'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

const tempDirs: string[] = []

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

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('HeartbeatLog', () => {
  it('appends entries and caps persisted history at 50 entries', async () => {
    const dir = await createTempDir('hammurabi-heartbeat-log-store-')
    const store = new HeartbeatLog({
      dataDir: join(dir, 'data/commanders'),
      maxEntries: 50,
    })

    for (let index = 0; index < 55; index += 1) {
      await store.append('cmdr-1', {
        firedAt: `2026-03-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        questCount: index,
        claimedQuestId: `quest-${index}`,
        claimedQuestInstruction: `Quest ${index}`,
        outcome: 'ok',
      })
    }

    const entries = await store.read('cmdr-1')
    expect(entries).toHaveLength(50)
    expect(entries[0]?.questCount).toBe(54)
    expect(entries[49]?.questCount).toBe(5)

    const topTen = await store.read('cmdr-1', 10)
    expect(topTen).toHaveLength(10)
    expect(topTen[0]?.questCount).toBe(54)
    expect(topTen[9]?.questCount).toBe(45)
  })
})

describe('GET /api/commanders/:id/heartbeat-log', () => {
  it('returns heartbeat log entries with expected shape', async () => {
    const dir = await createTempDir('hammurabi-heartbeat-log-route-')
    const heartbeatLog = new HeartbeatLog({
      dataDir: join(dir, 'data/commanders'),
      maxEntries: 50,
    })
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      heartbeatLog,
    })

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'worker-heartbeat-log',
          taskSource: { owner: 'example-user', repo: 'example-repo', label: 'commander' },
        }),
      })
      expect(createResponse.status).toBe(201)
      const created = (await createResponse.json()) as { id: string }

      await heartbeatLog.append(created.id, {
        firedAt: '2026-03-03T14:32:00.000Z',
        questCount: 3,
        claimedQuestId: '167',
        claimedQuestInstruction: 'Fix auth bug',
        outcome: 'ok',
      })

      const response = await fetch(
        `${server.baseUrl}/api/commanders/${created.id}/heartbeat-log`,
        { headers: AUTH_HEADERS },
      )
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        entries: Array<{
          id: string
          firedAt: string
          questCount: number
          claimedQuestId?: string
          claimedQuestInstruction?: string
          outcome: string
        }>
      }

      expect(payload.entries).toHaveLength(1)
      expect(payload.entries[0]).toEqual(
        expect.objectContaining({
          firedAt: '2026-03-03T14:32:00.000Z',
          questCount: 3,
          claimedQuestId: '167',
          claimedQuestInstruction: 'Fix auth bug',
          outcome: 'ok',
        }),
      )
      expect(typeof payload.entries[0]?.id).toBe('string')
      expect(payload.entries[0]?.id.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })
})
