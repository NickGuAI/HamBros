import { describe, expect, it } from 'vitest'
import express from 'express'
import type { ApiKeyRecord, ApiKeyStoreLike } from '../../api-keys/store'
import { apiKeyAuth } from '../auth'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

function createManagedRecord(): ApiKeyRecord {
  return {
    id: 'key-1',
    name: 'Managed',
    keyHash: 'hash',
    prefix: 'hmrb_abcd',
    createdBy: 'ops@example.com',
    createdAt: '2026-02-16T00:00:00.000Z',
    lastUsedAt: null,
    scopes: ['telemetry:write'],
  }
}

async function startServer(
  options: {
    apiKeyStore?: ApiKeyStoreLike
    requiredScopes?: readonly string[]
  } = {},
): Promise<RunningServer> {
  const app = express()
  app.use(express.json())
  app.get(
    '/protected',
    apiKeyAuth({
      apiKeyStore: options.apiKeyStore,
      requiredScopes: options.requiredScopes,
      unconfiguredMessage: 'API key missing',
    }),
    (req, res) => {
      res.json({
        authMode: req.authMode,
        user: req.user,
      })
    },
  )

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve server address')
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

describe('apiKeyAuth', () => {
  it('returns 503 when no API key store is configured', async () => {
    const server = await startServer()

    const response = await fetch(`${server.baseUrl}/protected`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'API key missing',
    })

    await server.close()
  })

  it('returns 503 when API key store has no keys', async () => {
    const apiKeyStore: ApiKeyStoreLike = {
      hasAnyKeys: async () => false,
      verifyKey: async () => ({ ok: false, reason: 'not_found' }),
    }

    const server = await startServer({ apiKeyStore })

    const response = await fetch(`${server.baseUrl}/protected`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'API key missing',
    })

    await server.close()
  })

  it('accepts managed API keys across supported header formats', async () => {
    const apiKeyStore: ApiKeyStoreLike = {
      hasAnyKeys: async () => true,
      verifyKey: async () => ({ ok: true, record: createManagedRecord() }),
    }

    const server = await startServer({ apiKeyStore })

    const byPrimaryHeader = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        'x-hammurabi-api-key': 'managed-key',
      },
    })
    expect(byPrimaryHeader.status).toBe(200)

    const bySecondaryHeader = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        'x-api-key': 'managed-key',
      },
    })
    expect(bySecondaryHeader.status).toBe(200)

    const byBearer = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer managed-key',
      },
    })
    expect(byBearer.status).toBe(200)
    expect(await byBearer.json()).toMatchObject({
      authMode: 'api-key',
      user: {
        id: 'api-key',
        email: 'system',
      },
    })

    await server.close()
  })

  it('checks managed key scopes and returns 403 for insufficient scopes', async () => {
    const apiKeyStore: ApiKeyStoreLike = {
      hasAnyKeys: async () => true,
      verifyKey: async (_rawKey, options) => {
        const requiredScopes = options?.requiredScopes ?? []
        if (requiredScopes.includes('telemetry:write')) {
          return { ok: true, record: createManagedRecord() }
        }
        return { ok: false, reason: 'insufficient_scope' }
      },
    }

    const server = await startServer({
      apiKeyStore,
      requiredScopes: ['services:write'],
    })

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        'x-hammurabi-api-key': 'managed-key',
      },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Insufficient API key scope',
    })

    await server.close()
  })
})
