import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommanderSessionsInterface } from '../agents/routes.js'
import {
  CommanderEmailConfigStore,
  CommanderEmailStateStore,
  type EmailSourceConfig,
} from './email-config.js'
import type { CommanderSessionStore } from './store.js'

const SEARCH_MAX_RESULTS = 50
const DEFAULT_LOOKBACK_DAYS = 1
const COMMANDER_SESSION_NAME_PREFIX = 'commander-'
const EMAIL_BODY_MAX_CHARS = 2_000

const execFileAsync = promisify(execFile)

export interface CommanderEmailSearchResult {
  id: string
  internalDate?: string
}

export interface CommanderInboundEmail {
  gmailMessageId: string
  threadId: string
  from: string
  to: string
  cc?: string
  subject: string
  body: string
  labels: string[]
  attachments: string[]
  replyTo?: string
  receivedAt: string | null
  rfcMessageId?: string
  inReplyTo?: string
  references: string[]
}

export interface CommanderEmailReply {
  account: string
  messageId: string
  threadId?: string
  to: string
  subject: string
  body: string
  from?: string
}

export interface CommanderEmailClient {
  searchMessages(account: string, query: string, maxResults: number): Promise<CommanderEmailSearchResult[]>
  getMessage(account: string, messageId: string): Promise<CommanderInboundEmail>
  sendReply(input: CommanderEmailReply): Promise<void>
}

interface GogCommandOptions {
  env: Record<string, string | undefined>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')
}

interface PayloadPart {
  mimeType?: string
  filename?: string
  body?: {
    data?: string
    attachmentId?: string
  }
  parts?: PayloadPart[]
  headers?: Array<{ name?: string; value?: string }>
}

function asPayloadPart(value: unknown): PayloadPart | null {
  return isObject(value) ? (value as PayloadPart) : null
}

function extractHeadersFromPayload(payload: PayloadPart | null): Record<string, string> {
  if (!payload || !Array.isArray(payload.headers)) {
    return {}
  }

  const headers: Record<string, string> = {}
  for (const header of payload.headers) {
    const name = asTrimmedString(header?.name)?.toLowerCase()
    const value = asTrimmedString(header?.value)
    if (name && value) {
      headers[name] = value
    }
  }
  return headers
}

function flattenPayloadParts(payload: PayloadPart | null): PayloadPart[] {
  if (!payload) {
    return []
  }
  return [
    payload,
    ...((payload.parts ?? [])
      .map((part) => flattenPayloadParts(asPayloadPart(part)))
      .flat()),
  ]
}

function extractBodyFromPayload(payload: PayloadPart | null): string {
  const parts = flattenPayloadParts(payload)
  const preferredPlain = parts.find((part) =>
    part.mimeType === 'text/plain' && asTrimmedString(part.body?.data))
  if (preferredPlain?.body?.data) {
    return decodeBase64Url(preferredPlain.body.data)
  }

  const preferredHtml = parts.find((part) =>
    part.mimeType === 'text/html' && asTrimmedString(part.body?.data))
  if (preferredHtml?.body?.data) {
    return stripHtml(decodeBase64Url(preferredHtml.body.data))
  }

  return ''
}

function extractAttachments(payload: PayloadPart | null): string[] {
  const attachments = new Set<string>()
  for (const part of flattenPayloadParts(payload)) {
    const filename = asTrimmedString(part.filename)
    if (filename && asTrimmedString(part.body?.attachmentId)) {
      attachments.add(filename)
    }
  }
  return [...attachments]
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function normalizeBodySnippet(value: string): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim()

  if (normalized.length <= EMAIL_BODY_MAX_CHARS) {
    return normalized
  }

  return `${normalized.slice(0, EMAIL_BODY_MAX_CHARS - 1).trimEnd()}…`
}

function parseReceivedAt(value: unknown, fallbackDate: string | null): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number.parseInt(value, 10)
    if (Number.isFinite(numeric)) {
      const millis = value.length <= 10 ? numeric * 1_000 : numeric
      return new Date(millis).toISOString()
    }

    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString()
    }
  }
  return fallbackDate
}

function normalizeHeaders(raw: unknown, payloadHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...payloadHeaders }
  if (!isObject(raw)) {
    return headers
  }

  for (const [key, value] of Object.entries(raw)) {
    const normalizedValue = asTrimmedString(value)
    if (normalizedValue) {
      headers[key.toLowerCase()] = normalizedValue
    }
  }
  return headers
}

function parseSearchResults(raw: unknown): CommanderEmailSearchResult[] {
  const entries = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.messages)
      ? raw.messages
      : []

  const results: CommanderEmailSearchResult[] = []
  for (const entry of entries) {
    if (!isObject(entry)) {
      continue
    }

    const id = asTrimmedString(entry.id)
    if (!id) {
      continue
    }

    results.push({
      id,
      internalDate: asTrimmedString(entry.internalDate) ?? undefined,
    })
  }

  return results
}

function parseInboundEmail(raw: unknown, fallbackMessageId: string): CommanderInboundEmail {
  const wrapper = isObject(raw) ? raw : {}
  const message = isObject(wrapper.message) ? wrapper.message : wrapper
  const payload = asPayloadPart(message.payload)
  const payloadHeaders = extractHeadersFromPayload(payload)
  const headers = normalizeHeaders(wrapper.headers, payloadHeaders)
  const receivedAt = parseReceivedAt(message.internalDate, parseReceivedAt(headers.date, null))
  const bodyCandidate = asTrimmedString(wrapper.body)
    ?? asTrimmedString(wrapper.snippet)
    ?? extractBodyFromPayload(payload)
  const body = normalizeBodySnippet(stripHtml(bodyCandidate ?? ''))
  const subject = headers.subject ?? '(no subject)'

  return {
    gmailMessageId: asTrimmedString(message.id) ?? fallbackMessageId,
    threadId: asTrimmedString(message.threadId) ?? '',
    from: headers.from ?? '',
    to: headers.to ?? '',
    cc: headers.cc ?? undefined,
    subject,
    body,
    labels: asStringArray(message.labelIds),
    attachments: extractAttachments(payload),
    replyTo: headers['reply-to'] ?? undefined,
    receivedAt,
    rfcMessageId: headers['message-id'] ?? undefined,
    inReplyTo: headers['in-reply-to'] ?? undefined,
    references: (headers.references ?? '')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  }
}

function ensureReplySubject(subject: string): string {
  const trimmed = subject.trim()
  if (!trimmed) {
    return 'Re: (no subject)'
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}

export function extractFirstEmailAddress(value: string): string | null {
  const bracketed = /<([^>]+)>/.exec(value)
  if (bracketed?.[1]) {
    return bracketed[1].trim()
  }

  const direct = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(value)
  return direct?.[0] ? direct[0].trim() : null
}

export function formatCommanderEmailEvent(
  commanderId: string,
  email: CommanderInboundEmail,
): string {
  const attachments = email.attachments.length > 0
    ? email.attachments.join(', ')
    : '(none)'
  const labels = email.labels.length > 0 ? email.labels.join(', ') : '(none)'
  const receivedAt = email.receivedAt ?? new Date(0).toISOString()
  const body = email.body.length > 0 ? email.body : '(no body)'

  return [
    `[EMAIL RECEIVED ${receivedAt}]`,
    `Commander-ID: ${commanderId}`,
    `From: ${email.from || '(unknown)'}`,
    `To: ${email.to || '(unknown)'}`,
    `Subject: ${email.subject}`,
    `Thread-ID: ${email.threadId || '(unknown)'}`,
    `Gmail-Message-ID: ${email.gmailMessageId}`,
    ...(email.rfcMessageId ? [`Message-ID: ${email.rfcMessageId}`] : []),
    ...(email.inReplyTo ? [`In-Reply-To: ${email.inReplyTo}`] : []),
    ...(email.replyTo ? [`Reply-To: ${email.replyTo}`] : []),
    `Labels: ${labels}`,
    `Attachments: ${attachments}`,
    '---',
    body,
    '---',
    `To reply: POST /api/commanders/${commanderId}/email/reply with {"messageId":"${email.gmailMessageId}","threadId":"${email.threadId}","body":"..."}`,
  ].join('\n')
}

function formatSearchAfterDate(lastCheckedAt: string | null, now: Date): string | null {
  if (!lastCheckedAt) {
    return null
  }

  const parsed = Date.parse(lastCheckedAt)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const lookback = new Date(parsed - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000)
  const candidate = lookback > now ? now : lookback
  const year = candidate.getUTCFullYear()
  const month = `${candidate.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${candidate.getUTCDate()}`.padStart(2, '0')
  return `${year}/${month}/${day}`
}

function shouldPoll(lastCheckedAt: string | null, pollIntervalMinutes: number, now: Date): boolean {
  if (!lastCheckedAt) {
    return true
  }

  const parsed = Date.parse(lastCheckedAt)
  if (!Number.isFinite(parsed)) {
    return true
  }

  return now.getTime() - parsed >= pollIntervalMinutes * 60 * 1_000
}

function toCommanderSessionName(commanderId: string): string {
  return `${COMMANDER_SESSION_NAME_PREFIX}${commanderId}`
}

export class GogCommanderEmailClient implements CommanderEmailClient {
  async searchMessages(
    account: string,
    query: string,
    maxResults: number,
  ): Promise<CommanderEmailSearchResult[]> {
    const stdout = await this.runCommand(
      'gog gmail messages search "$COMMANDER_EMAIL_QUERY" --account "$COMMANDER_EMAIL_ACCOUNT" --max "$COMMANDER_EMAIL_MAX" --json --no-input',
      {
        COMMANDER_EMAIL_ACCOUNT: account,
        COMMANDER_EMAIL_QUERY: query,
        COMMANDER_EMAIL_MAX: String(maxResults),
      },
    )
    return parseSearchResults(JSON.parse(stdout) as unknown)
  }

  async getMessage(account: string, messageId: string): Promise<CommanderInboundEmail> {
    const stdout = await this.runCommand(
      'gog gmail get "$COMMANDER_EMAIL_MESSAGE_ID" --account "$COMMANDER_EMAIL_ACCOUNT" --json --no-input',
      {
        COMMANDER_EMAIL_ACCOUNT: account,
        COMMANDER_EMAIL_MESSAGE_ID: messageId,
      },
    )
    return parseInboundEmail(JSON.parse(stdout) as unknown, messageId)
  }

  async sendReply(input: CommanderEmailReply): Promise<void> {
    await this.runCommand(
      [
        'gog gmail send',
        '--account "$COMMANDER_EMAIL_ACCOUNT"',
        '--reply-to-message-id "$COMMANDER_EMAIL_MESSAGE_ID"',
        '--to "$COMMANDER_EMAIL_TO"',
        '--subject "$COMMANDER_EMAIL_SUBJECT"',
        '--body "$COMMANDER_EMAIL_BODY"',
        '--json',
        '--no-input',
        input.from ? '--from "$COMMANDER_EMAIL_FROM"' : '',
      ].filter((entry) => entry.length > 0).join(' '),
      {
        COMMANDER_EMAIL_ACCOUNT: input.account,
        COMMANDER_EMAIL_MESSAGE_ID: input.messageId,
        COMMANDER_EMAIL_TO: input.to,
        COMMANDER_EMAIL_SUBJECT: input.subject,
        COMMANDER_EMAIL_BODY: input.body,
        COMMANDER_EMAIL_FROM: input.from,
      },
    )
  }

  private async runCommand(
    command: string,
    options: GogCommandOptions['env'],
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      'bash',
      ['-lc', `source ~/.bashrc >/dev/null 2>&1 || true; ${command}`],
      {
        env: {
          ...process.env,
          ...options,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    return stdout
  }
}

export interface EmailPollerOptions {
  sessionStore: CommanderSessionStore
  configStore: CommanderEmailConfigStore
  stateStore: CommanderEmailStateStore
  sessionsInterface: CommanderSessionsInterface
  emailClient?: CommanderEmailClient
  now?: () => Date
}

export class EmailPoller {
  private readonly sessionStore: CommanderSessionStore
  private readonly configStore: CommanderEmailConfigStore
  private readonly stateStore: CommanderEmailStateStore
  private readonly sessionsInterface: CommanderSessionsInterface
  private readonly emailClient: CommanderEmailClient
  private readonly now: () => Date

  constructor(options: EmailPollerOptions) {
    this.sessionStore = options.sessionStore
    this.configStore = options.configStore
    this.stateStore = options.stateStore
    this.sessionsInterface = options.sessionsInterface
    this.emailClient = options.emailClient ?? new GogCommanderEmailClient()
    this.now = options.now ?? (() => new Date())
  }

  async pollAll(): Promise<void> {
    const sessions = await this.sessionStore.list()
    const runningCommanderIds = sessions
      .filter((session) => session.state === 'running')
      .map((session) => session.id)

    for (const commanderId of runningCommanderIds) {
      try {
        await this.pollCommander(commanderId)
      } catch (error) {
        console.error(`[commanders] Email polling failed for "${commanderId}":`, error)
      }
    }
  }

  async pollCommander(commanderId: string): Promise<void> {
    const config = await this.configStore.get(commanderId)
    if (!config || !config.enabled) {
      return
    }

    const state = await this.stateStore.get(commanderId)
    const now = this.now()
    if (!shouldPoll(state.lastCheckedAt, config.pollIntervalMinutes, now)) {
      return
    }

    const afterClause = formatSearchAfterDate(state.lastCheckedAt, now)
    const query = afterClause ? `${config.query} after:${afterClause}` : config.query
    const searchResults = await this.emailClient.searchMessages(
      config.account,
      query,
      SEARCH_MAX_RESULTS,
    )
    const seenIds = new Set(state.seenMessageIds)
    const pendingIds = [...new Set(
      searchResults
        .map((entry) => entry.id)
        .filter((messageId) => !seenIds.has(messageId)),
    )]

    for (const messageId of pendingIds) {
      const inbound = await this.emailClient.getMessage(config.account, messageId)
      if (inbound.labels.includes('SENT')) {
        await this.stateStore.markSeen(commanderId, [messageId])
        continue
      }

      const accepted = this.sessionsInterface.sendToSession(
        toCommanderSessionName(commanderId),
        formatCommanderEmailEvent(commanderId, inbound),
      )
      if (!accepted) {
        throw new Error('Commander stream session unavailable during email routing')
      }

      await this.stateStore.markSeen(commanderId, [messageId])
    }

    await this.stateStore.setLastCheckedAt(commanderId, now.toISOString())
  }

  async sendReply(
    commanderId: string,
    config: EmailSourceConfig,
    input: { messageId: string; threadId?: string; body: string },
  ): Promise<{ account: string; threadId: string }> {
    const sourceAccount = config.account
    const replyAccount = config.replyAccount ?? config.account
    const original = await this.emailClient.getMessage(sourceAccount, input.messageId)
    const recipient = extractFirstEmailAddress(original.replyTo ?? original.from)
    if (!recipient) {
      throw new Error('Unable to resolve recipient email address from original message')
    }

    await this.emailClient.sendReply({
      account: replyAccount,
      messageId: input.messageId,
      threadId: input.threadId ?? original.threadId,
      to: recipient,
      subject: ensureReplySubject(original.subject),
      body: input.body,
    })

    return {
      account: replyAccount,
      threadId: input.threadId ?? original.threadId,
    }
  }
}
