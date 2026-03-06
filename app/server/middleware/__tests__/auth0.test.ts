import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { auth0Middleware } from '../auth0'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
}

async function startServer(options: Parameters<typeof auth0Middleware>[0]): Promise<RunningServer> {
  const app = express()
  app.use('/protected', auth0Middleware(options), (_req, res) => {
    res.json({ ok: true })
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

describe('auth0Middleware', () => {
  it('returns 503 when Auth0 is not configured', async () => {
    vi.stubEnv('AUTH0_DOMAIN', '')
    vi.stubEnv('AUTH0_AUDIENCE', '')
    vi.stubEnv('AUTH0_CLIENT_ID', '')
    const server = await startServer({})

    const response = await fetch(`${server.baseUrl}/protected`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Auth0 is not configured',
    })

    await server.close()
    vi.unstubAllEnvs()
  })

  it('returns 401 when bearer token is missing', async () => {
    const server = await startServer({
      verifyToken: async () => ({
        id: 'user-1',
        email: 'user@example.com',
      }),
    })

    const response = await fetch(`${server.baseUrl}/protected`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Missing authorization token',
    })

    await server.close()
  })

  it('accepts valid Auth0 tokens and rejects invalid ones', async () => {
    const server = await startServer({
      verifyToken: async (token) => {
        if (token !== 'valid-token') {
          throw new Error('invalid token')
        }

        return {
          id: 'auth0|abc',
          email: 'user@example.com',
        }
      },
    })

    const denied = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer invalid-token',
      },
    })
    expect(denied.status).toBe(401)

    const allowed = await fetch(`${server.baseUrl}/protected`, {
      headers: {
        authorization: 'Bearer valid-token',
      },
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true })

    await server.close()
  })
})
