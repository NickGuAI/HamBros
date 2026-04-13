import express from 'express'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createSentinelsRouter } from '../routes.js'
import { SentinelStore } from '../store.js'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

const tempDirs: string[] = []
const servers: RunningServer[] = []

function createTestApiKeyStore(): ApiKeyStoreLike {
  const recordsByRawKey = {
    'test-key': {
      id: 'test-key-id',
      name: 'Test Key',
      keyHash: 'hash',
      prefix: 'hmrb_test',
      createdBy: 'test',
      createdAt: '2026-04-11T00:00:00.000Z',
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

async function startServer(store: SentinelStore): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const sentinels = createSentinelsRouter({
    store,
    apiKeyStore: createTestApiKeyStore(),
  })
  await sentinels.ready
  app.use('/api/sentinels', sentinels.router)

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
      sentinels.scheduler.stopAllJobs()
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

describe('sentinel routes', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it('lists only sentinels attached to the requested commander', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hammurabi-sentinels-routes-'))
    tempDirs.push(dir)

    const store = new SentinelStore({ filePath: join(dir, 'sentinels.json') })
    const attached = await store.create({
      parentCommanderId: 'commander-alpha',
      name: 'alpha-watch',
      instruction: 'Watch alpha.',
      schedule: '*/15 * * * *',
      workDir: '/tmp/alpha',
    })
    await store.create({
      parentCommanderId: 'commander-beta',
      name: 'beta-watch',
      instruction: 'Watch beta.',
      schedule: '0 * * * *',
      workDir: '/tmp/beta',
    })

    const server = await startServer(store)
    servers.push(server)

    const response = await fetch(`${server.baseUrl}/api/sentinels?commander=commander-alpha`, {
      headers: AUTH_HEADERS,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      expect.objectContaining({
        id: attached.id,
        name: 'alpha-watch',
        parentCommanderId: 'commander-alpha',
      }),
    ])
  })
})
