import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderDataDir } from './paths.js'

export type HeartbeatLogOutcome = 'ok' | 'no-quests' | 'error' | 'skipped'

export interface HeartbeatLogEntry {
  id: string
  firedAt: string
  questCount: number
  claimedQuestId?: string
  claimedQuestInstruction?: string
  outcome: HeartbeatLogOutcome
  errorMessage?: string
}

export interface HeartbeatLogAppendInput {
  id?: string
  firedAt: string
  questCount: number
  claimedQuestId?: string
  claimedQuestInstruction?: string
  outcome: HeartbeatLogOutcome
  errorMessage?: string
}

interface HeartbeatLogFile {
  entries: HeartbeatLogEntry[]
}

export interface HeartbeatLogOptions {
  dataDir?: string
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 50

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseOutcome(raw: unknown): HeartbeatLogOutcome | null {
  return raw === 'ok' || raw === 'no-quests' || raw === 'error' || raw === 'skipped' ? raw : null
}

function parseEntry(raw: unknown): HeartbeatLogEntry | null {
  if (!isObject(raw)) {
    return null
  }

  const id = normalizeOptionalString(raw.id)
  const firedAt = normalizeOptionalString(raw.firedAt)
  const outcome = parseOutcome(raw.outcome)
  const rawQuestCount = raw.questCount
  const questCount = typeof rawQuestCount === 'number' && Number.isFinite(rawQuestCount)
    ? Math.max(0, Math.floor(rawQuestCount))
    : null

  if (!id || !firedAt || !outcome || questCount === null) {
    return null
  }

  return {
    id,
    firedAt,
    questCount,
    ...(normalizeOptionalString(raw.claimedQuestId)
      ? { claimedQuestId: normalizeOptionalString(raw.claimedQuestId) }
      : {}),
    ...(normalizeOptionalString(raw.claimedQuestInstruction)
      ? { claimedQuestInstruction: normalizeOptionalString(raw.claimedQuestInstruction) }
      : {}),
    outcome,
    ...(normalizeOptionalString(raw.errorMessage)
      ? { errorMessage: normalizeOptionalString(raw.errorMessage) }
      : {}),
  }
}

function parseLogFile(raw: unknown): HeartbeatLogFile {
  if (Array.isArray(raw)) {
    return {
      entries: raw
        .map((entry) => parseEntry(entry))
        .filter((entry): entry is HeartbeatLogEntry => entry !== null),
    }
  }

  if (isObject(raw) && Array.isArray(raw.entries)) {
    return {
      entries: raw.entries
        .map((entry) => parseEntry(entry))
        .filter((entry): entry is HeartbeatLogEntry => entry !== null),
    }
  }

  return { entries: [] }
}

function cloneEntry(entry: HeartbeatLogEntry): HeartbeatLogEntry {
  return {
    ...entry,
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isObject(error) && 'code' in error && error.code === code
}

export class HeartbeatLog {
  private readonly dataDir: string
  private readonly maxEntries: number
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: HeartbeatLogOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? resolveCommanderDataDir())
    this.maxEntries = Number.isFinite(options.maxEntries) && Number(options.maxEntries) > 0
      ? Math.floor(Number(options.maxEntries))
      : DEFAULT_MAX_ENTRIES
  }

  async append(commanderId: string, input: HeartbeatLogAppendInput): Promise<HeartbeatLogEntry> {
    return this.withMutationLock(async () => {
      const filePath = this.resolveFilePath(commanderId)
      const current = await this.readFromDisk(filePath)
      const nextEntry: HeartbeatLogEntry = {
        id: input.id?.trim() || randomUUID(),
        firedAt: input.firedAt,
        questCount: Math.max(0, Math.floor(input.questCount)),
        ...(input.claimedQuestId?.trim() ? { claimedQuestId: input.claimedQuestId.trim() } : {}),
        ...(input.claimedQuestInstruction?.trim()
          ? { claimedQuestInstruction: input.claimedQuestInstruction.trim() }
          : {}),
        outcome: input.outcome,
        ...(input.errorMessage?.trim() ? { errorMessage: input.errorMessage.trim() } : {}),
      }

      const entries = [nextEntry, ...current.entries].slice(0, this.maxEntries)
      await this.writeToDisk(filePath, { entries })
      return cloneEntry(nextEntry)
    })
  }

  async read(commanderId: string, limit = this.maxEntries): Promise<HeartbeatLogEntry[]> {
    await this.mutationQueue
    const normalizedLimit = Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : this.maxEntries
    const filePath = this.resolveFilePath(commanderId)
    const payload = await this.readFromDisk(filePath)
    return payload.entries
      .slice(0, Math.min(normalizedLimit, this.maxEntries))
      .map((entry) => cloneEntry(entry))
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private resolveFilePath(commanderId: string): string {
    const normalizedCommanderId = commanderId.trim()
    if (!normalizedCommanderId) {
      throw new Error('commanderId must be a non-empty string')
    }

    const resolved = path.resolve(this.dataDir, normalizedCommanderId, 'heartbeat-log.json')
    const dataDirPrefix = this.dataDir.endsWith(path.sep)
      ? this.dataDir
      : `${this.dataDir}${path.sep}`
    if (!resolved.startsWith(dataDirPrefix)) {
      throw new Error(`Invalid commanderId path: ${commanderId}`)
    }
    return resolved
  }

  private async readFromDisk(filePath: string): Promise<HeartbeatLogFile> {
    let rawFile: string
    try {
      rawFile = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return { entries: [] }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch {
      return { entries: [] }
    }

    return parseLogFile(parsed)
  }

  private async writeToDisk(filePath: string, payload: HeartbeatLogFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
  }
}
