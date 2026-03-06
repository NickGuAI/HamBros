import { Router } from 'express'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../api-keys/store.js'
import {
  OpenAITranscriptionKeyStore,
  type OpenAITranscriptionKeyStoreLike,
} from '../api-keys/transcription-store.js'
import { combinedAuth } from '../middleware/combined-auth.js'
import { createAuth0Verifier } from '../middleware/auth0.js'
import {
  OpenAIRealtimeClient,
  type RealtimeTranscriptionClientLike,
} from './openai-realtime.js'

const DEFAULT_WS_KEEPALIVE_INTERVAL_MS = 30000

interface BrowserControlMessage {
  type?: unknown
}

export interface RealtimeProxyOptions {
  apiKeyStore?: ApiKeyStoreLike
  transcriptionKeyStore?: OpenAITranscriptionKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  wsKeepAliveIntervalMs?: number
  createClient?: (options: {
    apiKey: string
    language: string
  }) => RealtimeTranscriptionClientLike
}

export interface RealtimeProxyResult {
  router: Router
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeLanguage(value: string | null): string {
  if (!value) {
    return 'en'
  }

  const normalized = value.trim()
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(normalized)) {
    return 'en'
  }

  return normalized
}

function parseKeepAliveIntervalMs(rawValue: unknown): number {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WS_KEEPALIVE_INTERVAL_MS
  }
  return parsed
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return
  }
  ws.send(JSON.stringify(payload))
}

function toBase64AudioChunk(data: RawData): string | null {
  if (typeof data === 'string') {
    return null
  }

  if (data instanceof ArrayBuffer) {
    const buffer = Buffer.from(data)
    return buffer.length > 0 ? buffer.toString('base64') : null
  }

  if (Array.isArray(data)) {
    const buffer = Buffer.concat(data.map((chunk) => Buffer.from(chunk)))
    return buffer.length > 0 ? buffer.toString('base64') : null
  }

  const buffer = Buffer.from(data)
  return buffer.length > 0 ? buffer.toString('base64') : null
}

function attachWebSocketKeepAlive(
  ws: WebSocket,
  intervalMs: number,
  onStale: () => void,
): () => void {
  let waitingForPong = false
  let stopped = false

  const stop = () => {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(interval)
    ws.off('pong', onPong)
    ws.off('close', onCloseOrError)
    ws.off('error', onCloseOrError)
  }

  const onPong = () => {
    waitingForPong = false
  }

  const onCloseOrError = () => {
    stop()
  }

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }

    if (waitingForPong) {
      onStale()
      ws.terminate()
      stop()
      return
    }

    waitingForPong = true
    ws.ping()
  }, intervalMs)

  ws.on('pong', onPong)
  ws.on('close', onCloseOrError)
  ws.on('error', onCloseOrError)

  return stop
}

export function createRealtimeProxy(options: RealtimeProxyOptions = {}): RealtimeProxyResult {
  const router = Router()
  const wss = new WebSocketServer({ noServer: true })
  const transcriptionKeyStore =
    options.transcriptionKeyStore ?? new OpenAITranscriptionKeyStore()
  const wsKeepAliveIntervalMs = parseKeepAliveIntervalMs(options.wsKeepAliveIntervalMs)
  const createClient =
    options.createClient ??
    ((clientOptions: { apiKey: string; language: string }) =>
      new OpenAIRealtimeClient(clientOptions))

  const requireRealtimeAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['agents:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  router.get('/config', requireRealtimeAccess, async (_req, res) => {
    try {
      const status = await transcriptionKeyStore.getStatus()
      res.json({
        openaiConfigured: status.configured,
      })
    } catch {
      res.status(500).json({ error: 'Failed to read realtime transcription settings' })
    }
  })

  const auth0Verifier = createAuth0Verifier({
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
  })

  async function verifyWsAuth(req: IncomingMessage): Promise<boolean> {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const accessToken = url.searchParams.get('access_token')
    const apiKeyParam = url.searchParams.get('api_key')
    const apiKeyHeader = req.headers['x-hammurabi-api-key'] as string | undefined
    const token = accessToken ?? apiKeyParam ?? apiKeyHeader

    if (!token) {
      return false
    }

    if (auth0Verifier) {
      try {
        await auth0Verifier(token)
        return true
      } catch {
        // Fall through to API key validation.
      }
    }

    if (options.apiKeyStore) {
      const result = await options.apiKeyStore.verifyKey(token, {
        requiredScopes: ['agents:write'],
      })
      return result.ok
    }

    return false
  }

  function isTranscriptionRoute(url: URL): boolean {
    return url.pathname === '/api/realtime/transcription'
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    if (!isTranscriptionRoute(url)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    void verifyWsAuth(req).then(async (authorized) => {
      if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const openaiApiKey = await transcriptionKeyStore.getOpenAIApiKey()
      if (!openaiApiKey) {
        socket.write('HTTP/1.1 412 Precondition Failed\r\n\r\n')
        socket.destroy()
        return
      }

      const language = normalizeLanguage(url.searchParams.get('language'))
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = createClient({
          apiKey: openaiApiKey,
          language,
        })

        const stopKeepAlive = attachWebSocketKeepAlive(ws, wsKeepAliveIntervalMs, () => {
          client.close()
        })

        let finalized = false
        let disposed = false
        let pendingStop = false

        const dispose = () => {
          if (disposed) {
            return
          }
          disposed = true
          stopKeepAlive()
          client.close()
        }

        client.on('partial', (text: unknown) => {
          const partialText = asNonEmptyString(text)
          if (!partialText) {
            return
          }
          sendJson(ws, {
            type: 'partial',
            text: partialText,
          })
        })

        client.on('final', (text: unknown) => {
          const finalText = asNonEmptyString(text)
          if (!finalText) {
            return
          }
          finalized = true
          sendJson(ws, {
            type: 'final',
            text: finalText,
          })
          if (pendingStop && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Transcription completed')
          }
        })

        client.on('error', (message: unknown) => {
          sendJson(ws, {
            type: 'error',
            message:
              asNonEmptyString(message) ??
              'Realtime transcription failed',
          })
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Realtime transcription failed')
          }
        })

        client.on('close', () => {
          if (!finalized && ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Realtime upstream closed')
          }
        })

        ws.on('message', (rawData, isBinary) => {
          if (isBinary) {
            const base64Audio = toBase64AudioChunk(rawData)
            if (base64Audio) {
              client.sendAudio(base64Audio)
            }
            return
          }

          let message: BrowserControlMessage
          try {
            message = JSON.parse(rawData.toString()) as BrowserControlMessage
          } catch {
            return
          }

          const messageType = asNonEmptyString(message.type)
          if (messageType === 'stop') {
            pendingStop = true
            client.commitAudioBuffer()
          }
        })

        ws.on('close', () => {
          dispose()
        })

        ws.on('error', () => {
          dispose()
        })

        void client.connect().then(
          () => {
            sendJson(ws, {
              type: 'ready',
            })
          },
          (error) => {
            const message =
              error instanceof Error ? error.message : 'Failed to initialize realtime transcription'
            sendJson(ws, {
              type: 'error',
              message,
            })
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1011, 'Realtime initialization failed')
            }
            dispose()
          },
        )
      })
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    })
  }

  return {
    router,
    handleUpgrade,
  }
}
