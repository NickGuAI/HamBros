import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const API_KEY_SCOPES = [
  'telemetry:read',
  'telemetry:write',
  'agents:read',
  'agents:write',
  'commanders:read',
  'commanders:write',
  'services:read',
  'services:write',
  'factory:read',
  'factory:write',
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

const API_KEY_SCOPE_SET = new Set<string>(API_KEY_SCOPES)

export interface ApiKeyRecord {
  id: string
  name: string
  keyHash: string
  prefix: string
  createdBy: string
  createdAt: string
  lastUsedAt: string | null
  scopes: string[]
}

export interface CreateApiKeyInput {
  name: string
  scopes: readonly string[]
  createdBy: string
  now?: Date
}

export interface CreatedApiKey {
  key: string
  record: ApiKeyRecord
}

export type ApiKeyVerificationResult =
  | {
      ok: true
      record: ApiKeyRecord
    }
  | {
      ok: false
      reason: 'not_found' | 'insufficient_scope'
    }

export interface ApiKeyStoreLike {
  hasAnyKeys(): Promise<boolean>
  verifyKey(
    rawKey: string,
    options?: {
      requiredScopes?: readonly string[]
      now?: Date
      lastUsedWriteIntervalMs?: number
    },
  ): Promise<ApiKeyVerificationResult>
}

interface PersistedApiKeyCollection {
  keys: ApiKeyRecord[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isApiKeyRecord(value: unknown): value is ApiKeyRecord {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.keyHash === 'string' &&
    typeof value.prefix === 'string' &&
    typeof value.createdBy === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.lastUsedAt === null || typeof value.lastUsedAt === 'string') &&
    isStringArray(value.scopes)
  )
}

function secureStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return API_KEY_SCOPE_SET.has(value)
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))]
}

function toPersistedCollection(value: unknown): PersistedApiKeyCollection {
  if (Array.isArray(value)) {
    return {
      keys: value.filter((item): item is ApiKeyRecord => isApiKeyRecord(item)),
    }
  }

  if (
    isObject(value) &&
    Array.isArray(value.keys)
  ) {
    return {
      keys: value.keys.filter((item): item is ApiKeyRecord => isApiKeyRecord(item)),
    }
  }

  return { keys: [] }
}

function createRawApiKey(): string {
  return `hmrb_${randomBytes(16).toString('hex')}`
}

function toKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 'hmrb_'.length + 4)
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

export function defaultApiKeyStorePath(): string {
  return path.resolve(process.cwd(), 'data/api-keys/keys.json')
}

const DEFAULT_LAST_USED_WRITE_INTERVAL_MS = 60_000

function toEpochMs(value: string | null): number | null {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeLastUsedWriteIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LAST_USED_WRITE_INTERVAL_MS
  }

  return Math.max(0, Math.floor(value))
}

export class ApiKeyJsonStore implements ApiKeyStoreLike {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly pendingLastUsedAtById = new Map<string, number>()

  constructor(private readonly filePath: string = defaultApiKeyStorePath()) {}

  async listKeys(): Promise<ApiKeyRecord[]> {
    const records = await this.readRecordsConsistent()
    return records.sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    )
  }

  async hasAnyKeys(): Promise<boolean> {
    const records = await this.readRecordsConsistent()
    return records.length > 0
  }

  async createKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const nowIso = (input.now ?? new Date()).toISOString()
    const rawKey = createRawApiKey()
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      keyHash: hashApiKey(rawKey),
      prefix: toKeyPrefix(rawKey),
      createdBy: input.createdBy.trim(),
      createdAt: nowIso,
      lastUsedAt: null,
      scopes: normalizeScopes(input.scopes),
    }

    return this.withMutationLock(async () => {
      const records = await this.readRecords()
      records.push(record)
      await this.writeRecords(records)

      return {
        key: rawKey,
        record,
      }
    })
  }

  async revokeKey(id: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const records = await this.readRecords()
      const next = records.filter((record) => record.id !== id)
      if (next.length === records.length) {
        return false
      }

      this.pendingLastUsedAtById.delete(id)
      await this.writeRecords(next)
      return true
    })
  }

  async verifyKey(
    rawKey: string,
    options: {
      requiredScopes?: readonly string[]
      now?: Date
      lastUsedWriteIntervalMs?: number
    } = {},
  ): Promise<ApiKeyVerificationResult> {
    const normalizedRawKey = rawKey.trim()
    if (normalizedRawKey.length === 0) {
      return {
        ok: false,
        reason: 'not_found',
      }
    }

    const records = await this.readRecordsConsistent()
    const keyHash = hashApiKey(normalizedRawKey)
    const requiredScopes = normalizeScopes(options.requiredScopes ?? [])

    let matchedIndex = -1
    for (let index = 0; index < records.length; index += 1) {
      const candidate = records[index]
      if (candidate && secureStringEqual(candidate.keyHash, keyHash)) {
        matchedIndex = index
      }
    }

    if (matchedIndex < 0) {
      return {
        ok: false,
        reason: 'not_found',
      }
    }

    const matchedRecord = records[matchedIndex]
    if (!matchedRecord) {
      return {
        ok: false,
        reason: 'not_found',
      }
    }

    const hasRequiredScopes = requiredScopes.every((scope) =>
      matchedRecord.scopes.includes(scope),
    )
    if (!hasRequiredScopes) {
      return {
        ok: false,
        reason: 'insufficient_scope',
      }
    }

    const now = options.now ?? new Date()
    const nowIso = now.toISOString()
    const nowMs = now.getTime()
    const lastUsedWriteIntervalMs = normalizeLastUsedWriteIntervalMs(
      options.lastUsedWriteIntervalMs,
    )
    if (
      !this.shouldPersistLastUsedAt(matchedRecord, nowMs, lastUsedWriteIntervalMs)
    ) {
      return {
        ok: true,
        record: matchedRecord,
      }
    }

    const updatedRecord: ApiKeyRecord = {
      ...matchedRecord,
      lastUsedAt: nowIso,
    }
    await this.persistLastUsedAt(updatedRecord, nowMs)

    return {
      ok: true,
      record: updatedRecord,
    }
  }

  private async readRecordsConsistent(): Promise<ApiKeyRecord[]> {
    await this.mutationQueue
    return this.readRecords()
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private shouldPersistLastUsedAt(
    record: ApiKeyRecord,
    nowMs: number,
    lastUsedWriteIntervalMs: number,
  ): boolean {
    const persistedAtMs = toEpochMs(record.lastUsedAt) ?? 0
    const pendingAtMs = this.pendingLastUsedAtById.get(record.id) ?? 0
    const latestKnownAtMs = Math.max(persistedAtMs, pendingAtMs)
    if (nowMs <= latestKnownAtMs) {
      return false
    }
    if (nowMs - latestKnownAtMs < lastUsedWriteIntervalMs) {
      return false
    }

    this.pendingLastUsedAtById.set(record.id, nowMs)
    return true
  }

  private async persistLastUsedAt(
    record: ApiKeyRecord,
    nowMs: number,
  ): Promise<void> {
    try {
      await this.withMutationLock(async () => {
        const records = await this.readRecords()
        const matchedIndex = records.findIndex((candidate) => candidate.id === record.id)
        if (matchedIndex < 0) {
          this.pendingLastUsedAtById.delete(record.id)
          return
        }

        const matchedRecord = records[matchedIndex]
        if (!matchedRecord) {
          this.pendingLastUsedAtById.delete(record.id)
          return
        }

        const existingLastUsedAtMs = toEpochMs(matchedRecord.lastUsedAt)
        if (existingLastUsedAtMs !== null && existingLastUsedAtMs >= nowMs) {
          return
        }

        records[matchedIndex] = {
          ...matchedRecord,
          lastUsedAt: record.lastUsedAt,
        }
        await this.writeRecords(records)
      })
    } catch {
      const pendingAtMs = this.pendingLastUsedAtById.get(record.id)
      if (pendingAtMs === nowMs) {
        this.pendingLastUsedAtById.delete(record.id)
      }
    }
  }

  private async readRecords(): Promise<ApiKeyRecord[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isObject(error) && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }

    try {
      const parsed = JSON.parse(contents) as unknown
      return toPersistedCollection(parsed).keys
    } catch {
      return []
    }
  }

  private async writeRecords(records: ApiKeyRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: PersistedApiKeyCollection = {
      keys: records,
    }
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
