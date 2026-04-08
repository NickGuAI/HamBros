import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CreateSentinelInput,
  Sentinel,
  SentinelHistoryEntry,
  SentinelStatus,
  UpdateSentinelInput,
} from './types.js'

const DEFAULT_SENTINEL_STORE_PATH = 'data/sentinels/sentinels.json'
const HISTORY_CAP = 50

interface PersistedSentinelCollection {
  sentinels: Sentinel[]
}

export interface SentinelStoreOptions {
  filePath?: string
}

interface SentinelFilter {
  parentCommanderId?: string
  status?: SentinelStatus
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

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return null
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  return null
}

function parseHistoryEntry(entry: unknown): SentinelHistoryEntry | null {
  if (!isObject(entry)) {
    return null
  }

  const timestamp = asTrimmedString(entry.timestamp)
  const action = asTrimmedString(entry.action)
  const result = asTrimmedString(entry.result)
  const costUsd = asNonNegativeNumber(entry.costUsd)
  const durationSec = asNonNegativeNumber(entry.durationSec)
  if (!timestamp || !action || !result || costUsd === null || durationSec === null) {
    return null
  }

  const next: SentinelHistoryEntry = {
    timestamp,
    action,
    result,
    costUsd,
    durationSec,
  }

  const sessionId = asTrimmedString(entry.sessionId)
  if (sessionId) {
    next.sessionId = sessionId
  }

  const runFile = asTrimmedString(entry.runFile)
  if (runFile) {
    next.runFile = runFile
  }

  if (entry.memoryUpdated === true || entry.memoryUpdated === false) {
    next.memoryUpdated = entry.memoryUpdated
  }

  if (entry.source === 'cron' || entry.source === 'manual') {
    next.source = entry.source
  }

  return next
}

function parseStatus(raw: unknown): SentinelStatus | null {
  if (raw === 'active' || raw === 'paused' || raw === 'completed' || raw === 'cancelled') {
    return raw
  }
  return null
}

function isSentinelAgentType(raw: unknown): raw is 'claude' | 'codex' {
  return raw === 'claude' || raw === 'codex'
}

function parseSentinel(entry: unknown): Sentinel | null {
  if (!isObject(entry)) {
    return null
  }

  const id = asTrimmedString(entry.id)
  const name = asTrimmedString(entry.name)
  const instruction = asTrimmedString(entry.instruction)
  const schedule = asTrimmedString(entry.schedule)
  const status = parseStatus(entry.status)
  const parentCommanderId = asTrimmedString(entry.parentCommanderId)
  const memoryPath = asTrimmedString(entry.memoryPath)
  const outputDir = asTrimmedString(entry.outputDir)
  const workDir = asTrimmedString(entry.workDir)
  const createdAt = asTrimmedString(entry.createdAt)
  const totalRuns = asNonNegativeNumber(entry.totalRuns)
  const totalCostUsd = asNonNegativeNumber(entry.totalCostUsd)

  if (
    !id || !name || !instruction || !schedule || !status || !parentCommanderId
    || !memoryPath || !outputDir || !workDir || !createdAt || totalRuns === null || totalCostUsd === null
  ) {
    return null
  }

  const history = Array.isArray(entry.history)
    ? entry.history
      .map(parseHistoryEntry)
      .filter((item): item is SentinelHistoryEntry => item !== null)
      .slice(0, HISTORY_CAP)
    : []

  const skills = Array.isArray(entry.skills)
    ? entry.skills
      .map((skill) => asTrimmedString(skill))
      .filter((skill): skill is string => Boolean(skill))
    : []

  const observations = Array.isArray(entry.observations)
    ? entry.observations
      .map((observation) => asTrimmedString(observation))
      .filter((observation): observation is string => Boolean(observation))
    : undefined

  const sentinel: Sentinel = {
    id,
    name,
    instruction,
    schedule,
    status,
    parentCommanderId,
    memoryPath,
    outputDir,
    workDir,
    createdAt,
    lastRun: typeof entry.lastRun === 'string' ? entry.lastRun : null,
    totalRuns,
    totalCostUsd,
    history,
    skills,
    seedMemory: typeof entry.seedMemory === 'string' ? entry.seedMemory : '',
    permissionMode: asTrimmedString(entry.permissionMode) ?? 'acceptEdits',
    agentType: isSentinelAgentType(entry.agentType) ? entry.agentType : 'claude',
  }

  const timezone = asTrimmedString(entry.timezone)
  if (timezone) {
    sentinel.timezone = timezone
  }

  const model = asTrimmedString(entry.model)
  if (model) {
    sentinel.model = model
  }

  const maxRuns = asPositiveInteger(entry.maxRuns)
  if (maxRuns !== null) {
    sentinel.maxRuns = maxRuns
  }

  if (observations && observations.length > 0) {
    sentinel.observations = observations
  }

  return sentinel
}

function parseSentinelCollection(raw: unknown): PersistedSentinelCollection {
  if (Array.isArray(raw)) {
    return {
      sentinels: raw
        .map(parseSentinel)
        .filter((sentinel): sentinel is Sentinel => sentinel !== null),
    }
  }

  if (isObject(raw) && Array.isArray(raw.sentinels)) {
    return {
      sentinels: raw.sentinels
        .map(parseSentinel)
        .filter((sentinel): sentinel is Sentinel => sentinel !== null),
    }
  }

  return { sentinels: [] }
}

export function defaultSentinelStorePath(): string {
  return path.resolve(process.cwd(), DEFAULT_SENTINEL_STORE_PATH)
}

function formatSeedMemory(name: string, seedMemory: string): string {
  const normalizedSeedMemory = seedMemory.trim().length > 0
    ? seedMemory.trim()
    : '(No seed memory provided)'

  return [
    `# Sentinel Memory: ${name}`,
    '',
    '## Seed Context',
    normalizedSeedMemory,
    '',
    '## Learned Facts',
    '<!-- Updated by the sentinel across runs. Add new discoveries below. -->',
    '',
    '## Status Notes',
    '<!-- Track evolving state of the task here. -->',
    '',
  ].join('\n')
}

export class SentinelStore {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly filePath: string
  private readonly dataDir: string

  constructor(options: string | SentinelStoreOptions = {}) {
    if (typeof options === 'string') {
      this.filePath = path.resolve(options)
    } else {
      this.filePath = path.resolve(options.filePath ?? defaultSentinelStorePath())
    }
    this.dataDir = path.dirname(this.filePath)
  }

  async list(filter: SentinelFilter = {}): Promise<Sentinel[]> {
    await this.mutationQueue
    const collection = await this.readFromDisk()

    let sentinels = this.sortSentinels(collection.sentinels)
    if (filter.parentCommanderId) {
      sentinels = sentinels.filter((sentinel) => sentinel.parentCommanderId === filter.parentCommanderId)
    }
    if (filter.status) {
      sentinels = sentinels.filter((sentinel) => sentinel.status === filter.status)
    }

    return sentinels
  }

  async get(sentinelId: string): Promise<Sentinel | null> {
    const sentinels = await this.list()
    return sentinels.find((sentinel) => sentinel.id === sentinelId) ?? null
  }

  async create(input: CreateSentinelInput): Promise<Sentinel> {
    return this.withMutationLock(async () => {
      const collection = await this.readFromDisk()
      const now = new Date().toISOString()
      const id = randomUUID()
      const sentinelDir = path.join(this.dataDir, id)
      const memoryPath = path.join(sentinelDir, 'memory.md')

      await mkdir(path.join(sentinelDir, 'runs'), { recursive: true })
      await mkdir(path.join(sentinelDir, 'artifacts'), { recursive: true })
      await writeFile(memoryPath, formatSeedMemory(input.name, input.seedMemory ?? ''), 'utf8')

      const sentinel: Sentinel = {
        id,
        name: input.name,
        instruction: input.instruction,
        schedule: input.schedule,
        status: input.status ?? 'active',
        agentType: input.agentType ?? 'claude',
        permissionMode: input.permissionMode ?? 'acceptEdits',
        parentCommanderId: input.parentCommanderId,
        skills: (input.skills ?? []).filter((skill) => skill.trim().length > 0),
        seedMemory: input.seedMemory ?? '',
        memoryPath,
        outputDir: sentinelDir,
        workDir: input.workDir ?? process.cwd(),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxRuns ? { maxRuns: input.maxRuns } : {}),
        ...(input.observations && input.observations.length > 0 ? { observations: [...input.observations] } : {}),
        createdAt: now,
        lastRun: null,
        totalRuns: 0,
        totalCostUsd: 0,
        history: [],
      }

      collection.sentinels.push(sentinel)
      await this.writeToDisk(collection)
      return sentinel
    })
  }

  async update(sentinelId: string, update: UpdateSentinelInput): Promise<Sentinel | null> {
    return this.withMutationLock(async () => {
      const collection = await this.readFromDisk()
      const index = collection.sentinels.findIndex((sentinel) => sentinel.id === sentinelId)
      if (index < 0) {
        return null
      }

      const current = collection.sentinels[index]
      if (!current) {
        return null
      }

      const next: Sentinel = {
        ...current,
        ...update,
      }

      if (Array.isArray(update.skills)) {
        next.skills = update.skills
      }

      if (Array.isArray(update.observations)) {
        next.observations = update.observations
      }

      if (update.maxRuns !== undefined) {
        if (typeof update.maxRuns === 'number' && Number.isInteger(update.maxRuns) && update.maxRuns > 0) {
          next.maxRuns = update.maxRuns
        } else {
          delete next.maxRuns
        }
      }

      if (update.seedMemory !== undefined) {
        next.seedMemory = update.seedMemory
      }

      collection.sentinels[index] = next
      await this.writeToDisk(collection)
      return next
    })
  }

  async appendHistory(sentinelId: string, entry: SentinelHistoryEntry): Promise<Sentinel | null> {
    return this.withMutationLock(async () => {
      const collection = await this.readFromDisk()
      const index = collection.sentinels.findIndex((sentinel) => sentinel.id === sentinelId)
      if (index < 0) {
        return null
      }

      const current = collection.sentinels[index]
      if (!current) {
        return null
      }

      const history = [entry, ...current.history].slice(0, HISTORY_CAP)
      const totalRuns = current.totalRuns + 1
      const totalCostUsd = Math.max(0, current.totalCostUsd + Math.max(0, entry.costUsd))
      const nextStatus = current.maxRuns && totalRuns >= current.maxRuns
        ? 'completed'
        : current.status

      const next: Sentinel = {
        ...current,
        history,
        lastRun: entry.timestamp,
        totalRuns,
        totalCostUsd,
        status: nextStatus,
      }

      collection.sentinels[index] = next
      await this.writeToDisk(collection)
      return next
    })
  }

  async listHistory(
    sentinelId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ entries: SentinelHistoryEntry[]; total: number }> {
    const sentinel = await this.get(sentinelId)
    if (!sentinel) {
      return { entries: [], total: 0 }
    }

    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    return {
      entries: sentinel.history.slice(offset, offset + limit),
      total: sentinel.history.length,
    }
  }

  async delete(sentinelId: string, options: { removeFiles?: boolean } = {}): Promise<boolean> {
    return this.withMutationLock(async () => {
      const collection = await this.readFromDisk()
      const index = collection.sentinels.findIndex((sentinel) => sentinel.id === sentinelId)
      if (index < 0) {
        return false
      }

      const sentinel = collection.sentinels[index]
      collection.sentinels.splice(index, 1)
      await this.writeToDisk(collection)

      if (sentinel && options.removeFiles !== false) {
        await rm(sentinel.outputDir, { recursive: true, force: true })
      }

      return true
    })
  }

  async readMemory(sentinelId: string): Promise<string | null> {
    const sentinel = await this.get(sentinelId)
    if (!sentinel) {
      return null
    }

    try {
      return await readFile(sentinel.memoryPath, 'utf8')
    } catch (error) {
      if (
        isObject(error)
        && 'code' in error
        && typeof error.code === 'string'
        && error.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  }

  async writeMemory(sentinelId: string, content: string): Promise<boolean> {
    const sentinel = await this.get(sentinelId)
    if (!sentinel) {
      return false
    }

    await mkdir(path.dirname(sentinel.memoryPath), { recursive: true })
    await writeFile(sentinel.memoryPath, content, 'utf8')
    return true
  }

  async readRunReport(sentinelId: string, timestamp: string): Promise<string | null> {
    const sentinel = await this.get(sentinelId)
    if (!sentinel) {
      return null
    }

    const reportPath = path.join(sentinel.outputDir, 'runs', `${timestamp}.md`)
    try {
      return await readFile(reportPath, 'utf8')
    } catch (error) {
      if (
        isObject(error)
        && 'code' in error
        && typeof error.code === 'string'
        && error.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  }

  resolveRunJsonPath(sentinel: Sentinel, timestampKey: string): string {
    return path.join(sentinel.outputDir, 'runs', `${timestampKey}.json`)
  }

  private sortSentinels(sentinels: Sentinel[]): Sentinel[] {
    return [...sentinels].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
  }

  private async readFromDisk(): Promise<PersistedSentinelCollection> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (
        isObject(error)
        && 'code' in error
        && typeof error.code === 'string'
        && error.code === 'ENOENT'
      ) {
        return { sentinels: [] }
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch {
      return { sentinels: [] }
    }

    return parseSentinelCollection(parsed)
  }

  private async writeToDisk(collection: PersistedSentinelCollection): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8')
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
