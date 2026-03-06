import { describe, expect, it } from 'vitest'
import express from 'express'
import type { ApiKeyStoreLike } from '../../api-keys/store'
import { combinedAuth } from '../combined-auth'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

async function startServer(
  middleware: ReturnType<typeof combinedAuth>,
): Promise<RunningServer> {
  const app = express()
  app.use('/protected', middleware, (req, res) => {
    res.json({
      authMode: req.authMode ?? null,
      userId: req.user?.id ?? null,
    })
  })

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

function createManagedKeyStore(): ApiKeyStoreLike {
  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey) => {
      if (rawKey === 'managed-key') {
        return {
          ok: true,
          record: {
            id: 'key-1',
            name: 'Managed',
            keyHash: 'hash',
            prefix: 'hmrb_abcd',
            createdBy: 'ops@example.com',
            createdAt: '2026-02-16T00:00:00.000Z',
            lastUsedAt: '2026-02-16T00:01:00.000Z',
            scopes: ['services:write'],
          },
        }
      }

      return {
        ok: false,
        reason: 'not_found',
      }
    },
  }
}

describe('combinedAuth', () => {
  it('prioritizes Auth0 when both Auth0 and API key credentials are present', async () => {
    const middleware = combinedAuth({
      apiKeyStore: createManagedKeyStore(),
      verifyToken: async (token) => {
        if (token !== 'auth0-token') {
          throw new Error('invalid')
        }

        return {
          id: 'auth0|user-1',
          email: 'user@example.com',
        }
      },
    })
    const server = await startServer(middleware)

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer auth0-token',
        'x-hammurabi-api-key': 'managed-key',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authMode: 'auth0',
      userId: 'auth0|user-1',
    })

    await server.close()
  })

  it('falls back to API key auth when Auth0 verification fails', async () => {
    const middleware = combinedAuth({
      apiKeyStore: createManagedKeyStore(),
      requiredApiKeyScopes: ['services:write'],
      verifyToken: async () => {
        throw new Error('invalid token')
      },
    })
    const server = await startServer(middleware)

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer managed-key',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authMode: 'api-key',
      userId: 'api-key',
    })

    await server.close()
  })

  it('accepts valid internal token via x-hammurabi-internal-token header', async () => {
    const middleware = combinedAuth({
      internalToken: 'server-secret-abc',
    })
    const server = await startServer(middleware)

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        'x-hammurabi-internal-token': 'server-secret-abc',
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authMode: 'api-key',
      userId: 'internal',
    })

    await server.close()
  })

  it('rejects invalid internal token and falls through to other auth', async () => {
    const middleware = combinedAuth({
      internalToken: 'server-secret-abc',
      apiKeyStore: createManagedKeyStore(),
    })
    const server = await startServer(middleware)

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        'x-hammurabi-internal-token': 'wrong-token',
      },
    })
    expect(response.status).toBe(401)

    await server.close()
  })

  it('returns API key scope errors when bearer credentials fail both paths', async () => {
    const apiKeyStore: ApiKeyStoreLike = {
      hasAnyKeys: async () => true,
      verifyKey: async () => ({
        ok: false,
        reason: 'insufficient_scope',
      }),
    }

    const middleware = combinedAuth({
      apiKeyStore,
      requiredApiKeyScopes: ['services:write'],
      verifyToken: async () => {
        throw new Error('invalid token')
      },
    })
    const server = await startServer(middleware)

    const response = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer managed-key',
      },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Insufficient API key scope',
    })

    await server.close()
  })
})
