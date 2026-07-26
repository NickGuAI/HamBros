import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { resolveModuleDataDir } from '../../modules/data-dir.js'
import { readJsonFileFailClosed, writeJsonFileAtomically } from '../../modules/json-file.js'
import { withJsonStoreSchema } from '../../modules/json-store-schema.js'

export const API_KEY_SCOPES = [
  'telemetry:read',
  'telemetry:write',
  'agents:read',
  'agents:write',
  'agents:admin',
  'commanders:read',
  'commanders:write',
  'commanders:channels:write',
  'org:write',
  'services:read',
  'services:write',
  'skills:read',
  'skills:write',
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_PURPOSES = ['bootstrap', 'permanent'] as const

export type ApiKeyPurpose = (typeof API_KEY_PURPOSES)[number]

const API_KEY_RECORD_SCHEMA_VERSION = 1

export const DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES: readonly ApiKeyScope[] = [
  ...API_KEY_SCOPES,
]

export const DEFAULT_BOOTSTRAP_MASTER_KEY_TTL_MS = 24 * 60 * 60 * 1000

const API_KEY_SCOPE_SET = new Set<string>(API_KEY_SCOPES)

export interface ApiKeyRecord {
  id: string
  name: string
  keyHash: string
  prefix: string
  purpose: ApiKeyPurpose
  createdBy: string
  createdAt: string
  expiresAt?: string | null
  lastUsedAt: string | null
  scopes: string[]
}

export interface CreateApiKeyInput {
  name: string
  scopes: readonly string[]
  purpose: ApiKeyPurpose
  createdBy: string
  now?: Date
  expiresAt?: Date | null
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
      reason: 'not_found' | 'insufficient_scope' | 'expired'
    }

export interface ApiKeyStoreLike {
  hasAnyKeys(): Promise<boolean>
  createKey?(input: CreateApiKeyInput): Promise<CreatedApiKey>
  listKeys?(): Promise<ApiKeyRecord[]>
  revokeKey?(id: string): Promise<boolean>
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
  schemaVersion?: number
  apiKeyRecordSchemaVersion?: number
  bootstrapInitializedAt?: string
  keys: ApiKeyRecord[]
}

interface ParsedApiKeyCollection {
  collection: PersistedApiKeyCollection
  needsMigration: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isApiKeyPurpose(value: unknown): value is ApiKeyPurpose {
  return typeof value === 'string' && API_KEY_PURPOSES.includes(value as ApiKeyPurpose)
}

function hasLegacyBootstrapTtl(
  value: Omit<ApiKeyRecord, 'purpose'> & { purpose?: unknown },
): boolean {
  if (typeof value.expiresAt !== 'string') {
    return false
  }
  const createdAtMs = Date.parse(value.createdAt)
  const expiresAtMs = Date.parse(value.expiresAt)
  return Number.isFinite(createdAtMs)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs - createdAtMs === DEFAULT_BOOTSTRAP_MASTER_KEY_TTL_MS
}

function hasLegacyBootstrapEvidence(
  value: Omit<ApiKeyRecord, 'purpose'> & { purpose?: unknown },
): boolean {
  // Legacy API-created keys always received the `hmrb_` prefix from
  // createRawApiKey(), including keys created while authenticated by another
  // API key (whose synthetic creator email was also `system`). Historical
  // bootstrap keys instead kept the caller-provided secret prefix. The first
  // generation used `Master Key` without an expiry; its successor used
  // `Bootstrap Master Key` with the fixed 24-hour bootstrap TTL. Require the
  // complete historical shape so an ambiguous legacy record remains permanent
  // rather than regaining temporary bootstrap semantics during upgrade.
  return value.createdBy === 'system'
    && !value.prefix.startsWith('hmrb_')
    && (
      (value.name === 'Master Key' && value.expiresAt == null)
      || (value.name === 'Bootstrap Master Key' && hasLegacyBootstrapTtl(value))
    )
}

function hasApiKeyRecordShape(value: unknown): value is Omit<ApiKeyRecord, 'purpose'> & { purpose?: unknown } {
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
    (
      value.expiresAt === undefined ||
      value.expiresAt === null ||
      typeof value.expiresAt === 'string'
    ) &&
    (value.lastUsedAt === null || typeof value.lastUsedAt === 'string') &&
    isStringArray(value.scopes)
  )
}

function toApiKeyRecord(value: unknown, allowLegacyPurposeInference: boolean): ApiKeyRecord | null {
  if (!hasApiKeyRecordShape(value)) {
    return null
  }

  if (isApiKeyPurpose(value.purpose)) {
    return value as ApiKeyRecord
  }

  if (value.purpose !== undefined || !allowLegacyPurposeInference) {
    return null
  }

  // One-time legacy migration only. Runtime behavior must use the persisted
  // purpose and must never re-infer it from creator identity alone.
  return {
    ...value,
    purpose: hasLegacyBootstrapEvidence(value) ? 'bootstrap' : 'permanent',
  }
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

function hasSameScopes(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  const rightSet = new Set(right)
  return left.every((scope) => rightSet.has(scope))
}

function mergeBootstrapMasterKeyScopes(scopes: readonly string[]): string[] {
  const normalizedScopes = normalizeScopes(scopes)
  const bootstrapScopeSet = new Set<string>(DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES)
  const extraScopes = normalizedScopes.filter((scope) => !bootstrapScopeSet.has(scope))
  return [...DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES, ...extraScopes]
}

function bootstrapMasterKeyExpiresAt(createdAt: string, now: Date): string {
  const createdAtMs = Date.parse(createdAt)
  const baseMs = Number.isFinite(createdAtMs) ? createdAtMs : now.getTime()
  return new Date(baseMs + DEFAULT_BOOTSTRAP_MASTER_KEY_TTL_MS).toISOString()
}

function toPersistedCollection(value: unknown): ParsedApiKeyCollection {
  if (
    isObject(value) &&
    Array.isArray(value.keys)
  ) {
    const recordSchemaVersion = value.apiKeyRecordSchemaVersion
    if (
      recordSchemaVersion !== undefined
      && recordSchemaVersion !== API_KEY_RECORD_SCHEMA_VERSION
    ) {
      throw new Error(`Unsupported API key record schema version: ${String(recordSchemaVersion)}`)
    }

    const needsMigration = recordSchemaVersion === undefined
    const keys = value.keys
      .map((item) => toApiKeyRecord(item, needsMigration))
      .filter((item): item is ApiKeyRecord => item !== null)

    if (!needsMigration && keys.length !== value.keys.length) {
      throw new Error('API key store contains a record without a valid explicit purpose')
    }

    return {
      needsMigration,
      collection: {
        apiKeyRecordSchemaVersion: API_KEY_RECORD_SCHEMA_VERSION,
        ...(
          typeof value.bootstrapInitializedAt === 'string'
          && value.bootstrapInitializedAt.trim().length > 0
            ? { bootstrapInitializedAt: value.bootstrapInitializedAt }
            : {}
        ),
        keys,
      },
    }
  }

  return {
    needsMigration: true,
    collection: {
      apiKeyRecordSchemaVersion: API_KEY_RECORD_SCHEMA_VERSION,
      keys: [],
    },
  }
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
  return path.join(resolveModuleDataDir('api-keys'), 'keys.json')
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

function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) {
    return false
  }

  const expiresAtMs = toEpochMs(expiresAt)
  if (expiresAtMs === null) {
    return true
  }

  return nowMs >= expiresAtMs
}

function isExpiredBootstrapRecord(record: ApiKeyRecord, nowMs: number): boolean {
  return record.purpose === 'bootstrap' && isExpired(record.expiresAt, nowMs)
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

  async canSeedDefaultKey(): Promise<boolean> {
    return this.withMutationLock(async () => (await this.readCollection()) === null)
  }

  async createKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const nowIso = (input.now ?? new Date()).toISOString()
    const rawKey = createRawApiKey()
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      keyHash: hashApiKey(rawKey),
      prefix: toKeyPrefix(rawKey),
      purpose: input.purpose,
      createdBy: input.createdBy.trim(),
      createdAt: nowIso,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
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

  /**
   * Seeds a caller-provided bootstrap master key only when the keystore file
   * has never existed. A persisted empty, expired, or revoked store is already
   * initialized and must never recreate bootstrap access.
   */
  async seedDefaultKey(rawKey: string, label = 'Master Key', now = new Date()): Promise<string | null> {
    return this.withMutationLock(async () => {
      const collection = await this.readCollection()
      const records = collection?.keys ?? []
      const nowMs = now.getTime()
      const defaultKeyHash = hashApiKey(rawKey)
      const matchingRecord = records.find((record) =>
        secureStringEqual(record.keyHash, defaultKeyHash),
      )

      if (matchingRecord) {
        if (isExpiredBootstrapRecord(matchingRecord, nowMs)) {
          if (collection && !collection.bootstrapInitializedAt) {
            await this.writeCollection({
              ...collection,
              bootstrapInitializedAt: now.toISOString(),
            })
          }
          return null
        }

        const nextScopes = mergeBootstrapMasterKeyScopes(matchingRecord.scopes)
        const nextExpiresAt = matchingRecord.expiresAt
          ?? bootstrapMasterKeyExpiresAt(matchingRecord.createdAt, now)
        const shouldRefreshRecord = matchingRecord.purpose === 'bootstrap'
          && (
            !hasSameScopes(matchingRecord.scopes, nextScopes)
            || matchingRecord.expiresAt !== nextExpiresAt
          )
        if (shouldRefreshRecord || !collection?.bootstrapInitializedAt) {
          const nextRecords = shouldRefreshRecord
            ? records.map((record) =>
                record.id === matchingRecord.id
                  ? {
                      ...record,
                      scopes: nextScopes,
                      expiresAt: nextExpiresAt,
                    }
                  : record,
              )
            : records
          await this.writeCollection({
            bootstrapInitializedAt: collection?.bootstrapInitializedAt ?? now.toISOString(),
            keys: nextRecords,
          })
        }
        return null
      }

      // File existence, not current record contents, defines whether bootstrap
      // initialization has already been consumed.
      if (collection !== null) {
        if (!collection.bootstrapInitializedAt) {
          await this.writeCollection({
            ...collection,
            bootstrapInitializedAt: now.toISOString(),
          })
        }
        return null
      }

      const record: ApiKeyRecord = {
        id: randomUUID(),
        name: label,
        keyHash: hashApiKey(rawKey),
        prefix: `boot_${defaultKeyHash.slice(0, 4)}`,
        purpose: 'bootstrap',
        createdBy: 'system',
        createdAt: now.toISOString(),
        expiresAt: bootstrapMasterKeyExpiresAt(now.toISOString(), now),
        lastUsedAt: null,
        scopes: [...DEFAULT_BOOTSTRAP_MASTER_KEY_SCOPES],
      }

      await this.writeCollection({
        bootstrapInitializedAt: now.toISOString(),
        keys: [record],
      })
      return rawKey
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

    const now = options.now ?? new Date()
    const nowMs = now.getTime()
    if (isExpired(matchedRecord.expiresAt, nowMs)) {
      return {
        ok: false,
        reason: 'expired',
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

    const nowIso = now.toISOString()
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
    return this.withMutationLock(() => this.readRecords())
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
    return (await this.readCollection())?.keys ?? []
  }

  private async readCollection(): Promise<PersistedApiKeyCollection | null> {
    const parsed = await readJsonFileFailClosed(this.filePath)
    if (parsed === null) {
      return null
    }
    const { collection, needsMigration } = toPersistedCollection(parsed)
    if (needsMigration) {
      await this.writeCollection(collection, { backup: true })
    }
    return collection
  }

  private async writeRecords(records: ApiKeyRecord[]): Promise<void> {
    const existing = await this.readCollection()
    await this.writeCollection({
      bootstrapInitializedAt: existing?.bootstrapInitializedAt ?? new Date().toISOString(),
      keys: records,
    })
  }

  private async writeCollection(
    payload: PersistedApiKeyCollection,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await writeJsonFileAtomically(
      this.filePath,
      withJsonStoreSchema({
        ...payload,
        apiKeyRecordSchemaVersion: API_KEY_RECORD_SCHEMA_VERSION,
      }),
      { trailingNewline: true, backup: options.backup },
    )
  }
}
