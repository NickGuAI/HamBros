import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveHerdDataDir } from '../data-dir.js'
import type { MachineConfig } from './types.js'

const MACHINE_CREDENTIALS_VERSION = 1
const MASTER_KEY_ENV = 'HERD_MASTER_KEY'

export const HERD_MACHINE_ENV_PREFIX = 'HERD_MACHINE_ENV_'

export interface EncryptedMachineEnvRecord {
  version: number
  iv: string
  authTag: string
  ciphertext: string
  updatedAt: string
}

export interface PreparedMachineLaunchEnvironment {
  env: NodeJS.ProcessEnv
  sshSendEnvKeys: string[]
  sourcedEnvFile?: string
}

export type MachineCredentialsEncryptionReadinessCode =
  | 'ready'
  | 'store-invalid'
  | 'key-missing'
  | 'key-invalid'
  | 'decryption-failed'

export interface MachineCredentialsEncryptionReadiness {
  ready: boolean
  code: MachineCredentialsEncryptionReadinessCode
  error: string | null
}

export interface MachineCredentialsKeyOptions {
  keyFilePath?: string
  env?: NodeJS.ProcessEnv
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isEncryptedMachineEnvRecord(value: unknown): value is EncryptedMachineEnvRecord {
  return (
    isObject(value) &&
    value.version === MACHINE_CREDENTIALS_VERSION &&
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

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return value.length === 32
      ? Buffer.from(value)
      : createHash('sha256').update(value).digest()
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error('Machine credentials key must not be empty')
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

function deriveMachineEncryptionKey(masterKey: Buffer, machineId: string): Buffer {
  return createHmac('sha256', masterKey)
    .update(`herd-machine-env:${machineId}`)
    .digest()
}

function encryptEnvContents(plainText: string, key: Buffer, updatedAt: string): EncryptedMachineEnvRecord {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    version: MACHINE_CREDENTIALS_VERSION,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt,
  }
}

function decryptEnvContents(record: EncryptedMachineEnvRecord, key: Buffer): string {
  const iv = Buffer.from(record.iv, 'base64')
  const authTag = Buffer.from(record.authTag, 'base64')
  const ciphertext = Buffer.from(record.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plainText.toString('utf8')
}

function stripOptionalExportPrefix(line: string): string {
  return line.startsWith('export ') ? line.slice('export '.length).trim() : line
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function parseMachineEnvContents(contents: string): Record<string, string> | null {
  const entries: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/g)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const normalized = stripOptionalExportPrefix(trimmed)
    const separatorIndex = normalized.indexOf('=')
    if (separatorIndex <= 0) {
      return null
    }

    const key = normalized.slice(0, separatorIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return null
    }

    entries[key] = parseEnvValue(normalized.slice(separatorIndex + 1))
  }

  return entries
}

export function defaultMachineCredentialsKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHerdDataDir(env), 'master.key')
}

function resolveExistingMachineCredentialsKeySync(
  keyFilePath = defaultMachineCredentialsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const envValue = env[MASTER_KEY_ENV]?.trim()
  if (envValue) {
    return normalizeEncryptionKey(envValue)
  }

  try {
    const existing = readFileSync(keyFilePath, 'utf8').trim()
    if (!existing) {
      throw new Error('Stored machine credentials key is empty')
    }
    const parsed = Buffer.from(existing, 'base64')
    if (parsed.length !== 32) {
      throw new Error('Stored machine credentials key must decode to 32 bytes')
    }
    return parsed
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }

  return null
}

function requireExistingMachineCredentialsKeySync(
  keyFilePath = defaultMachineCredentialsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const existing = resolveExistingMachineCredentialsKeySync(keyFilePath, env)
  if (!existing) {
    throw new Error('Machine credentials encryption key is missing for persisted ciphertext')
  }
  return existing
}

async function readOrCreateMachineCredentialsKey(
  keyFilePath = defaultMachineCredentialsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const existing = await resolveExistingMachineCredentialsKey(keyFilePath, env)
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

async function resolveExistingMachineCredentialsKey(
  keyFilePath = defaultMachineCredentialsKeyPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null> {
  const envValue = env[MASTER_KEY_ENV]?.trim()
  if (envValue) {
    return normalizeEncryptionKey(envValue)
  }

  try {
    const existing = (await readFile(keyFilePath, 'utf8')).trim()
    if (!existing) {
      throw new Error('Stored machine credentials key is empty')
    }
    const parsed = Buffer.from(existing, 'base64')
    if (parsed.length !== 32) {
      throw new Error('Stored machine credentials key must decode to 32 bytes')
    }
    return parsed
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }

  return null
}

function encryptedMachineEnvPath(envFilePath: string): string {
  return envFilePath.endsWith('.enc') ? envFilePath : `${envFilePath}.enc`
}

function encodeMachineEnvForSsh(entries: Record<string, string>): { env: NodeJS.ProcessEnv; sendEnvKeys: string[] } {
  const env: NodeJS.ProcessEnv = {}
  const sendEnvKeys: string[] = []
  let index = 0

  for (const [key, value] of Object.entries(entries)) {
    const transportKey = `${HERD_MACHINE_ENV_PREFIX}${String(index).padStart(4, '0')}`
    env[transportKey] = `${key}=${value}`
    sendEnvKeys.push(transportKey)
    index += 1
  }

  return { env, sendEnvKeys }
}

function loadEncryptedEnvEntriesSync(machine: MachineConfig, envFilePath: string): Record<string, string> {
  const raw = readFileSync(envFilePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isEncryptedMachineEnvRecord(parsed)) {
    throw new Error(`Invalid encrypted machine env file: ${envFilePath}`)
  }
  const plainText = decryptEnvContents(
    parsed,
    deriveMachineEncryptionKey(requireExistingMachineCredentialsKeySync(), machine.id),
  )
  const entries = parseMachineEnvContents(plainText)
  if (!entries) {
    throw new Error(`Encrypted machine env file is not parseable: ${envFilePath}`)
  }
  return entries
}

/**
 * Verifies a persisted machine credential file without creating or rotating a
 * key. Missing files remain valid because launch-time behavior treats a stale
 * optional `.enc` registry reference as an empty credential set.
 */
export async function inspectMachineCredentialsEncryptionReadiness(
  machine: MachineConfig,
  options: MachineCredentialsKeyOptions & { envFilePath?: string } = {},
): Promise<MachineCredentialsEncryptionReadiness> {
  const envFilePath = options.envFilePath ?? machine.envFile?.trim()
  if (!envFilePath || !envFilePath.endsWith('.enc')) {
    return { ready: true, code: 'ready', error: null }
  }

  let record: EncryptedMachineEnvRecord
  try {
    const raw = await readFile(envFilePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isEncryptedMachineEnvRecord(parsed)) {
      throw new Error('Invalid encrypted machine credentials record')
    }
    record = parsed
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ready: true, code: 'ready', error: null }
    }
    return {
      ready: false,
      code: 'store-invalid',
      error: 'Machine credentials store is unreadable or does not match the required shape.',
    }
  }

  let masterKey: Buffer | null
  try {
    masterKey = await resolveExistingMachineCredentialsKey(
      options.keyFilePath,
      options.env ?? process.env,
    )
  } catch {
    return {
      ready: false,
      code: 'key-invalid',
      error: 'Machine credentials encryption key is invalid or unreadable.',
    }
  }
  if (!masterKey) {
    return {
      ready: false,
      code: 'key-missing',
      error: 'Machine credentials encryption key is missing for persisted ciphertext.',
    }
  }

  let plainText: string
  try {
    plainText = decryptEnvContents(record, deriveMachineEncryptionKey(masterKey, machine.id))
  } catch {
    return {
      ready: false,
      code: 'decryption-failed',
      error: 'Machine credentials cannot be decrypted with the configured encryption key.',
    }
  }
  if (!parseMachineEnvContents(plainText)) {
    return {
      ready: false,
      code: 'store-invalid',
      error: 'Machine credentials decrypted contents do not match the required env-file shape.',
    }
  }
  return { ready: true, code: 'ready', error: null }
}

function loadPlaintextEnvEntriesSync(envFilePath: string): Record<string, string> | null {
  try {
    if (!statSync(envFilePath).isFile()) {
      return null
    }
    const contents = readFileSync(envFilePath, 'utf8')
    return parseMachineEnvContents(contents)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

export function prepareMachineLaunchEnvironment(
  machine: MachineConfig | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): PreparedMachineLaunchEnvironment {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const envFile = machine?.envFile?.trim()
  if (!envFile) {
    return { env, sshSendEnvKeys: [] }
  }

  if (!machine) {
    return {
      env,
      sshSendEnvKeys: [],
      sourcedEnvFile: envFile,
    }
  }

  if (envFile.endsWith('.enc')) {
    let entries: Record<string, string>
    try {
      entries = loadEncryptedEnvEntriesSync(machine, envFile)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Missing `.enc` file → no entries to inject. Mirrors the plaintext
        // path's silent fallback (`. <file> || true`) so a stale registry
        // pointing at a deleted env file doesn't abort the auth-status probe
        // or any other downstream consumer; credentials are simply unset.
        // Real corruption (invalid JSON, decrypt failure) still throws.
        return { env, sshSendEnvKeys: [] }
      }
      throw error
    }
    if (machine?.host) {
      const encoded = encodeMachineEnvForSsh(entries)
      return {
        env: { ...env, ...encoded.env },
        sshSendEnvKeys: encoded.sendEnvKeys,
      }
    }
    return {
      env: { ...env, ...entries },
      sshSendEnvKeys: [],
    }
  }

  // Remote machines with a non-`.enc` envFile path: the file lives on the
  // remote host. Do NOT read it locally — that either reads nothing (the path
  // doesn't exist on the Herd host) or, worse, reads unrelated local
  // content if the same path coincidentally exists locally and forwards it
  // via SSH SendEnv, silently bypassing the remote's actual env file.
  // Encrypted (`.enc`) is the explicit local-managed-credentials channel and
  // is handled above; plaintext envFile on remote = "shell-source on remote".
  if (machine?.host) {
    return {
      env,
      sshSendEnvKeys: [],
      sourcedEnvFile: envFile,
    }
  }

  const plainTextEntries = loadPlaintextEnvEntriesSync(envFile)
  if (plainTextEntries) {
    return {
      env: { ...env, ...plainTextEntries },
      sshSendEnvKeys: [],
    }
  }

  return {
    env,
    sshSendEnvKeys: [],
    sourcedEnvFile: envFile,
  }
}

export function prepareDaemonMachineLaunchEnvironment(
  machine: MachineConfig | undefined,
): PreparedMachineLaunchEnvironment {
  const env: NodeJS.ProcessEnv = {}
  const envFile = machine?.envFile?.trim()
  if (!envFile) {
    return { env, sshSendEnvKeys: [] }
  }

  if (!machine) {
    return {
      env,
      sshSendEnvKeys: [],
      sourcedEnvFile: envFile,
    }
  }

  if (envFile.endsWith('.enc')) {
    try {
      return {
        env: { ...env, ...loadEncryptedEnvEntriesSync(machine, envFile) },
        sshSendEnvKeys: [],
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { env, sshSendEnvKeys: [] }
      }
      throw error
    }
  }

  return {
    env,
    sshSendEnvKeys: [],
    sourcedEnvFile: envFile,
  }
}

export async function encryptMachineEnvFile(
  machine: MachineConfig,
  filePath: string,
  keyOptions: MachineCredentialsKeyOptions = {},
): Promise<string> {
  const contents = await readFile(filePath, 'utf8')
  const parsed = parseMachineEnvContents(contents)
  if (!parsed) {
    return filePath
  }

  const key = deriveMachineEncryptionKey(
    await readOrCreateMachineCredentialsKey(
      keyOptions.keyFilePath,
      keyOptions.env ?? process.env,
    ),
    machine.id,
  )
  const encrypted = encryptEnvContents(contents, key, new Date().toISOString())
  const encryptedPath = encryptedMachineEnvPath(filePath)

  await mkdir(path.dirname(encryptedPath), { recursive: true, mode: 0o700 })
  await writeFile(encryptedPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (encryptedPath !== filePath) {
    await unlink(filePath)
  }
  return encryptedPath
}

function shellQuoteEnvValue(value: string): string {
  // Single-quote the value for predictable shell behavior; escape inner quotes.
  return `'${value.replace(/'/g, "'\\''")}'`
}

function serializeMachineEnvEntries(entries: Record<string, string>): string {
  // Empty-value entries (`KEY=`) are intentionally preserved — operators may
  // rely on them to clear inherited settings. Use `null` in updates to delete.
  const lines = Object.entries(entries)
    .map(([key, value]) => `export ${key}=${shellQuoteEnvValue(value)}`)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

async function readMachineEnvEntries(
  machine: MachineConfig,
  envFilePath: string,
): Promise<Record<string, string>> {
  const trimmed = envFilePath.trim()
  if (!trimmed) {
    return {}
  }

  if (trimmed.endsWith('.enc')) {
    try {
      return loadEncryptedEnvEntriesSync(machine, trimmed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {}
      }
      throw error
    }
  }

  try {
    const contents = await readFile(trimmed, 'utf8')
    return parseMachineEnvContents(contents) ?? {}
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {}
    }
    throw error
  }
}

/**
 * Apply key/value updates to a machine's local env file, preserving encryption format.
 *
 * - If `envFilePath` ends with `.enc`, the file is decrypted, updated, and re-encrypted with
 *   the per-machine derived key. Format is preserved end-to-end.
 * - If `envFilePath` is plaintext, updates are applied as `export KEY='value'` lines.
 * - Update value `null` removes the key. Empty string `''` sets the key to an
 *   empty value (`export KEY=''`) — operators rely on this to clear inherited
 *   settings without removing the assignment entirely.
 * - Existing entries not mentioned in `updates` are preserved as-is.
 * - Creates the file (with `0o600` mode and `0o700` parent directory) if it doesn't exist.
 *
 * Bypassing this helper for `.enc` files (e.g. raw `readFile`/`writeFile`) overwrites
 * the encrypted record with shell text and silently breaks future launches that
 * expect to decrypt the file. See codex-review on PR #1269.
 *
 * Note: this helper is for **local** machine env files only — it operates on the
 * Herd server's local filesystem where the master key lives. Remote machine
 * env files (plaintext-on-the-remote) should be edited via the existing SSH
 * cat/write helpers in `machine-auth.ts`.
 */
export async function updateMachineEnvEntries(
  machine: MachineConfig,
  envFilePath: string,
  updates: Record<string, string | null>,
): Promise<Record<string, string>> {
  const trimmed = envFilePath.trim()
  if (!trimmed) {
    throw new Error('updateMachineEnvEntries requires a non-empty envFilePath')
  }

  const isEncrypted = trimmed.endsWith('.enc')
  const current = await readMachineEnvEntries(machine, trimmed)

  const next = { ...current }
  for (const [key, value] of Object.entries(updates)) {
    // null = delete; empty string = set to empty (preserve `KEY=`); else set value.
    if (value === null) {
      delete next[key]
    } else {
      next[key] = value
    }
  }

  const plainText = serializeMachineEnvEntries(next)

  await mkdir(path.dirname(trimmed), { recursive: true, mode: 0o700 })

  if (isEncrypted) {
    const key = deriveMachineEncryptionKey(
      await readOrCreateMachineCredentialsKey(),
      machine.id,
    )
    const encrypted = encryptEnvContents(plainText, key, new Date().toISOString())
    await writeFile(trimmed, `${JSON.stringify(encrypted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } else {
    await writeFile(trimmed, plainText, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  return next
}
