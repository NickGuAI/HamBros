import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderDataDir, resolveCommanderPaths } from './paths.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'

const COMMANDER_SECRETS_VERSION = 1
const MASTER_KEY_ENV = 'HERD_MASTER_KEY'

export interface EncryptedCommanderSecretsFile {
  version: number
  iv: string
  authTag: string
  ciphertext: string
  updatedAt: string
}

interface CommanderSecretEntry {
  value: string
  updatedAt: string
}

interface PlainCommanderSecretsFile {
  secrets: Record<string, CommanderSecretEntry>
}

export type CommanderSecretsEncryptionReadinessCode =
  | 'ready'
  | 'store-invalid'
  | 'key-missing'
  | 'key-invalid'
  | 'decryption-failed'

export interface CommanderSecretsEncryptionReadiness {
  ready: boolean
  code: CommanderSecretsEncryptionReadinessCode
  error: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isEncryptedCommanderSecretsFile(value: unknown): value is EncryptedCommanderSecretsFile {
  return (
    isObject(value)
    && value.version === COMMANDER_SECRETS_VERSION
    && typeof value.iv === 'string'
    && value.iv.length > 0
    && typeof value.authTag === 'string'
    && value.authTag.length > 0
    && typeof value.ciphertext === 'string'
    && value.ciphertext.length > 0
    && typeof value.updatedAt === 'string'
    && value.updatedAt.length > 0
  )
}

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return value.length === 32
      ? Buffer.from(value)
      : createHash('sha256').update(value).digest()
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error('Commander secrets key must not be empty')
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

function defaultCommanderSecretsKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCommanderDataDir(env), 'master.key')
}

async function readOrCreateCommanderSecretsKey(
  keyFilePath = defaultCommanderSecretsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const existing = await resolveExistingCommanderSecretsKey(keyFilePath, env)
  if (existing) {
    return existing
  }

  const generated = randomBytes(32)
  await mkdir(path.dirname(keyFilePath), { recursive: true, mode: 0o700 })
  await writeFile(keyFilePath, `${generated.toString('base64')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return generated
}

async function resolveExistingCommanderSecretsKey(
  keyFilePath = defaultCommanderSecretsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  const envValue = env[MASTER_KEY_ENV]?.trim()
  if (envValue) {
    return normalizeEncryptionKey(envValue)
  }

  try {
    const existing = (await readFile(keyFilePath, 'utf8')).trim()
    const parsed = Buffer.from(existing, 'base64')
    if (parsed.length !== 32) {
      throw new Error('Stored commander secrets key must decode to 32 bytes')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return null
}

function deriveCommanderSecretsKey(masterKey: Buffer, commanderId: string): Buffer {
  return createHmac('sha256', masterKey)
    .update(`herd-commander-secrets:${commanderId}`)
    .digest()
}

function encryptPlainSecrets(
  plain: PlainCommanderSecretsFile,
  key: Buffer,
  updatedAt: string,
): EncryptedCommanderSecretsFile {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plain), 'utf8'),
    cipher.final(),
  ])
  return {
    version: COMMANDER_SECRETS_VERSION,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt,
  }
}

function decryptPlainSecrets(
  record: EncryptedCommanderSecretsFile,
  key: Buffer,
): PlainCommanderSecretsFile {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
  const parsed = JSON.parse(plaintext) as unknown
  if (!isObject(parsed) || !isObject(parsed.secrets)) {
    return { secrets: {} }
  }

  const secrets: Record<string, CommanderSecretEntry> = {}
  for (const [keyName, rawEntry] of Object.entries(parsed.secrets)) {
    if (!isObject(rawEntry) || typeof rawEntry.value !== 'string') {
      continue
    }
    secrets[keyName] = {
      value: rawEntry.value,
      updatedAt: typeof rawEntry.updatedAt === 'string' ? rawEntry.updatedAt : record.updatedAt,
    }
  }
  return { secrets }
}

function normalizeSecretName(name: string): string {
  const normalized = name.trim()
  if (!/^[a-zA-Z0-9_.:@/-]{1,160}$/.test(normalized)) {
    throw new Error('Commander secret name must be 1-160 safe characters')
  }
  return normalized
}

export class CommanderSecretsStore {
  private readonly dataDir: string
  private readonly keyFilePath: string
  private readonly env: NodeJS.ProcessEnv
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: {
    dataDir?: string
    keyFilePath?: string
    env?: NodeJS.ProcessEnv
  } = {}) {
    this.dataDir = path.resolve(options.dataDir ?? resolveCommanderDataDir(options.env ?? process.env))
    this.keyFilePath = options.keyFilePath ?? defaultCommanderSecretsKeyPath(options.env ?? process.env)
    this.env = options.env ?? process.env
  }

  async getSecret(commanderId: string, name: string): Promise<string | null> {
    const plain = await this.readPlain(commanderId)
    return plain.secrets[normalizeSecretName(name)]?.value ?? null
  }

  async setSecret(commanderId: string, name: string, value: string): Promise<void> {
    const normalizedName = normalizeSecretName(name)
    const normalizedValue = value.trim()
    if (!normalizedValue) {
      throw new Error('Commander secret value must not be empty')
    }

    await this.withMutationLock(async () => {
      const plain = await this.readPlain(commanderId)
      plain.secrets[normalizedName] = {
        value: normalizedValue,
        updatedAt: new Date().toISOString(),
      }
      await this.writePlain(commanderId, plain)
    })
  }

  async deleteSecret(commanderId: string, name: string): Promise<void> {
    const normalizedName = normalizeSecretName(name)
    await this.withMutationLock(async () => {
      const plain = await this.readPlain(commanderId)
      delete plain.secrets[normalizedName]
      await this.writePlain(commanderId, plain)
    })
  }

  /**
   * Verifies an existing commander ciphertext/key pair without creating or
   * rotating a key. The result is sanitized for readiness and startup logs.
   */
  async inspectEncryptionReadiness(
    commanderId: string,
  ): Promise<CommanderSecretsEncryptionReadiness> {
    const filePath = this.secretsPath(commanderId)
    let parsed: EncryptedCommanderSecretsFile
    try {
      const raw = await readFile(filePath, 'utf8')
      const candidate = JSON.parse(raw) as unknown
      if (!isEncryptedCommanderSecretsFile(candidate)) {
        throw new Error('Invalid encrypted commander secrets record')
      }
      parsed = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ready: true, code: 'ready', error: null }
      }
      return {
        ready: false,
        code: 'store-invalid',
        error: 'Commander secrets store is unreadable or does not match the required shape.',
      }
    }

    let masterKey: Buffer | null
    try {
      masterKey = await resolveExistingCommanderSecretsKey(this.keyFilePath, this.env)
    } catch {
      return {
        ready: false,
        code: 'key-invalid',
        error: 'Commander secrets encryption key is invalid or unreadable.',
      }
    }
    if (!masterKey) {
      return {
        ready: false,
        code: 'key-missing',
        error: 'Commander secrets encryption key is missing for persisted ciphertext.',
      }
    }

    try {
      decryptPlainSecrets(parsed, deriveCommanderSecretsKey(masterKey, commanderId))
    } catch {
      return {
        ready: false,
        code: 'decryption-failed',
        error: 'Commander secrets cannot be decrypted with the configured encryption key.',
      }
    }
    return { ready: true, code: 'ready', error: null }
  }

  private secretsPath(commanderId: string): string {
    return path.join(resolveCommanderPaths(commanderId, this.dataDir).commanderRoot, 'secrets.enc')
  }

  private async readPlain(commanderId: string): Promise<PlainCommanderSecretsFile> {
    const filePath = this.secretsPath(commanderId)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { secrets: {} }
      }
      throw error
    }

    const parsed = JSON.parse(raw) as unknown
    if (!isEncryptedCommanderSecretsFile(parsed)) {
      throw new Error(`Invalid commander secrets file: ${filePath}`)
    }

    const masterKey = await resolveExistingCommanderSecretsKey(this.keyFilePath, this.env)
    if (!masterKey) {
      throw new Error('Commander secrets encryption key is missing for persisted ciphertext')
    }
    const key = deriveCommanderSecretsKey(masterKey, commanderId)
    return decryptPlainSecrets(parsed, key)
  }

  private async writePlain(
    commanderId: string,
    plain: PlainCommanderSecretsFile,
  ): Promise<void> {
    await withCommanderMutation(commanderId, this.dataDir, async () => {
      const filePath = this.secretsPath(commanderId)
      const key = deriveCommanderSecretsKey(
        await readOrCreateCommanderSecretsKey(this.keyFilePath, this.env),
        commanderId,
      )
      const encrypted = encryptPlainSecrets(plain, key, new Date().toISOString())
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      await writeFile(filePath, `${JSON.stringify(encrypted, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    })
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
