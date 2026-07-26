import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveHerdDataDir } from '../data-dir.js'
import { withJsonStoreSchema } from '../json-store-schema.js'
import type { Operator, OperatorKind } from './types.js'

const OPERATOR_KINDS = new Set<OperatorKind>([
  'founder',
  'cofounder',
  'contractor',
  'va',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneOperator(operator: Operator): Operator {
  return {
    ...operator,
  }
}

function parseOptionalAvatarUrl(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error('Operator avatarUrl must be a string or null')
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeOperatorKind(value: unknown): OperatorKind {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (OPERATOR_KINDS.has(normalized as OperatorKind)) {
    return normalized as OperatorKind
  }

  throw new Error(`Invalid operator kind "${normalized || String(value)}"`)
}

function requireNonEmptyString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length > 0) {
    return normalized
  }

  throw new Error(`Operator ${field} is required`)
}

function isSyntheticAuth0LocalEmail(value: string | null): value is string {
  return value !== null && /^.+@auth0\.local$/.test(value)
}

function parseOptionalEmail(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error('Operator email must be a string or null')
  }

  const normalized = value.trim()
  if (!normalized || isSyntheticAuth0LocalEmail(normalized)) {
    return null
  }

  return normalized
}

function normalizeOperator(input: Operator): Operator {
  return {
    id: requireNonEmptyString(input.id, 'id'),
    kind: normalizeOperatorKind(input.kind),
    displayName: requireNonEmptyString(input.displayName, 'displayName'),
    email: parseOptionalEmail(input.email),
    avatarUrl: parseOptionalAvatarUrl(input.avatarUrl),
    createdAt: requireNonEmptyString(input.createdAt, 'createdAt'),
  }
}

function parsePersistedOperator(raw: unknown): Operator {
  if (!isObject(raw)) {
    throw new Error('Operator store must contain a JSON object')
  }

  return normalizeOperator({
    id: raw.id as Operator['id'],
    kind: raw.kind as Operator['kind'],
    displayName: raw.displayName as Operator['displayName'],
    email: raw.email as Operator['email'],
    avatarUrl: raw.avatarUrl as Operator['avatarUrl'],
    createdAt: raw.createdAt as Operator['createdAt'],
  })
}

export function isPersistedOperatorValid(raw: unknown): boolean {
  try {
    parsePersistedOperator(raw)
    return true
  } catch {
    return false
  }
}

interface RawOperatorRead {
  operator: Operator
  rawEmail: string | null
}

export function defaultOperatorStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHerdDataDir(env), 'operators.json')
}

export class OperatorStore {
  private readonly filePath: string
  private operator: Operator | null = null
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string = defaultOperatorStorePath()) {
    this.filePath = path.resolve(filePath)
  }

  async get(id: string): Promise<Operator | null> {
    await this.ensureLoaded()
    const normalizedId = id.trim()
    if (!normalizedId || !this.operator || this.operator.id !== normalizedId) {
      return null
    }

    return cloneOperator(this.operator)
  }

  async getFounder(): Promise<Operator | null> {
    await this.ensureLoaded()
    if (!this.operator || this.operator.kind !== 'founder') {
      return null
    }

    return cloneOperator(this.operator)
  }

  async getFounderById(id: string): Promise<Operator | null> {
    const operator = await this.get(id)
    return operator?.kind === 'founder' ? operator : null
  }

  async save(operator: Operator): Promise<Operator> {
    await this.ensureLoaded()
    return this.withMutationLock(async () => {
      const normalized = normalizeOperator(operator)
      this.operator = cloneOperator(normalized)
      await this.writeToDisk()
      return cloneOperator(normalized)
    })
  }

  async saveFounder(operator: Operator): Promise<Operator> {
    if (operator.kind !== 'founder') {
      throw new Error(`Founder save requires kind "founder", got "${operator.kind}"`)
    }

    return this.save(operator)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      this.operator = await this.readFromDisk()
      this.loaded = true
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async readFromDisk(): Promise<Operator | null> {
    const rawOperator = await this.readRawOperator()
    if (!rawOperator) {
      return null
    }

    const { operator, rawEmail } = rawOperator
    if (isSyntheticAuth0LocalEmail(rawEmail)) {
      console.warn('operator_store_synthetic_email_migrated', {
        operatorId: operator.id,
        filePath: this.filePath,
      })
      return this.withMutationLock(async () => {
        const fresh = await this.readRawOperator()
        if (fresh && !isSyntheticAuth0LocalEmail(fresh.rawEmail)) {
          return fresh.operator
        }
        await this.writeOperatorToDisk(operator)
        return operator
      })
    }

    return operator
  }

  private async readRawOperator(): Promise<RawOperatorRead | null> {
    let rawFile: string
    try {
      rawFile = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid operator store JSON at "${this.filePath}": ${detail}`)
    }

    const operator = parsePersistedOperator(parsed)
    const rawEmail = isObject(parsed) ? parsed.email : null
    return {
      operator,
      rawEmail: typeof rawEmail === 'string' ? rawEmail.trim() : null,
    }
  }

  private async writeToDisk(): Promise<void> {
    if (!this.operator) {
      throw new Error('Cannot persist operator store without an operator')
    }

    await this.writeOperatorToDisk(this.operator)
  }

  private async writeOperatorToDisk(operator: Operator): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      `${JSON.stringify(withJsonStoreSchema({ ...normalizeOperator(operator) }), null, 2)}\n`,
      'utf8',
    )
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
