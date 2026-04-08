import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { WhatsAppBridgeConfig } from '../bridge'
import { createWhatsAppBridgeRouter } from '../routes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunningServer {
  baseUrl: string
  httpServer: Server
  close: () => Promise<void>
}

async function startBridgeServer(config: WhatsAppBridgeConfig): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const bridge = createWhatsAppBridgeRouter({ config })
  app.use('/api/whatsapp', bridge.router)

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

async function postWebhook(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/webhook', () => {
  let server: RunningServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('returns 503 when bridge is disabled', async () => {
    server = await startBridgeServer({
      enabled: false,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hello',
    })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('WhatsApp bridge is disabled')
  })

  it('returns 400 for invalid payload', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'status',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hello',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('Unsupported event type: status')
  })

  it('returns 200 with filtered result for whitelisted phones that do not match', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'whitelist',
      whitelist: ['+19999999999'],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hello',
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { accepted: boolean; reason: string }
    expect(body.accepted).toBe(false)
    expect(body.reason).toBe('filtered')
  })

  it('returns 200 with filtered result for keyword filter when no keyword matches', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'keyword',
      whitelist: [],
      keywords: ['urgent', 'deploy'],
    })

    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Just a normal chat',
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { accepted: boolean; reason: string }
    expect(body.accepted).toBe(false)
    expect(body.reason).toBe('filtered')
  })

  it('returns 502 when forwarding fails (no channel-message endpoint)', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    // The bridge server has no channel-message endpoint mounted, so
    // forwarding to itself will produce a non-JSON response (404 HTML).
    // This exercises the error path.
    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hello commander',
    })

    // The server should respond — either 502 (fetch error) or a forwarded
    // non-200 status. Either way, the bridge should not crash.
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/whatsapp/webhook — Meta Cloud API verification
// ---------------------------------------------------------------------------

describe('GET /api/whatsapp/webhook — Meta verification', () => {
  let server: RunningServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('responds with challenge when verify token matches', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      verifyToken: 'my-secret-token',
    })

    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-secret-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await fetch(`${server.baseUrl}/api/whatsapp/webhook?${params}`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe('challenge_abc123')
  })

  it('returns 403 when verify token does not match', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      verifyToken: 'my-secret-token',
    })

    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await fetch(`${server.baseUrl}/api/whatsapp/webhook?${params}`)
    expect(response.status).toBe(403)
  })

  it('returns 403 when no verify token is configured', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'any-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await fetch(`${server.baseUrl}/api/whatsapp/webhook?${params}`)
    expect(response.status).toBe(403)
  })

  it('returns 403 when mode is not subscribe', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
      verifyToken: 'my-secret-token',
    })

    const params = new URLSearchParams({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'my-secret-token',
      'hub.challenge': 'challenge_abc123',
    })

    const response = await fetch(`${server.baseUrl}/api/whatsapp/webhook?${params}`)
    expect(response.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /api/whatsapp/webhook — Meta Cloud API format
// ---------------------------------------------------------------------------

describe('POST /api/whatsapp/webhook — Meta format', () => {
  let server: RunningServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  const metaTextPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: '100200300',
                display_phone_number: '+14155551234',
              },
              contacts: [
                {
                  profile: { name: 'Nick' },
                  wa_id: '15559876543',
                },
              ],
              messages: [
                {
                  from: '15559876543',
                  id: 'wamid.abc123',
                  timestamp: '1712345678',
                  text: { body: 'Hello from WhatsApp' },
                  type: 'text',
                },
              ],
            },
          },
        ],
      },
    ],
  }

  it('returns 503 when bridge is disabled for Meta format', async () => {
    server = await startBridgeServer({
      enabled: false,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, metaTextPayload)
    expect(response.status).toBe(503)
  })

  it('accepts Meta format with text messages and attempts forwarding', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, metaTextPayload)
    // Bridge is enabled, message parsed, but no channel-message endpoint mounted
    // so the forward fails gracefully. We still get 200 from Meta handler.
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      accepted: boolean
      messages: number
      results: Array<{ from: string; forwarded: boolean }>
    }
    expect(body.accepted).toBe(true)
    expect(body.messages).toBe(1)
    expect(body.results).toHaveLength(1)
    expect(body.results[0].from).toBe('15559876543')
  })

  it('returns 200 with zero messages for status-only payloads', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: 'wamid.abc', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    }

    const response = await postWebhook(server.baseUrl, statusPayload)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { accepted: boolean; messages: number }
    expect(body.accepted).toBe(true)
    expect(body.messages).toBe(0)
  })

  it('applies whitelist filter to Meta messages', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'whitelist',
      whitelist: ['+19999999999'],
      keywords: [],
    })

    const response = await postWebhook(server.baseUrl, metaTextPayload)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      accepted: boolean
      messages: number
      results: Array<{ from: string; forwarded: boolean }>
    }
    expect(body.messages).toBe(1)
    expect(body.results[0].forwarded).toBe(false)
  })

  it('still processes generic format alongside Meta detection', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'none',
      whitelist: [],
      keywords: [],
    })

    // Generic format should still work
    const response = await postWebhook(server.baseUrl, {
      accountId: 'default',
      event: 'message',
      chatType: 'direct',
      from: '+15551234567',
      text: 'Hello commander',
    })

    // Will attempt to forward (and fail since no channel-message endpoint),
    // but the important thing is it does not get confused with Meta format
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('GET /api/whatsapp/status', () => {
  let server: RunningServer | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('returns bridge status', async () => {
    server = await startBridgeServer({
      enabled: true,
      filterMode: 'whitelist',
      whitelist: ['+15551234567', '+15559876543'],
      keywords: [],
    })

    const response = await fetch(`${server.baseUrl}/api/whatsapp/status`)
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      enabled: boolean
      filterMode: string
      whitelistCount: number
      keywordCount: number
    }
    expect(body.enabled).toBe(true)
    expect(body.filterMode).toBe('whitelist')
    expect(body.whitelistCount).toBe(2)
    expect(body.keywordCount).toBe(0)
  })
})
