import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveHerdDataDir } from '../data-dir.js'
import type { OrgIdentity } from './types.js'

const DEFAULT_ORG_NAME = 'Organization'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneOrgIdentity(identity: OrgIdentity): OrgIdentity {
  return { ...identity }
}

export class OrgIdentityValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgIdentityValidationError'
  }
}

export function normalizeOrgName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OrgIdentityValidationError('name must be a string')
  }

  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 80) {
    throw new OrgIdentityValidationError('name must be between 1 and 80 characters')
  }

  if (/[\u0000-\u001f\u007f<>]/.test(normalized)) {
    throw new OrgIdentityValidationError('name contains unsupported characters')
  }

  return normalized
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized.length > 0 ? normalized : fallback
}

function parsePersistedOrgIdentity(raw: unknown): OrgIdentity {
  if (!isObject(raw)) {
    throw new Error('Org identity store must contain a JSON object')
  }

  const now = new Date().toISOString()
  return {
    name: normalizeOrgName(raw.name),
    createdAt: normalizeTimestamp(raw.createdAt, now),
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
  }
}

export function isPersistedOrgIdentityValid(raw: unknown): boolean {
  try {
    parsePersistedOrgIdentity(raw)
    return true
  } catch {
    return false
  }
}

function createDefaultOrgIdentity(): OrgIdentity {
  const now = new Date().toISOString()
  return {
    name: DEFAULT_ORG_NAME,
    createdAt: now,
    updatedAt: now,
  }
}

export function defaultOrgIdentityStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHerdDataDir(env), 'org.json')
}

export class OrgIdentityStore {
  private readonly filePath: string
  private identity: OrgIdentity | null = null
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string = defaultOrgIdentityStorePath()) {
    this.filePath = path.resolve(filePath)
  }

  async get(): Promise<OrgIdentity> {
    await this.ensureLoaded()
    return cloneOrgIdentity(this.identity ?? createDefaultOrgIdentity())
  }

  async updateName(name: string): Promise<OrgIdentity> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded()
      const current = this.identity ?? createDefaultOrgIdentity()
      const updatedAt = new Date().toISOString()
      const next: OrgIdentity = {
        ...current,
        name: normalizeOrgName(name),
        updatedAt,
      }

      this.identity = cloneOrgIdentity(next)
      await this.writeIdentityToDisk(next)
      return cloneOrgIdentity(next)
    })
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
      const persisted = await this.readFromDisk()
      this.identity = persisted ?? createDefaultOrgIdentity()
      if (!persisted) {
        await this.writeIdentityToDisk(this.identity)
      }
      this.loaded = true
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async readFromDisk(): Promise<OrgIdentity | null> {
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
      throw new Error(`Invalid org identity JSON at "${this.filePath}": ${detail}`)
    }

    return parsePersistedOrgIdentity(parsed)
  }

  private async writeIdentityToDisk(identity: OrgIdentity): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      JSON.stringify(cloneOrgIdentity(identity), null, 2),
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
