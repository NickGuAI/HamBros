import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import type { CommanderSessionsInterface } from '../../agents/routes'
import {
  createCommandersRouter,
  type CommanderChannelReplyDispatchInput,
  type CommandersRouterOptions,
} from '../routes'

vi.setConfig({ testTimeout: 60_000 })

const AUTH_HEADERS = {
  'x-hammurabi-api-key': 'test-key',
}

interface RunningServer {
  baseUrl: string
  httpServer: Server
  close: () => Promise<void>
}

interface MockSessionsInterface {
  interface: CommanderSessionsInterface
  sendCalls: Array<{ name: string; text: string }>
}

interface MockChannelReplyDispatchers {
  dispatchers: NonNullable<CommandersRouterOptions['channelReplyDispatchers']>
  calls: CommanderChannelReplyDispatchInput[]
}

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

afterEach(async () => {
  await sleep(75)
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ),
  )
})

function createTestApiKeyStore(): ApiKeyStoreLike {
  const recordsByRawKey = {
    'test-key': {
      id: 'test-key-id',
      name: 'Test Key',
      keyHash: 'hash',
      prefix: 'hmrb_test',
      createdBy: 'test',
      createdAt: '2026-03-01T00:00:00.000Z',
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

function createMockSessionsInterface(): MockSessionsInterface {
  const sendCalls: Array<{ name: string; text: string }> = []
  const activeSessions = new Set<string>()

  const sessionsInterface: CommanderSessionsInterface = {
    async createCommanderSession(params) {
      activeSessions.add(params.name)
      return { kind: 'stream', name: params.name } as unknown as Awaited<ReturnType<
        CommanderSessionsInterface['createCommanderSession']
      >>
    },
    async sendToSession(name, text) {
      sendCalls.push({ name, text })
      return activeSessions.has(name)
    },
    deleteSession(name) {
      activeSessions.delete(name)
    },
    getSession(name) {
      if (!activeSessions.has(name)) {
        return undefined
      }

      return {
        kind: 'stream',
        name,
        agentType: 'claude',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
      } as unknown as ReturnType<CommanderSessionsInterface['getSession']>
    },
    subscribeToEvents() {
      return () => {}
    },
  }

  return {
    interface: sessionsInterface,
    sendCalls,
  }
}

function createMockChannelReplyDispatchers(): MockChannelReplyDispatchers {
  const calls: CommanderChannelReplyDispatchInput[] = []
  const capture = async (input: CommanderChannelReplyDispatchInput): Promise<void> => {
    calls.push({
      commanderId: input.commanderId,
      message: input.message,
      channelMeta: { ...input.channelMeta },
      lastRoute: { ...input.lastRoute },
    })
  }

  return {
    dispatchers: {
      whatsapp: capture,
      telegram: capture,
      discord: capture,
    },
    calls,
  }
}

async function startServer(options: {
  sessionStorePath: string
  sessionsInterface: CommanderSessionsInterface
  channelReplyDispatchers?: NonNullable<CommandersRouterOptions['channelReplyDispatchers']>
}): Promise<RunningServer> {
  const app = express()
  app.use(express.json())

  const commanders = createCommandersRouter({
    apiKeyStore: createTestApiKeyStore(),
    sessionStorePath: options.sessionStorePath,
    sessionsInterface: options.sessionsInterface,
    refreshCommanderMemoryIndex: async () => {},
    channelReplyDispatchers: options.channelReplyDispatchers,
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

async function postChannelMessage(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/commanders/channel-message`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function postChannelReply(
  baseUrl: string,
  commanderId: string,
  message: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/commanders/${encodeURIComponent(commanderId)}/channel-reply`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message }),
  })
}

describe('POST /api/commanders/channel-message', () => {
  it('maps WhatsApp direct chats per account and reuses the same commander on key hit', async () => {
    const dir = await createTempDir('hammurabi-channel-whatsapp-')
    const mock = createMockSessionsInterface()
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: mock.interface,
    })

    try {
      const firstResponse = await postChannelMessage(server.baseUrl, {
        provider: 'whatsapp',
        accountId: 'default',
        chatType: 'direct',
        peerId: '15551234567',
        displayName: '+1 555 123 4567',
        message: 'hello one',
      })
      expect(firstResponse.status).toBe(201)
      const firstBody = await firstResponse.json() as {
        accepted: boolean
        delivered: boolean
        created: boolean
        commanderId: string
        sessionKey: string
      }
      expect(firstBody.accepted).toBe(true)
      expect(firstBody.delivered).toBe(false)
      expect(firstBody.created).toBe(true)
      expect(firstBody.sessionKey).toBe('whatsapp:default:direct:15551234567')

      const secondResponse = await postChannelMessage(server.baseUrl, {
        provider: 'whatsapp',
        accountId: 'default',
        chatType: 'direct',
        peerId: '15551234567',
        displayName: '+1 555 123 4567',
        message: 'hello two',
      })
      expect(secondResponse.status).toBe(200)
      const secondBody = await secondResponse.json() as {
        accepted: boolean
        delivered: boolean
        created: boolean
        commanderId: string
      }
      expect(secondBody.accepted).toBe(true)
      expect(secondBody.delivered).toBe(false)
      expect(secondBody.created).toBe(false)
      expect(secondBody.commanderId).toBe(firstBody.commanderId)

      const thirdResponse = await postChannelMessage(server.baseUrl, {
        provider: 'whatsapp',
        accountId: 'work',
        chatType: 'direct',
        peerId: '15551234567',
        displayName: '+1 555 123 4567',
        message: 'hello three',
      })
      expect(thirdResponse.status).toBe(201)
      const thirdBody = await thirdResponse.json() as {
        accepted: boolean
        delivered: boolean
        created: boolean
        commanderId: string
        sessionKey: string
      }
      expect(thirdBody.accepted).toBe(true)
      expect(thirdBody.delivered).toBe(false)
      expect(thirdBody.created).toBe(true)
      expect(thirdBody.commanderId).not.toBe(firstBody.commanderId)
      expect(thirdBody.sessionKey).toBe('whatsapp:work:direct:15551234567')

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      expect(listResponse.status).toBe(200)
      const sessions = await listResponse.json() as Array<{
        id: string
        channelMeta?: { sessionKey?: string }
      }>
      expect(sessions).toHaveLength(2)
      expect(sessions.map((session) => session.channelMeta?.sessionKey).sort()).toEqual([
        'whatsapp:default:direct:15551234567',
        'whatsapp:work:direct:15551234567',
      ])
    } finally {
      await server.close()
    }
  })

  it('maps Telegram forum topics per thread and group chats per chat id', async () => {
    const dir = await createTempDir('hammurabi-channel-telegram-')
    const mock = createMockSessionsInterface()
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: mock.interface,
    })

    try {
      const groupResponse = await postChannelMessage(server.baseUrl, {
        provider: 'telegram',
        accountId: 'default',
        chatType: 'group',
        peerId: 'supergroup-9876543',
        displayName: 'Ops Group',
        message: 'group ping',
      })
      expect(groupResponse.status).toBe(201)

      const topicOne = await postChannelMessage(server.baseUrl, {
        provider: 'telegram',
        accountId: 'default',
        chatType: 'forum-topic',
        peerId: 'supergroup-9876543',
        threadId: '42',
        displayName: 'Ops Group / Deploys',
        message: 'topic one',
      })
      expect(topicOne.status).toBe(201)
      const topicOneBody = await topicOne.json() as { created: boolean; commanderId: string; sessionKey: string }
      expect(topicOneBody.created).toBe(true)
      expect(topicOneBody.sessionKey).toBe('telegram:default:forum-topic:supergroup-9876543:thread:42')

      const topicOneRepeat = await postChannelMessage(server.baseUrl, {
        provider: 'telegram',
        accountId: 'default',
        chatType: 'forum-topic',
        peerId: 'supergroup-9876543',
        threadId: '42',
        displayName: 'Ops Group / Deploys',
        message: 'topic one repeat',
      })
      expect(topicOneRepeat.status).toBe(200)
      const topicOneRepeatBody = await topicOneRepeat.json() as { created: boolean; commanderId: string }
      expect(topicOneRepeatBody.created).toBe(false)
      expect(topicOneRepeatBody.commanderId).toBe(topicOneBody.commanderId)

      const topicTwo = await postChannelMessage(server.baseUrl, {
        provider: 'telegram',
        accountId: 'default',
        chatType: 'forum-topic',
        peerId: 'supergroup-9876543',
        threadId: '43',
        displayName: 'Ops Group / Incidents',
        message: 'topic two',
      })
      expect(topicTwo.status).toBe(201)
      const topicTwoBody = await topicTwo.json() as { created: boolean; sessionKey: string }
      expect(topicTwoBody.created).toBe(true)
      expect(topicTwoBody.sessionKey).toBe('telegram:default:forum-topic:supergroup-9876543:thread:43')

      const listResponse = await fetch(`${server.baseUrl}/api/commanders`, {
        headers: AUTH_HEADERS,
      })
      const sessions = await listResponse.json() as Array<{
        channelMeta?: { sessionKey?: string }
      }>
      expect(sessions).toHaveLength(3)
      expect(sessions.map((session) => session.channelMeta?.sessionKey).sort()).toEqual([
        'telegram:default:forum-topic:supergroup-9876543:thread:42',
        'telegram:default:forum-topic:supergroup-9876543:thread:43',
        'telegram:default:group:supergroup-9876543',
      ])
    } finally {
      await server.close()
    }
  })

  it('maps Discord threads to the parent channel commander and updates lastRoute.threadId', async () => {
    const dir = await createTempDir('hammurabi-channel-discord-')
    const mock = createMockSessionsInterface()
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: mock.interface,
    })

    try {
      const seedResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'chan-ops',
        displayName: '#partner-support',
        message: 'seed channel',
      })
      expect(seedResponse.status).toBe(201)
      const seedBody = await seedResponse.json() as { commanderId: string; created: boolean }
      expect(seedBody.created).toBe(true)

      const startResponse = await fetch(`${server.baseUrl}/api/commanders/${seedBody.commanderId}/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      expect(startResponse.status).toBe(200)

      const threadOneResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'thread-111',
        parentPeerId: 'chan-ops',
        threadId: 'thread-111',
        displayName: '#partner-support',
        message: 'thread one message',
      })
      expect(threadOneResponse.status).toBe(200)
      const threadOneBody = await threadOneResponse.json() as {
        created: boolean
        delivered: boolean
        commanderId: string
        sessionKey: string
      }
      expect(threadOneBody.created).toBe(false)
      expect(threadOneBody.delivered).toBe(true)
      expect(threadOneBody.commanderId).toBe(seedBody.commanderId)
      expect(threadOneBody.sessionKey).toBe('discord:default:channel:chan-ops')

      const threadTwoResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'thread-222',
        parentPeerId: 'chan-ops',
        threadId: 'thread-222',
        displayName: '#partner-support',
        message: 'thread two message',
      })
      expect(threadTwoResponse.status).toBe(200)

      expect(mock.sendCalls.some((call) => call.text === 'thread one message')).toBe(true)
      expect(mock.sendCalls.some((call) => call.text === 'thread two message')).toBe(true)

      const detailResponse = await fetch(`${server.baseUrl}/api/commanders/${seedBody.commanderId}`, {
        headers: AUTH_HEADERS,
      })
      expect(detailResponse.status).toBe(200)
      const detail = await detailResponse.json() as {
        channelMeta?: { peerId?: string }
        lastRoute?: { to?: string; threadId?: string }
      }
      expect(detail.channelMeta?.peerId).toBe('chan-ops')
      expect(detail.lastRoute).toEqual({
        channel: 'discord',
        to: 'chan-ops',
        accountId: 'default',
        threadId: 'thread-222',
      })
    } finally {
      await server.close()
    }
  })
})

describe('POST /api/commanders/:id/channel-reply', () => {
  it('delivers replies using persisted lastRoute after restart', async () => {
    const dir = await createTempDir('hammurabi-channel-reply-restart-')
    const initialSessions = createMockSessionsInterface()
    const outbound = createMockChannelReplyDispatchers()
    const firstServer = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: initialSessions.interface,
      channelReplyDispatchers: outbound.dispatchers,
    })

    let commanderId = ''
    try {
      const inbound = await postChannelMessage(firstServer.baseUrl, {
        provider: 'telegram',
        accountId: 'default',
        chatType: 'group',
        peerId: 'supergroup-9876543',
        displayName: 'Ops Group',
        message: 'inbound before restart',
      })
      expect(inbound.status).toBe(201)
      const inboundBody = await inbound.json() as { commanderId: string; created: boolean }
      expect(inboundBody.created).toBe(true)
      commanderId = inboundBody.commanderId
    } finally {
      await firstServer.close()
    }

    expect(commanderId).not.toHaveLength(0)

    const restartedSessions = createMockSessionsInterface()
    const restartedServer = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: restartedSessions.interface,
      channelReplyDispatchers: outbound.dispatchers,
    })

    try {
      const reply = await postChannelReply(
        restartedServer.baseUrl,
        commanderId,
        'reply after restart',
      )
      expect(reply.status).toBe(200)
      const replyBody = await reply.json() as {
        delivered: boolean
        provider: string
        sessionKey: string
      }
      expect(replyBody.delivered).toBe(true)
      expect(replyBody.provider).toBe('telegram')
      expect(replyBody.sessionKey).toBe('telegram:default:group:supergroup-9876543')

      expect(outbound.calls).toHaveLength(1)
      expect(outbound.calls[0]).toEqual({
        commanderId,
        message: 'reply after restart',
        channelMeta: {
          provider: 'telegram',
          chatType: 'group',
          accountId: 'default',
          peerId: 'supergroup-9876543',
          sessionKey: 'telegram:default:group:supergroup-9876543',
          displayName: 'Ops Group',
        },
        lastRoute: {
          channel: 'telegram',
          to: 'supergroup-9876543',
          accountId: 'default',
        },
      })
    } finally {
      await restartedServer.close()
    }
  })

  it('routes replies to the latest Discord thread via lastRoute.threadId', async () => {
    const dir = await createTempDir('hammurabi-channel-reply-discord-thread-')
    const mock = createMockSessionsInterface()
    const outbound = createMockChannelReplyDispatchers()
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: mock.interface,
      channelReplyDispatchers: outbound.dispatchers,
    })

    try {
      const seedResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'chan-ops',
        displayName: '#partner-support',
        message: 'seed channel',
      })
      expect(seedResponse.status).toBe(201)
      const seedBody = await seedResponse.json() as { commanderId: string }

      const threadOneResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'thread-111',
        parentPeerId: 'chan-ops',
        threadId: 'thread-111',
        displayName: '#partner-support',
        message: 'thread one message',
      })
      expect(threadOneResponse.status).toBe(200)

      const threadTwoResponse = await postChannelMessage(server.baseUrl, {
        provider: 'discord',
        accountId: 'default',
        chatType: 'channel',
        peerId: 'thread-222',
        parentPeerId: 'chan-ops',
        threadId: 'thread-222',
        displayName: '#partner-support',
        message: 'thread two message',
      })
      expect(threadTwoResponse.status).toBe(200)

      const replyResponse = await postChannelReply(
        server.baseUrl,
        seedBody.commanderId,
        'threaded reply',
      )
      expect(replyResponse.status).toBe(200)

      expect(outbound.calls).toHaveLength(1)
      expect(outbound.calls[0]?.lastRoute).toEqual({
        channel: 'discord',
        to: 'chan-ops',
        accountId: 'default',
        threadId: 'thread-222',
      })
    } finally {
      await server.close()
    }
  })

  it('routes replies to WhatsApp groups using group JID + accountId', async () => {
    const dir = await createTempDir('hammurabi-channel-reply-whatsapp-group-')
    const mock = createMockSessionsInterface()
    const outbound = createMockChannelReplyDispatchers()
    const server = await startServer({
      sessionStorePath: join(dir, 'sessions.json'),
      sessionsInterface: mock.interface,
      channelReplyDispatchers: outbound.dispatchers,
    })

    try {
      const inbound = await postChannelMessage(server.baseUrl, {
        provider: 'whatsapp',
        accountId: 'default',
        chatType: 'group',
        peerId: '120363012345@g.us',
        displayName: 'Ops Alerts',
        message: 'group inbound',
      })
      expect(inbound.status).toBe(201)
      const inboundBody = await inbound.json() as { commanderId: string }

      const reply = await postChannelReply(
        server.baseUrl,
        inboundBody.commanderId,
        'group reply',
      )
      expect(reply.status).toBe(200)

      expect(outbound.calls).toHaveLength(1)
      expect(outbound.calls[0]?.lastRoute).toEqual({
        channel: 'whatsapp',
        to: '120363012345@g.us',
        accountId: 'default',
      })
      expect(outbound.calls[0]?.channelMeta.sessionKey).toBe('whatsapp:default:group:120363012345@g.us')
    } finally {
      await server.close()
    }
  })
})
