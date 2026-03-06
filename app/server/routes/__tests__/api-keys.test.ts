import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApiKeyJsonStore } from '../../api-keys/store'
import { OpenAITranscriptionKeyStore } from '../../api-keys/transcription-store'
import { createApiKeysRouter } from '../api-keys'
import { createTelemetryRouter } from '../../../modules/telemetry/routes'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

const testDirectories: string[] = []

async function createTestDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-auth-routes-'))
  testDirectories.push(directory)
  return directory
}

async function removeDirectoryWithRetry(directory: string): Promise<void> {
  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') {
        throw error
      }
      if (attempt === maxAttempts) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt))
    }
  }
}

async function startServer(): Promise<RunningServer> {
  const directory = await createTestDirectory()
  const apiKeyStore = new ApiKeyJsonStore(path.join(directory, 'api-keys.json'))
  const transcriptionKeyStore = new OpenAITranscriptionKeyStore({
    filePath: path.join(directory, 'transcription-secrets.json'),
    keyFilePath: path.join(directory, 'transcription-secrets.key'),
    encryptionKey: 'test-encryption-key',
  })
  const telemetryStorePath = path.join(directory, 'telemetry.jsonl')

  const verifyAuth0Token = async (token: string) => {
    if (token !== 'valid-auth0-token') {
      throw new Error('invalid auth0 token')
    }

    return {
      id: 'auth0|user-1',
      email: 'user@example.com',
    }
  }

  const app = express()
  app.use(express.json())
  app.use(
    '/api/auth',
    createApiKeysRouter({
      store: apiKeyStore,
      transcriptionKeyStore,
      verifyToken: verifyAuth0Token,
    }),
  )
  app.use(
    '/api/telemetry',
    createTelemetryRouter({
      dataFilePath: telemetryStorePath,
      apiKeyStore,
      verifyAuth0Token,
    }),
  )

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

afterEach(async () => {
  for (const directory of testDirectories.splice(0)) {
    await removeDirectoryWithRetry(directory)
  }
})

describe('api key auth routes', () => {
  it('supports create/list/use/revoke API key lifecycle', async () => {
    const server = await startServer()

    const createResponse = await fetch(`${server.baseUrl}/api/auth/keys`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-auth0-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Telemetry Key',
        scopes: ['telemetry:write'],
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as {
      id: string
      key: string
      scopes: string[]
      prefix: string
    }
    expect(created.key.startsWith('hmrb_')).toBe(true)
    expect(created.scopes).toEqual(['telemetry:write'])
    expect(created.prefix).toMatch(/^hmrb_[a-z0-9]{4}$/)

    const listResponse = await fetch(`${server.baseUrl}/api/auth/keys`, {
      headers: {
        authorization: 'Bearer valid-auth0-token',
      },
    })
    expect(listResponse.status).toBe(200)
    const listed = (await listResponse.json()) as Array<{
      id: string
      scopes: string[]
      key?: string
    }>
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
    expect(listed[0]?.scopes).toEqual(['telemetry:write'])
    expect(listed[0]).not.toHaveProperty('key')

    const ingestByApiKey = await fetch(`${server.baseUrl}/api/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hammurabi-api-key': created.key,
      },
      body: JSON.stringify({
        sessionId: 'session-with-key',
        agentName: 'codex',
        model: 'o3',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.001,
      }),
    })
    expect(ingestByApiKey.status).toBe(202)

    const ingestByAuth0 = await fetch(`${server.baseUrl}/api/telemetry/ingest`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-auth0-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-with-auth0',
        agentName: 'claude',
        model: 'sonnet',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.001,
      }),
    })
    expect(ingestByAuth0.status).toBe(202)

    const revokeResponse = await fetch(
      `${server.baseUrl}/api/auth/keys/${encodeURIComponent(created.id)}`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer valid-auth0-token',
        },
      },
    )
    expect(revokeResponse.status).toBe(204)

    const ingestAfterRevoke = await fetch(`${server.baseUrl}/api/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hammurabi-api-key': created.key,
      },
      body: JSON.stringify({
        sessionId: 'session-after-revoke',
        agentName: 'codex',
        model: 'o3',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.001,
      }),
    })
    expect(ingestAfterRevoke.status).toBe(401)

    await server.close()
  })

  it('rejects API key creation when scopes are outside the allow-list', async () => {
    const server = await startServer()

    const response = await fetch(`${server.baseUrl}/api/auth/keys`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-auth0-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Invalid Scope Key',
        scopes: ['admin:all'],
      }),
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: string }
    expect(payload.error).toContain('telemetry:write')
    expect(payload.error).toContain('agents:read')
    expect(payload.error).toContain('agents:write')
    expect(payload.error).toContain('services:read')

    await server.close()
  })

  it('stores transcription OpenAI key without exposing plaintext on read', async () => {
    const server = await startServer()

    const initialStatus = await fetch(`${server.baseUrl}/api/auth/transcription/openai`, {
      headers: {
        authorization: 'Bearer valid-auth0-token',
      },
    })
    expect(initialStatus.status).toBe(200)
    expect(await initialStatus.json()).toEqual({
      configured: false,
      updatedAt: null,
    })

    const storeResponse = await fetch(`${server.baseUrl}/api/auth/transcription/openai`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer valid-auth0-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: 'sk-openai-transcription' }),
    })
    expect(storeResponse.status).toBe(204)

    const afterStoreStatus = await fetch(`${server.baseUrl}/api/auth/transcription/openai`, {
      headers: {
        authorization: 'Bearer valid-auth0-token',
      },
    })
    expect(afterStoreStatus.status).toBe(200)
    const afterStorePayload = (await afterStoreStatus.json()) as {
      configured: boolean
      updatedAt: string | null
      apiKey?: string
    }
    expect(afterStorePayload.configured).toBe(true)
    expect(typeof afterStorePayload.updatedAt).toBe('string')
    expect(afterStorePayload).not.toHaveProperty('apiKey')

    const clearResponse = await fetch(`${server.baseUrl}/api/auth/transcription/openai`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer valid-auth0-token',
      },
    })
    expect(clearResponse.status).toBe(204)

    const afterClearStatus = await fetch(`${server.baseUrl}/api/auth/transcription/openai`, {
      headers: {
        authorization: 'Bearer valid-auth0-token',
      },
    })
    expect(afterClearStatus.status).toBe(200)
    expect(await afterClearStatus.json()).toEqual({
      configured: false,
      updatedAt: null,
    })

    await server.close()
  })
})
