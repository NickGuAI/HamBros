import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { createCommandersRouter } from '../routes'

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
      createdAt: '2026-03-10T00:00:00.000Z',
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
  sessionStorePath: string,
  memoryBasePath: string,
): Promise<RunningServer> {
  const app = express()
  app.use(express.json())
  const commanders = createCommandersRouter({
    apiKeyStore: createTestApiKeyStore(),
    sessionStorePath,
    memoryBasePath,
    refreshCommanderMemoryIndex: async () => {},
  })
  app.use('/api/commanders', commanders.router)

  const httpServer: Server = createServer(app)
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve())
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address')
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

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('remote commander sync routes', () => {
  it('registers remote commander and atomically claims pending quests', async () => {
    const dir = await createTempDir('hammurabi-remote-register-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const server = await startServer(storePath, memoryBasePath)

    try {
      const registerResponse = await fetch(`${server.baseUrl}/api/commanders/remote/register`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          machineId: 'gpu-node-1',
          label: 'GPU Node 1',
        }),
      })
      expect(registerResponse.status).toBe(201)
      const registerBody = (await registerResponse.json()) as {
        commanderId: string
        syncToken: string
      }
      expect(registerBody.commanderId).toBeTruthy()
      expect(registerBody.syncToken).toBeTruthy()

      const createQuestResponse = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/quests`,
        {
          method: 'POST',
          headers: {
            ...AUTH_HEADERS,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            source: 'manual',
            instruction: 'Process remote queue item',
            contract: {
              cwd: '/tmp/example-repo',
              permissionMode: 'bypassPermissions',
              agentType: 'claude',
              skillsToUse: [],
            },
          }),
        },
      )
      expect(createQuestResponse.status).toBe(201)
      const createdQuest = (await createQuestResponse.json()) as {
        id: string
      }

      const claimOne = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/quests/next`,
        {
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
          },
        },
      )
      expect(claimOne.status).toBe(200)
      const claimOneBody = (await claimOne.json()) as {
        quest: { id: string; status: string } | null
      }
      expect(claimOneBody.quest?.id).toBe(createdQuest.id)
      expect(claimOneBody.quest?.status).toBe('active')

      const claimTwo = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/quests/next`,
        {
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
          },
        },
      )
      expect(claimTwo.status).toBe(200)
      expect(await claimTwo.json()).toEqual({ quest: null })

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = (await listResponse.json()) as Array<{
        id: string
        remoteOrigin?: { machineId: string; label: string; syncToken?: string }
      }>
      const registered = sessions.find((session) => session.id === registerBody.commanderId)
      expect(registered?.remoteOrigin?.machineId).toBe('gpu-node-1')
      expect(registered?.remoteOrigin?.label).toBe('GPU Node 1')
      expect(registered?.remoteOrigin?.syncToken).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('deduplicates remote journal appends and serves memory exports', async () => {
    const dir = await createTempDir('hammurabi-remote-journal-')
    const storePath = join(dir, 'sessions.json')
    const memoryBasePath = join(dir, 'memory')
    const server = await startServer(storePath, memoryBasePath)

    try {
      const registerResponse = await fetch(`${server.baseUrl}/api/commanders/remote/register`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          machineId: 'worker-us-east-1',
          label: 'US-East Worker',
        }),
      })
      const registerBody = (await registerResponse.json()) as {
        commanderId: string
        syncToken: string
      }

      const journalPayload = {
        date: '2026-03-10',
        entries: [
          {
            timestamp: '2026-03-10T12:00:00.000Z',
            issueNumber: null,
            repo: null,
            outcome: 'Claimed quest remote-1',
            durationMin: null,
            salience: 'NOTABLE',
            body: '### Remote Quest\n\nInvestigate memory sync',
          },
        ],
      }

      const appendOne = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/memory/journal`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(journalPayload),
        },
      )
      expect(appendOne.status).toBe(200)
      expect(await appendOne.json()).toEqual({ appended: 1, skipped: 0 })

      const appendTwo = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/memory/journal`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(journalPayload),
        },
      )
      expect(appendTwo.status).toBe(200)
      expect(await appendTwo.json()).toEqual({ appended: 0, skipped: 1 })

      const journalFilePath = join(
        memoryBasePath,
        registerBody.commanderId,
        '.memory',
        'journal',
        '2026-03-10.md',
      )
      const journalFile = await readFile(journalFilePath, 'utf8')
      const occurrenceCount = (journalFile.match(/## \d{2}:\d{2} — Claimed quest remote-1/g) ?? []).length
      expect(occurrenceCount).toBe(1)

      const syncOne = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/memory/sync`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            memoryMd: '# Commander Memory\n\n## Discoveries\n\n- richer memory',
            repos: {
              'example-user/example-repo.md': '# repo memo',
            },
            skills: {
              'remote-sync/SKILL.md': '# Remote Sync Skill',
            },
          }),
        },
      )
      expect(syncOne.status).toBe(200)
      expect(await syncOne.json()).toEqual({
        memoryUpdated: true,
        repos: { updated: 1, skipped: 0 },
        skills: { updated: 1, skipped: 0 },
      })

      const syncTwo = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/memory/sync`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            memoryMd: '# Commander Memory\n\n- tiny',
          }),
        },
      )
      expect(syncTwo.status).toBe(200)
      expect(await syncTwo.json()).toEqual({
        memoryUpdated: false,
        repos: { updated: 0, skipped: 0 },
        skills: { updated: 0, skipped: 0 },
      })

      const exportResponse = await fetch(
        `${server.baseUrl}/api/commanders/${registerBody.commanderId}/memory/export`,
        {
          headers: {
            authorization: `Bearer ${registerBody.syncToken}`,
          },
        },
      )
      expect(exportResponse.status).toBe(200)
      const exportBody = (await exportResponse.json()) as {
        memoryMd: string
        journal: Record<string, string>
        repos: Record<string, string>
        skills: Record<string, string>
      }
      expect(exportBody.memoryMd).toContain('richer memory')
      expect(exportBody.journal['2026-03-10']).toContain('Claimed quest remote-1')
      expect(exportBody.repos['example-user/example-repo.md']).toContain('repo memo')
      expect(exportBody.skills['remote-sync/SKILL.md']).toContain('Remote Sync Skill')
    } finally {
      await server.close()
    }
  })
})
