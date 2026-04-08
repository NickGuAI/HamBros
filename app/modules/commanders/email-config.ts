import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  resolveCommanderDataDir,
  resolveCommanderEmailConfigPath,
  resolveCommanderEmailSeenPath,
} from './paths.js'

const DEFAULT_EMAIL_POLL_INTERVAL_MINUTES = 5
const MAX_SEEN_MESSAGE_IDS = 500

export interface EmailSourceConfig {
  account: string
  query: string
  pollIntervalMinutes: number
  replyAccount?: string
  enabled: boolean
}

export interface CommanderEmailState {
  lastCheckedAt: string | null
  seenMessageIds: string[]
}

export type ParsedEmailSourceConfig =
  | { ok: true; value: EmailSourceConfig }
  | { ok: false; error: string }

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

function parsePollIntervalMinutes(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_EMAIL_POLL_INTERVAL_MINUTES
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const normalized = Math.floor(value)
  return normalized >= 1 ? normalized : null
}

function cloneConfig(config: EmailSourceConfig): EmailSourceConfig {
  return {
    ...config,
    ...(config.replyAccount ? { replyAccount: config.replyAccount } : {}),
  }
}

function normalizeSeenMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const unique = new Set<string>()
  for (const entry of value) {
    const normalized = asTrimmedString(entry)
    if (normalized) {
      unique.add(normalized)
    }
  }

  return [...unique].slice(-MAX_SEEN_MESSAGE_IDS)
}

export function parseEmailSourceConfig(raw: unknown): ParsedEmailSourceConfig {
  if (!isObject(raw)) {
    return { ok: false, error: 'Email config must be an object' }
  }

  const account = asTrimmedString(raw.account)
  if (!account) {
    return { ok: false, error: 'account must be a non-empty string' }
  }

  const query = asTrimmedString(raw.query)
  if (!query) {
    return { ok: false, error: 'query must be a non-empty string' }
  }

  const pollIntervalMinutes = parsePollIntervalMinutes(raw.pollIntervalMinutes)
  if (pollIntervalMinutes === null) {
    return { ok: false, error: 'pollIntervalMinutes must be a number >= 1' }
  }

  const replyAccount = asTrimmedString(raw.replyAccount) ?? undefined
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false

  return {
    ok: true,
    value: {
      account,
      query,
      pollIntervalMinutes,
      enabled,
      ...(replyAccount ? { replyAccount } : {}),
    },
  }
}

function parsePersistedEmailConfig(raw: unknown): EmailSourceConfig | null {
  const parsed = parseEmailSourceConfig(raw)
  return parsed.ok ? parsed.value : null
}

function parsePersistedEmailState(raw: unknown): CommanderEmailState {
  if (!isObject(raw)) {
    return {
      lastCheckedAt: null,
      seenMessageIds: [],
    }
  }

  return {
    lastCheckedAt: asTrimmedString(raw.lastCheckedAt),
    seenMessageIds: normalizeSeenMessageIds(raw.seenMessageIds),
  }
}

export class CommanderEmailConfigStore {
  private readonly dataDir: string

  constructor(dataDir: string = resolveCommanderDataDir()) {
    this.dataDir = path.resolve(dataDir)
  }

  async get(commanderId: string): Promise<EmailSourceConfig | null> {
    const parsed = await this.readJsonFile(resolveCommanderEmailConfigPath(commanderId, this.dataDir))
    const config = parsePersistedEmailConfig(parsed)
    return config ? cloneConfig(config) : null
  }

  async set(commanderId: string, config: EmailSourceConfig): Promise<EmailSourceConfig> {
    const next = cloneConfig(config)
    const filePath = resolveCommanderEmailConfigPath(commanderId, this.dataDir)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8')
    return cloneConfig(next)
  }

  async delete(commanderId: string): Promise<void> {
    const filePath = resolveCommanderEmailConfigPath(commanderId, this.dataDir)
    try {
      await writeFile(filePath, '', 'utf8')
    } catch {
      // Best-effort cleanup; no caller currently relies on this.
    }
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    try {
      const raw = await readFile(filePath, 'utf8')
      return JSON.parse(raw) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError) {
        return null
      }
      throw error
    }
  }
}

export class CommanderEmailStateStore {
  private readonly dataDir: string

  constructor(dataDir: string = resolveCommanderDataDir()) {
    this.dataDir = path.resolve(dataDir)
  }

  async get(commanderId: string): Promise<CommanderEmailState> {
    const parsed = await this.readJsonFile(resolveCommanderEmailSeenPath(commanderId, this.dataDir))
    return parsePersistedEmailState(parsed)
  }

  async markSeen(
    commanderId: string,
    messageIds: string[],
  ): Promise<CommanderEmailState> {
    return this.update(commanderId, (current) => {
      const combined = [...current.seenMessageIds, ...messageIds]
      return {
        ...current,
        seenMessageIds: normalizeSeenMessageIds(combined),
      }
    })
  }

  async setLastCheckedAt(
    commanderId: string,
    lastCheckedAt: string,
  ): Promise<CommanderEmailState> {
    return this.update(commanderId, (current) => ({
      ...current,
      lastCheckedAt,
    }))
  }

  async update(
    commanderId: string,
    mutate: (current: CommanderEmailState) => CommanderEmailState,
  ): Promise<CommanderEmailState> {
    const filePath = resolveCommanderEmailSeenPath(commanderId, this.dataDir)
    const current = await this.get(commanderId)
    const next = mutate({
      lastCheckedAt: current.lastCheckedAt,
      seenMessageIds: [...current.seenMessageIds],
    })
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify(
        {
          lastCheckedAt: next.lastCheckedAt,
          seenMessageIds: normalizeSeenMessageIds(next.seenMessageIds),
        } satisfies CommanderEmailState,
        null,
        2,
      ),
      'utf8',
    )
    return this.get(commanderId)
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    try {
      const raw = await readFile(filePath, 'utf8')
      return JSON.parse(raw) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError) {
        return null
      }
      throw error
    }
  }
}
