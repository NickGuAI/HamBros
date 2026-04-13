import express from 'express'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createCommandersRouter, type CommandersRouterOptions } from '../routes'

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

interface RunningServer {
  baseUrl: string
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
      createdAt: '2026-03-18T00:00:00.000Z',
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

describe('commanders identity routes', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it('creates identity.md inside .memory/ and exposes it on commander detail response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hammurabi-commanders-identity-'))
    tempDirs.push(dir)
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')

    const server = await startServer({ sessionStorePath: storePath, memoryBasePath })
    try {
      const createResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'identity-worker',
          persona: 'Athena, goddess of wisdom and engineering commander',
          cwd: '/workspace/example-repo',
          taskSource: {
            owner: 'example-user',
            repo: 'example-repo',
            label: 'commander',
          },
        }),
      })
      expect(createResponse.status).toBe(201)
      const created = (await createResponse.json()) as { id: string; persona?: string }
      expect(created.persona).toBe('Athena, goddess of wisdom and engineering commander')

      const persistedSessions = JSON.parse(await readFile(storePath, 'utf8')) as {
        sessions: Array<Record<string, unknown>>
      }
      expect(persistedSessions.sessions).toHaveLength(1)
      expect(persistedSessions.sessions[0]?.persona).toBe(
        'Athena, goddess of wisdom and engineering commander',
      )

      const commanderMdPath = join(memoryBasePath, created.id, '.memory', 'identity.md')
      const commanderMdOnDisk = await readFile(commanderMdPath, 'utf8')
      expect(commanderMdOnDisk).toContain('Athena, goddess of wisdom and engineering commander')
      expect(commanderMdOnDisk).toContain('host: "identity-worker"')
      expect(commanderMdOnDisk).toContain('cwd: "/workspace/example-repo"')

      const workflowMdPath = join(memoryBasePath, created.id, 'COMMANDER.md')
      const workflowMdOnDisk = await readFile(workflowMdPath, 'utf8')
      expect(workflowMdOnDisk).toContain(`hammurabi memory find --commander ${created.id}`)

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      expect(listResponse.status).toBe(200)
      const listed = (await listResponse.json()) as Array<{ id: string; persona?: string }>
      expect(listed.find((entry) => entry.id === created.id)?.persona).toBe(
        'Athena, goddess of wisdom and engineering commander',
      )

      const detailResponse = await fetch(`${server.baseUrl}/api/commanders/${created.id}`, {
        headers: AUTH_HEADERS,
      })
      expect(detailResponse.status).toBe(200)
      const detail = (await detailResponse.json()) as {
        commanderMd?: string | null
        identityMd?: string | null
        workflowMd?: string | null
      }
      expect(detail.commanderMd).toBe(workflowMdOnDisk)
      expect(detail.workflowMd).toBe(workflowMdOnDisk)
      expect(detail.identityMd).toBe(commanderMdOnDisk)
    } finally {
      await server.close()
    }
  })

  it('rejects persona longer than 500 characters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hammurabi-commanders-identity-'))
    tempDirs.push(dir)
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')

    const server = await startServer({ sessionStorePath: storePath, memoryBasePath })
    try {
      const response = await fetch(`${server.baseUrl}/api/commanders`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          host: 'identity-worker-2',
          persona: 'x'.repeat(501),
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'persona must be a string up to 500 characters',
      })
    } finally {
      await server.close()
    }
  })
})
