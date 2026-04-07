import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveDataPath } from '../runtime-paths.js'

const OPENAI_TRANSCRIPTION_SECRET_ID = 'openai-realtime-transcription'
const DEFAULT_ENV_KEY_NAME = 'HAMBROS_SETTINGS_ENCRYPTION_KEY'

interface EncryptedSecretRecord {
  iv: string
  authTag: string
  ciphertext: string
  updatedAt: string
}

interface PersistedSecretCollection {
  secrets: Record<string, EncryptedSecretRecord>
}

export interface OpenAITranscriptionKeyStatus {
  configured: boolean
  updatedAt: string | null
}

export interface OpenAITranscriptionKeyStoreLike {
  getStatus(): Promise<OpenAITranscriptionKeyStatus>
  getOpenAIApiKey(): Promise<string | null>
  setOpenAIApiKey(rawKey: string, options?: { now?: Date }): Promise<void>
  clearOpenAIApiKey(): Promise<boolean>
}

interface OpenAITranscriptionKeyStoreOptions {
  filePath?: string
  keyFilePath?: string
  encryptionKey?: string | Buffer
  envKeyName?: string
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
    typeof value.iv === 'string' &&
    value.iv.length > 0 &&
    typeof value.authTag === 'string' &&
    value.authTag.length > 0 &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length > 0 &&
    typeof value.updatedAt === 'string' &&
    value.updatedAt.length > 0
  )
}

function toPersistedSecretCollection(value: unknown): PersistedSecretCollection {
  if (!isObject(value) || !isObject(value.secrets)) {
    return { secrets: {} }
  }

  const secrets: Record<string, EncryptedSecretRecord> = {}
  for (const [secretId, secret] of Object.entries(value.secrets)) {
    if (isEncryptedSecretRecord(secret)) {
      secrets[secretId] = secret
    }
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

export function defaultTranscriptionSecretStorePath(): string {
  return resolveDataPath('api-keys', 'transcription-secrets.json')
}

export function defaultTranscriptionSecretKeyPath(): string {
  return resolveDataPath('api-keys', 'transcription-secrets.key')
}

export class OpenAITranscriptionKeyStore implements OpenAITranscriptionKeyStoreLike {
  private mutationQueue: Promise<void> = Promise.resolve()
  private encryptionKeyPromise: Promise<Buffer> | null = null
  private readonly filePath: string
  private readonly keyFilePath: string
  private readonly encryptionKeyInput?: string | Buffer
  private readonly envKeyName: string

  constructor(options: OpenAITranscriptionKeyStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultTranscriptionSecretStorePath()
    this.keyFilePath = options.keyFilePath ?? defaultTranscriptionSecretKeyPath()
    this.encryptionKeyInput = options.encryptionKey
    this.envKeyName = options.envKeyName ?? DEFAULT_ENV_KEY_NAME
  }

  async getStatus(): Promise<OpenAITranscriptionKeyStatus> {
    const state = await this.readCollectionConsistent()
    const secret = state.secrets[OPENAI_TRANSCRIPTION_SECRET_ID]
    return {
      configured: Boolean(secret),
      updatedAt: secret?.updatedAt ?? null,
    }
  }

  async getOpenAIApiKey(): Promise<string | null> {
    const state = await this.readCollectionConsistent()
    const secret = state.secrets[OPENAI_TRANSCRIPTION_SECRET_ID]
    if (!secret) {
      return null
    }

    const encryptionKey = await this.getEncryptionKey()
    return decryptSecret(secret, encryptionKey)
  }

  async setOpenAIApiKey(
    rawKey: string,
    options: { now?: Date } = {},
  ): Promise<void> {
    const normalizedKey = asNonEmptyString(rawKey)
    if (!normalizedKey) {
      throw new Error('OpenAI API key must not be empty')
    }

    const nowIso = (options.now ?? new Date()).toISOString()
    const encryptionKey = await this.getEncryptionKey()
    const encrypted = encryptSecret(normalizedKey, encryptionKey, nowIso)

    await this.withMutationLock(async () => {
      const state = await this.readCollection()
      state.secrets[OPENAI_TRANSCRIPTION_SECRET_ID] = encrypted
      await this.writeCollection(state)
    })
  }

  async clearOpenAIApiKey(): Promise<boolean> {
    return this.withMutationLock(async () => {
      const state = await this.readCollection()
      if (!state.secrets[OPENAI_TRANSCRIPTION_SECRET_ID]) {
        return false
      }

      delete state.secrets[OPENAI_TRANSCRIPTION_SECRET_ID]
      await this.writeCollection(state)
      return true
    })
  }

  private getEncryptionKey(): Promise<Buffer> {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = this.resolveEncryptionKey()
    }

    return this.encryptionKeyPromise
  }

  private async resolveEncryptionKey(): Promise<Buffer> {
    if (this.encryptionKeyInput) {
      return normalizeEncryptionKey(this.encryptionKeyInput)
    }

    const envValue = process.env[this.envKeyName]
    if (envValue && envValue.trim().length > 0) {
      return normalizeEncryptionKey(envValue)
    }

    return this.readOrCreateKeyFile()
  }

  private async readOrCreateKeyFile(): Promise<Buffer> {
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
    }

    const generated = randomBytes(32)
    await mkdir(path.dirname(this.keyFilePath), { recursive: true })
    await writeFile(this.keyFilePath, `${generated.toString('base64')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    return generated
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
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { secrets: {} }
      }
      throw error
    }

    try {
      const parsed = JSON.parse(contents) as unknown
      return toPersistedSecretCollection(parsed)
    } catch {
      return { secrets: {} }
    }
  }

  private async writeCollection(collection: PersistedSecretCollection): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8')
  }
}
