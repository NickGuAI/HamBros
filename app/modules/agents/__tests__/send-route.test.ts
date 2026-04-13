import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  }
})

import { createAgentsRouter, type AgentsRouterOptions } from '../routes'
import { spawn as spawnFn } from 'node:child_process'

const mockedSpawn = vi.mocked(spawnFn)

interface RunningServer {
  baseUrl: string
  close: () => Promise<void>
  httpServer: Server
}

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

function createTestApiKeyStore(): ApiKeyStoreLike {
  const record: import('../../../server/api-keys/store').ApiKeyRecord = {
    id: 'test-key-id',
    name: 'Test Key',
    keyHash: 'hash',
    prefix: 'hmrb_test',
    createdBy: 'test',
    createdAt: '2026-03-01T00:00:00.000Z',
    lastUsedAt: null,
    scopes: ['agents:read', 'agents:write'],
  }

  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey, options) => {
      if (rawKey !== 'test-key') {
        return { ok: false, reason: 'not_found' as const }
      }

      const requiredScopes = options?.requiredScopes ?? []
      const hasAllScopes = requiredScopes.every((scope) => record.scopes.includes(scope))
      if (!hasAllScopes) {
        return { ok: false, reason: 'insufficient_scope' as const }
      }

      return {
        ok: true as const,
        record,
      }
    },
  }
}

async function startServer(options: Partial<AgentsRouterOptions> = {}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const agents = createAgentsRouter({
    apiKeyStore: createTestApiKeyStore(),
    autoResumeSessions: false,
    commanderSessionStorePath: '/tmp/nonexistent-send-route-test.json',
    ...options,
  })
  app.use('/api/agents', agents.router)

  const httpServer = createServer(app)
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/agents/')) {
      agents.handleUpgrade(req, socket, head)
    } else {
      socket.destroy()
    }
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

interface MockCodexRuntimeHarness {
  requests: Array<{ method: string; params: unknown }>
  turnStartInputs: string[]
  getRuntimeSpawnCount(): number
  getStartedThreadIds(): string[]
  close(): Promise<void>
}

function installMockCodexSidecar(): MockCodexRuntimeHarness {
  const turnStartInputs: string[] = []
  const requests: Array<{ method: string; params: unknown }> = []
  const startedThreadIds: string[] = []
  const servers = new Set<WebSocketServer>()
  let threadCounter = 0
  let runtimeSpawnCount = 0

  mockedSpawn.mockImplementation((command, args) => {
    if (command !== 'codex' || !Array.isArray(args) || args[0] !== 'app-server') {
      throw new Error(`Unexpected spawn call in send-route.test: ${command}`)
    }

    const listenIndex = args.indexOf('--listen')
    if (listenIndex === -1) {
      throw new Error('Missing --listen flag for mocked Codex runtime')
    }

    const listenTarget = args[listenIndex + 1]
    const match = typeof listenTarget === 'string' ? listenTarget.match(/:(\d+)$/) : null
    if (!match) {
      throw new Error('Missing codex sidecar listen port')
    }

    runtimeSpawnCount += 1
    const runtimeEmitter = new EventEmitter()
    let exited = false
    const emitExit = (code: number | null, signal: string | null = null) => {
      if (exited) {
        return
      }
      exited = true
      runtimeProcess.exitCode = code
      runtimeProcess.signalCode = signal
      runtimeEmitter.emit('exit', code, signal)
      runtimeEmitter.emit('close', code, signal)
    }
    const runtimeProcess = Object.assign(runtimeEmitter, {
      pid: process.pid,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn((signal?: string) => {
        emitExit(null, typeof signal === 'string' ? signal : 'SIGTERM')
        return true
      }),
    })

    const port = Number(match[1])
    const sidecarServer = new WebSocketServer({ host: '127.0.0.1', port })
    servers.add(sidecarServer)
    sidecarServer.on('connection', (socket) => {
      socket.on('message', (data) => {
        const raw = JSON.parse(data.toString()) as {
          id?: number
          method?: string
          params?: unknown
        }

        if (typeof raw.id !== 'number' || typeof raw.method !== 'string') {
          return
        }

        requests.push({ method: raw.method, params: raw.params })

        if (raw.method === 'thread/start') {
          threadCounter += 1
          const threadId = `thread-test-${threadCounter}`
          startedThreadIds.push(threadId)
          socket.send(JSON.stringify({ id: raw.id, result: { thread: { id: threadId } } }))
          return
        }

        if (raw.method === 'turn/start') {
          const params = (raw.params && typeof raw.params === 'object')
            ? raw.params as { input?: Array<{ text?: unknown }> }
            : {}
          const textValue = Array.isArray(params.input)
            && params.input.length > 0
            && typeof params.input[0]?.text === 'string'
            ? params.input[0].text
            : ''
          turnStartInputs.push(textValue)
          socket.send(JSON.stringify({ id: raw.id, result: { turn: { id: `turn-${turnStartInputs.length}` } } }))
          return
        }

        socket.send(JSON.stringify({ id: raw.id, result: {} }))
      })
    })

    return runtimeProcess as never
  })

  return {
    requests,
    turnStartInputs,
    getRuntimeSpawnCount: () => runtimeSpawnCount,
    getStartedThreadIds: () => [...startedThreadIds],
    close: async () => {
      const closeJobs = [...servers].map(async (server) => {
        for (const client of server.clients) {
          client.close()
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
      })
      await Promise.all(closeJobs)
      servers.clear()
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /sessions/:name/send (codex)', () => {
  it('routes through codex turn/start for codex sessions', async () => {
    const codexSidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-http-send',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })

      expect(createResponse.status).toBe(201)

      const sendResponse = await fetch(`${server.baseUrl}/api/agents/sessions/codex-http-send/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'codex send input' }),
      })

      expect(sendResponse.status).toBe(200)
      expect(await sendResponse.json()).toEqual({ sent: true })

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['codex send input'])
      })
      expect(codexSidecar.requests.some((request) => request.method === 'turn/start')).toBe(true)
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  })

  it('spawns one Codex runtime per session and routes sends without cross-session coupling', async () => {
    const codexSidecar = installMockCodexSidecar()
    const server = await startServer()

    try {
      const createAlpha = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-http-send-alpha',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createAlpha.status).toBe(201)

      const createBeta = await fetch(`${server.baseUrl}/api/agents/sessions`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'codex-http-send-beta',
          mode: 'default',
          sessionType: 'stream',
          agentType: 'codex',
        }),
      })
      expect(createBeta.status).toBe(201)

      await vi.waitFor(() => {
        expect(codexSidecar.getRuntimeSpawnCount()).toBe(2)
        expect(codexSidecar.getStartedThreadIds()).toHaveLength(2)
      })

      const sendAlpha = await fetch(`${server.baseUrl}/api/agents/sessions/codex-http-send-alpha/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'alpha input' }),
      })
      expect(sendAlpha.status).toBe(200)

      const sendBeta = await fetch(`${server.baseUrl}/api/agents/sessions/codex-http-send-beta/send`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'beta input' }),
      })
      expect(sendBeta.status).toBe(200)

      await vi.waitFor(() => {
        expect(codexSidecar.turnStartInputs).toEqual(['alpha input', 'beta input'])
      })

      const turnRequests = codexSidecar.requests.filter((request) => request.method === 'turn/start')
      expect(turnRequests).toHaveLength(2)
      const threadIds = turnRequests.map((request) => {
        const params = request.params as { threadId?: unknown }
        return typeof params.threadId === 'string' ? params.threadId : null
      })
      expect(threadIds.filter((id): id is string => id !== null)).toHaveLength(2)
      expect(new Set(threadIds.filter((id): id is string => id !== null)).size).toBe(2)
    } finally {
      await server.close()
      await codexSidecar.close()
    }
  })
})
