import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import type { ApiKeyStoreLike } from '../../api-keys/store'
import type {
  OpenAITranscriptionKeyStatus,
  OpenAITranscriptionKeyStoreLike,
} from '../../api-keys/transcription-store'
import {
  createRealtimeProxy,
  type RealtimeProxyOptions,
} from '../proxy'
import type { RealtimeTranscriptionClientLike } from '../openai-realtime'

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
  httpServer: Server
}

function createTestApiKeyStore(): ApiKeyStoreLike {
  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey, options) => {
      if (rawKey !== 'test-key') {
        return { ok: false, reason: 'not_found' as const }
      }

      const requiredScopes = options?.requiredScopes ?? []
      if (!requiredScopes.every((scope) => scope === 'agents:write')) {
        return { ok: false, reason: 'insufficient_scope' as const }
      }

      return {
        ok: true as const,
        record: {
          id: 'test-key-id',
          name: 'test',
          keyHash: 'hash',
          prefix: 'hmrb_test',
          createdBy: 'test',
          createdAt: '2026-02-28T00:00:00.000Z',
          lastUsedAt: null,
          scopes: ['agents:read', 'agents:write'],
        },
      }
    },
  }
}

function createTranscriptionKeyStore(
  status: OpenAITranscriptionKeyStatus,
  openAiApiKey: string | null,
): OpenAITranscriptionKeyStoreLike {
  return {
    getStatus: async () => status,
    getOpenAIApiKey: async () => openAiApiKey,
    setOpenAIApiKey: async () => undefined,
    clearOpenAIApiKey: async () => false,
  }
}

class MockRealtimeClient
  extends EventEmitter
  implements RealtimeTranscriptionClientLike
{
  connect = vi.fn(async () => undefined)
  sendAudio = vi.fn((_base64Audio: string) => undefined)
  commitAudioBuffer = vi.fn(() => {
    this.emit('final', 'hello from mock transcription')
  })
  close = vi.fn(() => undefined)
}

async function startServer(
  options: Partial<RealtimeProxyOptions> = {},
): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const realtime = createRealtimeProxy({
    apiKeyStore: createTestApiKeyStore(),
    transcriptionKeyStore: createTranscriptionKeyStore(
      {
        configured: true,
        updatedAt: '2026-02-28T00:00:00.000Z',
      },
      'sk-test-openai',
    ),
    ...options,
  })
  app.use('/api/realtime', realtime.router)

  const httpServer = createServer(app)
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/realtime/')) {
      realtime.handleUpgrade(req, socket, head)
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
    httpServer,
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

afterEach(() => {
  vi.clearAllMocks()
})

describe('realtime proxy routes', () => {
  it('requires auth for /api/realtime/config', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/realtime/config`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
    })

    await server.close()
  })

  it('returns whether OpenAI realtime transcription is configured', async () => {
    const server = await startServer()
    const response = await fetch(`${server.baseUrl}/api/realtime/config`, {
      headers: {
        'x-hammurabi-api-key': 'test-key',
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      openaiConfigured: true,
    })

    await server.close()
  })
})

describe('realtime proxy websocket', () => {
  it('streams audio chunks and final transcript through the websocket bridge', async () => {
    const mockClient = new MockRealtimeClient()
    const server = await startServer({
      createClient: () => mockClient,
    })

    const wsUrl =
      server.baseUrl.replace('http://', 'ws://') +
      '/api/realtime/transcription?api_key=test-key'
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_request, response) => {
        reject(new Error(`Unexpected websocket status ${response.statusCode}`))
      })
    })

    const finalMessage = new Promise<{ type: string; text: string }>((resolve, reject) => {
      ws.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as { type: string; text: string }
        if (payload.type === 'final') {
          resolve(payload)
        }
      })
      ws.on('error', reject)
    })

    ws.send(Buffer.from([0x01, 0x02, 0x03]))
    ws.send(JSON.stringify({ type: 'stop' }))

    const payload = await finalMessage
    expect(payload).toEqual({
      type: 'final',
      text: 'hello from mock transcription',
    })
    expect(mockClient.connect).toHaveBeenCalledTimes(1)
    expect(mockClient.sendAudio).toHaveBeenCalledWith('AQID')
    expect(mockClient.commitAudioBuffer).toHaveBeenCalledTimes(1)

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
    await server.close()
  })

  it('keeps connection open across multiple VAD final events', async () => {
    const mockClient = new MockRealtimeClient()
    // Override commitAudioBuffer to not emit final automatically
    mockClient.commitAudioBuffer = vi.fn()
    const server = await startServer({
      createClient: () => mockClient,
    })

    const wsUrl =
      server.baseUrl.replace('http://', 'ws://') +
      '/api/realtime/transcription?api_key=test-key'
    const ws = new WebSocket(wsUrl)

    // Attach message listener before open to avoid missing the ready message
    const received: Array<{ type: string; text?: string }> = []
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as { type: string; text?: string })
    })

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_request, response) => {
        reject(new Error(`Unexpected websocket status ${response.statusCode}`))
      })
    })

    // Wait for the ready message from the proxy
    await new Promise<void>((resolve) => {
      if (received.some((m) => m.type === 'ready')) {
        resolve()
        return
      }
      const onMsg = () => {
        if (received.some((m) => m.type === 'ready')) {
          ws.off('message', onMsg)
          resolve()
        }
      }
      ws.on('message', onMsg)
    })

    // Simulate two VAD segments (speaker pauses mid-utterance)
    mockClient.emit('final', 'first segment')
    mockClient.emit('final', 'second segment')

    // Give messages time to arrive
    await new Promise((resolve) => setTimeout(resolve, 50))

    const finals = received.filter((m) => m.type === 'final')
    expect(finals).toEqual([
      { type: 'final', text: 'first segment' },
      { type: 'final', text: 'second segment' },
    ])

    // Connection should still be open after multiple finals
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.close()
    await server.close()
  })

  it('rejects websocket upgrades when no OpenAI key is configured', async () => {
    const server = await startServer({
      transcriptionKeyStore: createTranscriptionKeyStore(
        {
          configured: false,
          updatedAt: null,
        },
        null,
      ),
    })

    const wsUrl =
      server.baseUrl.replace('http://', 'ws://') +
      '/api/realtime/transcription?api_key=test-key'
    const ws = new WebSocket(wsUrl)

    const error = await new Promise<Error>((resolve) => {
      ws.once('unexpected-response', (_request, response) => {
        resolve(new Error(`status:${response.statusCode}`))
      })
    })
    expect(error.message).toContain('412')

    await server.close()
  })
})
