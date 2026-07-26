import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveModuleDataDir } from '../../modules/data-dir.js'
import {
  readJsonFileFailClosed,
  writeJsonFileAtomically,
  writeTextFileAtomically,
} from '../../modules/json-file.js'
import { withJsonStoreSchema } from '../../modules/json-store-schema.js'

export const OPENAI_REALTIME_TRANSCRIPTION_PROVIDER_ID = 'openai-realtime-transcription'
export const GEMINI_IMAGE_GENERATION_PROVIDER_ID = 'gemini-image-generation'

const DEFAULT_ENV_KEY_NAME = 'HERD_SETTINGS_ENCRYPTION_KEY'

interface EncryptedSecretRecord {
  iv: string
  authTag: string
  ciphertext: string
  updatedAt: string
}

interface PersistedSecretCollection {
  schemaVersion?: number
  secrets: Record<string, EncryptedSecretRecord>
}

export interface ProviderSecretStatus {
  configured: boolean
  updatedAt: string | null
}

export interface ProviderSecretSummary {
  providerId: string
  status: 'configured' | 'absent'
  updatedAt: string | null
}

export interface ProviderSecretsStoreLike {
  getSecretStatus(providerId: string): Promise<ProviderSecretStatus>
  getSecret(providerId: string): Promise<string | null>
  setSecret(providerId: string, value: string, options?: { now?: Date }): Promise<void>
  deleteSecret(providerId: string): Promise<void>
  listSecrets(): Promise<ProviderSecretSummary[]>
}

export interface ProviderSecretsStoreOptions {
  filePath?: string
  keyFilePath?: string
  encryptionKey?: string | Buffer
  envKeyName?: string
  env?: NodeJS.ProcessEnv
}

export type ProviderSecretsEncryptionReadinessCode =
  | 'ready'
  | 'store-invalid'
  | 'key-missing'
  | 'key-invalid'
  | 'decryption-failed'

export interface ProviderSecretsEncryptionReadiness {
  ready: boolean
  code: ProviderSecretsEncryptionReadinessCode
  error: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function isEncryptedSecretRecord(value: unknown): value is EncryptedSecretRecord {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.iv === 'string'
    && value.iv.length > 0
    && typeof value.authTag === 'string'
    && value.authTag.length > 0
    && typeof value.ciphertext === 'string'
    && value.ciphertext.length > 0
    && typeof value.updatedAt === 'string'
    && value.updatedAt.length > 0
  )
}

function toPersistedSecretCollection(value: unknown): PersistedSecretCollection {
  if (!isObject(value) || !isObject(value.secrets)) {
    throw new Error('Provider secrets store does not match the required shape')
  }

  const secrets: Record<string, EncryptedSecretRecord> = {}
  for (const [providerId, secret] of Object.entries(value.secrets)) {
    if (!isEncryptedSecretRecord(secret)) {
      throw new Error('Provider secrets store contains an invalid encrypted record')
    }
    secrets[providerId] = secret
  }

  return { secrets }
}

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length === 32) {
      return Buffer.from(value)
    }

    return createHash('sha256').update(value).digest()
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error('Encryption key must not be empty')
  }

  if (/^[a-fA-F0-9]{64}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex')
  }

  const base64Candidate = normalized.replace(/\s+/g, '')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64Candidate)) {
    const decoded = Buffer.from(base64Candidate, 'base64')
    if (decoded.length === 32) {
      return decoded
    }
  }

  return createHash('sha256').update(normalized).digest()
}

function encryptSecret(plainText: string, key: Buffer, updatedAt: string): EncryptedSecretRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt,
  }
}

function decryptSecret(record: EncryptedSecretRecord, key: Buffer): string | null {
  try {
    const iv = Buffer.from(record.iv, 'base64')
    const authTag = Buffer.from(record.authTag, 'base64')
    const ciphertext = Buffer.from(record.ciphertext, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    return null
  }
}

export function defaultProviderSecretStorePath(): string {
  return path.join(resolveModuleDataDir('api-keys'), 'provider-secrets.json')
}

export function defaultProviderSecretKeyPath(): string {
  return path.join(resolveModuleDataDir('api-keys'), 'provider-secrets.key')
}

export class ProviderSecretsStore
  implements ProviderSecretsStoreLike
{
  private mutationQueue: Promise<void> = Promise.resolve()
  private encryptionKeyPromise: Promise<Buffer> | null = null
  private readonly filePath: string
  private readonly keyFilePath: string
  private readonly encryptionKeyInput?: string | Buffer
  private readonly envKeyName: string
  private readonly env: NodeJS.ProcessEnv

  constructor(options: ProviderSecretsStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultProviderSecretStorePath()
    this.keyFilePath = options.keyFilePath ?? defaultProviderSecretKeyPath()
    this.encryptionKeyInput = options.encryptionKey
    this.envKeyName = options.envKeyName ?? DEFAULT_ENV_KEY_NAME
    this.env = options.env ?? process.env
  }

  async getSecretStatus(providerId: string): Promise<ProviderSecretStatus> {
    const normalizedProviderId = this.requireProviderId(providerId)
    const state = await this.readCollectionConsistent()
    const secret = state.secrets[normalizedProviderId]
    return {
      configured: Boolean(secret),
      updatedAt: secret?.updatedAt ?? null,
    }
  }

  async getSecret(providerId: string): Promise<string | null> {
    const normalizedProviderId = this.requireProviderId(providerId)
    const state = await this.readCollectionConsistent()
    const secret = state.secrets[normalizedProviderId]
    if (!secret) {
      return null
    }

    const encryptionKey = await this.getEncryptionKey({ allowCreate: false })
    const decrypted = decryptSecret(secret, encryptionKey)
    if (!asNonEmptyString(decrypted)) {
      throw new Error('Configured provider secret cannot be decrypted with the active encryption key')
    }
    return decrypted
  }

  async setSecret(
    providerId: string,
    value: string,
    options: { now?: Date } = {},
  ): Promise<void> {
    const normalizedProviderId = this.requireProviderId(providerId)
    const normalizedValue = asNonEmptyString(value)
    if (!normalizedValue) {
      throw new Error('Provider secret must not be empty')
    }

    await this.withMutationLock(async () => {
      const state = await this.readCollection()
      const encryptionKey = await this.getEncryptionKey({
        allowCreate: Object.keys(state.secrets).length === 0,
      })
      const nowIso = (options.now ?? new Date()).toISOString()
      const encrypted = encryptSecret(normalizedValue, encryptionKey, nowIso)
      state.secrets[normalizedProviderId] = encrypted
      await this.writeCollection(state)
    })
  }

  async deleteSecret(providerId: string): Promise<void> {
    await this.deleteSecretInternal(providerId)
  }

  async listSecrets(): Promise<ProviderSecretSummary[]> {
    const state = await this.readCollectionConsistent()
    return Object.entries(state.secrets)
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
      .map(([providerId, secret]) => ({
        providerId,
        status: 'configured',
        updatedAt: secret.updatedAt,
      }))
  }

  /**
   * Verifies the persisted ciphertext/key pair without creating or rotating a
   * key. The result is deliberately sanitized for startup and health logs.
   */
  async inspectEncryptionReadiness(): Promise<ProviderSecretsEncryptionReadiness> {
    let state: PersistedSecretCollection
    try {
      state = await this.readCollectionConsistent()
    } catch {
      return {
        ready: false,
        code: 'store-invalid',
        error: 'Provider secrets store is unreadable or does not match the required shape.',
      }
    }

    let encryptionKey: Buffer | null
    try {
      encryptionKey = await this.resolveExistingEncryptionKey()
    } catch {
      return {
        ready: false,
        code: 'key-invalid',
        error: 'Provider secrets encryption key is invalid or unreadable.',
      }
    }

    const encryptedSecrets = Object.values(state.secrets)
    if (encryptedSecrets.length === 0) {
      return { ready: true, code: 'ready', error: null }
    }
    if (!encryptionKey) {
      return {
        ready: false,
        code: 'key-missing',
        error: 'Provider secrets encryption key is missing for persisted ciphertext.',
      }
    }
    if (encryptedSecrets.some((secret) => !asNonEmptyString(decryptSecret(secret, encryptionKey)))) {
      return {
        ready: false,
        code: 'decryption-failed',
        error: 'Provider secrets cannot be decrypted with the configured encryption key.',
      }
    }
    return { ready: true, code: 'ready', error: null }
  }

  private requireProviderId(providerId: string): string {
    const normalized = asNonEmptyString(providerId)
    if (!normalized) {
      throw new Error('providerId is required')
    }
    return normalized
  }

  private async deleteSecretInternal(providerId: string): Promise<boolean> {
    const normalizedProviderId = this.requireProviderId(providerId)
    return this.withMutationLock(async () => {
      const state = await this.readCollection()
      if (!state.secrets[normalizedProviderId]) {
        return false
      }

      delete state.secrets[normalizedProviderId]
      await this.writeCollection(state)
      return true
    })
  }

  private async getEncryptionKey(options: { allowCreate: boolean }): Promise<Buffer> {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = this.resolveEncryptionKey(options)
    }
    try {
      return await this.encryptionKeyPromise
    } catch (error) {
      this.encryptionKeyPromise = null
      throw error
    }
  }

  private async resolveEncryptionKey(options: { allowCreate: boolean }): Promise<Buffer> {
    const existing = await this.resolveExistingEncryptionKey()
    if (existing) {
      return existing
    }
    if (!options.allowCreate) {
      throw new Error('Provider secrets encryption key is missing for persisted ciphertext')
    }

    const generated = randomBytes(32)
    await writeTextFileAtomically(this.keyFilePath, `${generated.toString('base64')}\n`, {
      mode: 0o600,
    })
    return generated
  }

  private async resolveExistingEncryptionKey(): Promise<Buffer | null> {
    if (this.encryptionKeyInput) {
      return normalizeEncryptionKey(this.encryptionKeyInput)
    }

    const envValue = this.env[this.envKeyName]
    if (envValue && envValue.trim().length > 0) {
      return normalizeEncryptionKey(envValue)
    }

    try {
      const existing = await readFile(this.keyFilePath, 'utf8')
      const normalized = existing.trim()
      if (normalized.length === 0) {
        throw new Error('Stored encryption key is empty')
      }
      const parsed = Buffer.from(normalized, 'base64')
      if (parsed.length !== 32) {
        throw new Error('Stored encryption key must decode to 32 bytes')
      }
      return parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        throw error
      }
      return null
    }
  }

  private async readCollectionConsistent(): Promise<PersistedSecretCollection> {
    await this.mutationQueue
    return this.readCollection()
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async readCollection(): Promise<PersistedSecretCollection> {
    const parsed = await readJsonFileFailClosed(this.filePath)
    if (parsed === null) {
      return { secrets: {} }
    }
    return toPersistedSecretCollection(parsed)
  }

  private async writeCollection(collection: PersistedSecretCollection): Promise<void> {
    await writeJsonFileAtomically(this.filePath, withJsonStoreSchema(collection), { trailingNewline: true })
  }
}
