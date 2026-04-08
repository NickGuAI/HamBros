import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderEmailConfigStore, CommanderEmailStateStore } from '../email-config.js'
import {
  EmailPoller,
  type CommanderEmailClient,
  type CommanderInboundEmail,
  type CommanderEmailSearchResult,
} from '../email-poller.js'
import { CommanderSessionStore, type CommanderSession } from '../store.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

function createRunningCommander(id: string): CommanderSession {
  return {
    id,
    host: `host-${id}`,
    pid: 123,
    state: 'running',
    created: '2026-04-03T09:00:00.000Z',
    heartbeat: {
      intervalMs: 60_000,
      messageTemplate: 'heartbeat',
      lastSentAt: null,
    },
    lastHeartbeat: null,
    taskSource: null,
    currentTask: null,
    completedTasks: 0,
    totalCostUsd: 0,
  }
}

class FakeEmailClient implements CommanderEmailClient {
  readonly searchCalls: Array<{ account: string; query: string; maxResults: number }> = []
  readonly getCalls: string[] = []
  private searchResultsQueue: CommanderEmailSearchResult[][]
  private readonly messagesById: Record<string, CommanderInboundEmail>

  constructor(options: {
    searchResultsQueue: CommanderEmailSearchResult[][]
    messagesById: Record<string, CommanderInboundEmail>
  }) {
    this.searchResultsQueue = [...options.searchResultsQueue]
    this.messagesById = options.messagesById
  }

  async searchMessages(
    account: string,
    query: string,
    maxResults: number,
  ): Promise<CommanderEmailSearchResult[]> {
    this.searchCalls.push({ account, query, maxResults })
    return this.searchResultsQueue.shift() ?? []
  }

  async getMessage(_account: string, messageId: string): Promise<CommanderInboundEmail> {
    this.getCalls.push(messageId)
    const message = this.messagesById[messageId]
    if (!message) {
      throw new Error(`Missing fake message ${messageId}`)
    }
    return message
  }

  async sendReply(): Promise<void> {
    throw new Error('sendReply not used in poller test')
  }
}

describe('EmailPoller', () => {
  it('deduplicates message ids, formats events, and avoids reprocessing on later polls', async () => {
    const dir = await createTempDir('hammurabi-email-poller-')
    const sessionStore = new CommanderSessionStore(join(dir, 'sessions.json'))
    await sessionStore.create(createRunningCommander('cmdr-1'))

    const configStore = new CommanderEmailConfigStore(dir)
    await configStore.set('cmdr-1', {
      account: 'assistant@pioneeringminds.ai',
      query: 'label:commander',
      pollIntervalMinutes: 5,
      enabled: true,
    })
    const stateStore = new CommanderEmailStateStore(dir)

    const emailClient = new FakeEmailClient({
      searchResultsQueue: [
        [{ id: 'mid-1' }, { id: 'mid-1' }, { id: 'mid-2' }],
        [{ id: 'mid-1' }, { id: 'mid-2' }],
      ],
      messagesById: {
        'mid-1': {
          gmailMessageId: 'mid-1',
          threadId: 'thread-1',
          from: '"Nick Gu" <nickgu@gehirn.ai>',
          to: 'assistant@pioneeringminds.ai',
          subject: 'Routing test',
          body: 'First commander email body',
          labels: ['INBOX', 'UNREAD'],
          attachments: ['plan.pdf'],
          replyTo: 'nickgu@gehirn.ai',
          receivedAt: '2026-04-03T10:00:00.000Z',
          rfcMessageId: '<mid-1@example.com>',
          references: [],
        },
        'mid-2': {
          gmailMessageId: 'mid-2',
          threadId: 'thread-1',
          from: '"Nick Gu" <nickgu@gehirn.ai>',
          to: 'assistant@pioneeringminds.ai',
          subject: 'Routing test follow-up',
          body: 'Second commander email body',
          labels: ['INBOX'],
          attachments: [],
          replyTo: 'nickgu@gehirn.ai',
          receivedAt: '2026-04-03T10:05:00.000Z',
          references: ['<mid-1@example.com>'],
        },
      },
    })

    const sendCalls: Array<{ name: string; text: string }> = []
    let now = new Date('2026-04-03T10:06:00.000Z')
    const poller = new EmailPoller({
      sessionStore,
      configStore,
      stateStore,
      sessionsInterface: {
        createCommanderSession: () => ({}),
        sendToSession(name, text) {
          sendCalls.push({ name, text })
          return true
        },
        deleteSession: () => undefined,
        getSession: () => ({ usage: {} }),
        subscribeToEvents: () => () => undefined,
      },
      emailClient,
      now: () => now,
    })

    await poller.pollAll()
    now = new Date('2026-04-03T10:12:00.000Z')
    await poller.pollCommander('cmdr-1')

    expect(sendCalls).toHaveLength(2)
    expect(sendCalls.map((call) => call.name)).toEqual(['commander-cmdr-1', 'commander-cmdr-1'])
    expect(sendCalls[0]?.text).toContain('[EMAIL RECEIVED 2026-04-03T10:00:00.000Z]')
    expect(sendCalls[0]?.text).toContain('Attachments: plan.pdf')
    expect(sendCalls[0]?.text).toContain('To reply: POST /api/commanders/cmdr-1/email/reply')
    expect(sendCalls[1]?.text).toContain('Subject: Routing test follow-up')

    expect(emailClient.getCalls).toEqual(['mid-1', 'mid-2'])
    expect(emailClient.searchCalls).toHaveLength(2)
    expect(emailClient.searchCalls[1]?.query).toContain('after:2026/04/02')

    await expect(stateStore.get('cmdr-1')).resolves.toEqual({
      lastCheckedAt: '2026-04-03T10:12:00.000Z',
      seenMessageIds: ['mid-1', 'mid-2'],
    })
  })
})
