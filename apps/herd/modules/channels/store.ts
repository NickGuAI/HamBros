import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveHerdDataDir } from '../data-dir.js'
import {
  withCommanderChildCreation,
} from '../commanders/child-mutation-coordinator.js'
import { resolveCommanderDataDir } from '../commanders/paths.js'
import type {
  CommanderChannelBinding,
  CommanderChannelBindingConfig,
  CommanderChannelProvider,
  SeededChannelProvider,
} from './types.js'

const SEEDED_PROVIDERS: readonly SeededChannelProvider[] = [
  'whatsapp',
  'googlechat',
  'slack',
  'discord',
  'email',
  'telegram',
  'imessage',
  'circle',
  'matrix',
]
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/i

export interface CreateCommanderChannelBindingInput {
  commanderId: string
  provider: CommanderChannelProvider
  accountId: string
  displayName: string
  enabled?: boolean
  config?: CommanderChannelBindingConfig
}

export interface UpdateCommanderChannelBindingInput {
  displayName?: string
  enabled?: boolean
  config?: CommanderChannelBindingConfig
}

export interface CommanderChannelBindingStoreOptions {
  lifecycleScope?: string
}

export class CommanderChannelValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommanderChannelValidationError'
  }
}

export class CommanderChannelBindingConflictError extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'CommanderChannelBindingConflictError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNonEmptyString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new CommanderChannelValidationError(`${field} is required`)
  }
  if (normalized.length > 120) {
    throw new CommanderChannelValidationError(`${field} must be 120 characters or fewer`)
  }
  return normalized
}

function parseProvider(value: unknown): CommanderChannelProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized && PROVIDER_PATTERN.test(normalized)) {
    return normalized as CommanderChannelProvider
  }
  throw new CommanderChannelValidationError(
    `provider must be one of ${SEEDED_PROVIDERS.join(', ')} or another provider id`,
  )
}

function parseEnabled(value: unknown): boolean {
  return value === undefined ? true : value === true
}

function parseConfig(value: unknown): CommanderChannelBindingConfig {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isObject(value)) {
    throw new CommanderChannelValidationError('config must be an object')
  }
  return { ...value } as CommanderChannelBindingConfig
}

function parsePersistedBinding(raw: unknown): CommanderChannelBinding | null {
  if (!isObject(raw)) {
    return null
  }

  try {
    const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
      ? raw.createdAt.trim()
      : new Date().toISOString()
    const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
      ? raw.updatedAt.trim()
      : createdAt

    return {
      id: parseNonEmptyString(raw.id, 'id'),
      commanderId: parseNonEmptyString(raw.commanderId, 'commanderId'),
      provider: parseProvider(raw.provider),
      accountId: parseNonEmptyString(raw.accountId, 'accountId'),
      displayName: parseNonEmptyString(raw.displayName, 'displayName'),
      enabled: raw.enabled === false ? false : true,
      config: parseConfig(raw.config),
      createdAt,
      updatedAt,
    }
  } catch {
    return null
  }
}

export function isPersistedCommanderChannelBindingsValid(raw: unknown): boolean {
  return (
    isObject(raw)
    && Array.isArray(raw.bindings)
    && raw.bindings.every((binding) => parsePersistedBinding(binding) !== null)
  )
}

function cloneBinding(binding: CommanderChannelBinding): CommanderChannelBinding {
  return {
    ...binding,
    config: { ...binding.config },
  }
}

export function defaultCommanderChannelBindingStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHerdDataDir(env), 'channels.json')
}

export class CommanderChannelBindingStore {
  private readonly filePath: string
  private readonly lifecycleScope: string
  private bindingsById: Map<string, CommanderChannelBinding> | null = null
  private loadPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    filePath: string = defaultCommanderChannelBindingStorePath(),
    options: CommanderChannelBindingStoreOptions = {},
  ) {
    this.filePath = path.resolve(filePath)
    this.lifecycleScope = path.resolve(options.lifecycleScope ?? resolveCommanderDataDir())
  }

  async listByCommander(commanderId: string): Promise<CommanderChannelBinding[]> {
    await this.ensureLoaded()
    const normalizedCommanderId = parseNonEmptyString(commanderId, 'commanderId')
    return [...this.bindings().values()]
      .filter((binding) => binding.commanderId === normalizedCommanderId)
      .map((binding) => cloneBinding(binding))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async getByCommanderProviderAccount(input: {
    commanderId: string
    provider: unknown
    accountId: unknown
  }): Promise<CommanderChannelBinding | null> {
    await this.ensureLoaded()
    const commanderId = parseNonEmptyString(input.commanderId, 'commanderId')
    const provider = parseProvider(input.provider)
    const accountId = parseNonEmptyString(input.accountId, 'accountId')
    const binding = [...this.bindings().values()].find((candidate) => (
      candidate.commanderId === commanderId
      && candidate.provider === provider
      && candidate.accountId === accountId
    ))
    return binding ? cloneBinding(binding) : null
  }

  async list(): Promise<CommanderChannelBinding[]> {
    await this.ensureLoaded()
    return [...this.bindings().values()]
      .map((binding) => cloneBinding(binding))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async create(input: CreateCommanderChannelBindingInput): Promise<CommanderChannelBinding> {
    const commanderId = parseNonEmptyString(input.commanderId, 'commanderId')
    return withCommanderChildCreation(commanderId, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        await this.ensureLoaded()
        const now = new Date().toISOString()
        const binding: CommanderChannelBinding = {
          id: randomUUID(),
          commanderId,
          provider: parseProvider(input.provider),
          accountId: parseNonEmptyString(input.accountId, 'accountId'),
          displayName: parseNonEmptyString(input.displayName, 'displayName'),
          enabled: parseEnabled(input.enabled),
          config: parseConfig(input.config),
          createdAt: now,
          updatedAt: now,
        }

        const duplicate = [...this.bindings().values()].find((existing) => (
          existing.commanderId === binding.commanderId
          && existing.provider === binding.provider
          && existing.accountId === binding.accountId
        ))
        if (duplicate) {
          throw new CommanderChannelBindingConflictError(
            `Channel binding already exists for ${binding.commanderId}/${binding.provider}/${binding.accountId}`,
          )
        }

        this.bindings().set(binding.id, cloneBinding(binding))
        await this.writeToDisk()
        return cloneBinding(binding)
      })
    ))
  }

  async update(
    commanderId: string,
    bindingId: string,
    input: UpdateCommanderChannelBindingInput,
  ): Promise<CommanderChannelBinding | null> {
    const normalizedCommanderId = parseNonEmptyString(commanderId, 'commanderId')
    const normalizedBindingId = parseNonEmptyString(bindingId, 'bindingId')
    await this.ensureLoaded()
    const observed = this.bindings().get(normalizedBindingId)
    if (!observed || observed.commanderId !== normalizedCommanderId) {
      return null
    }

    return withCommanderChildCreation(normalizedCommanderId, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        const existing = this.bindings().get(normalizedBindingId)
        if (!existing || existing.commanderId !== normalizedCommanderId) {
          return null
        }

        const next: CommanderChannelBinding = {
          ...existing,
          displayName: input.displayName !== undefined
            ? parseNonEmptyString(input.displayName, 'displayName')
            : existing.displayName,
          enabled: input.enabled !== undefined ? input.enabled === true : existing.enabled,
          config: input.config !== undefined ? parseConfig(input.config) : { ...existing.config },
          updatedAt: new Date().toISOString(),
        }

        this.bindings().set(next.id, cloneBinding(next))
        await this.writeToDisk()
        return cloneBinding(next)
      })
    ))
  }

  async delete(commanderId: string, bindingId: string): Promise<boolean> {
    const normalizedCommanderId = parseNonEmptyString(commanderId, 'commanderId')
    const normalizedBindingId = parseNonEmptyString(bindingId, 'bindingId')
    await this.ensureLoaded()
    const observed = this.bindings().get(normalizedBindingId)
    if (!observed || observed.commanderId !== normalizedCommanderId) {
      return false
    }

    return withCommanderChildCreation(normalizedCommanderId, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        const existing = this.bindings().get(normalizedBindingId)
        if (!existing || existing.commanderId !== normalizedCommanderId) {
          return false
        }

        this.bindings().delete(normalizedBindingId)
        await this.writeToDisk()
        return true
      })
    ))
  }

  async deleteForCommander(commanderId: string): Promise<number> {
    const normalizedCommanderId = parseNonEmptyString(commanderId, 'commanderId')
    await this.ensureLoaded()
    if (![...this.bindings().values()].some((binding) => (
      binding.commanderId === normalizedCommanderId
    ))) {
      return 0
    }

    return withCommanderChildCreation(normalizedCommanderId, this.lifecycleScope, () => (
      this.withMutationLock(async () => {
        const bindingIds = [...this.bindings().values()]
          .filter((binding) => binding.commanderId === normalizedCommanderId)
          .map((binding) => binding.id)
        for (const bindingId of bindingIds) {
          this.bindings().delete(bindingId)
        }
        if (bindingIds.length > 0) {
          await this.writeToDisk()
        }
        return bindingIds.length
      })
    ))
  }

  private bindings(): Map<string, CommanderChannelBinding> {
    if (!this.bindingsById) {
      throw new Error('CommanderChannelBindingStore not loaded')
    }
    return this.bindingsById
  }

  private async ensureLoaded(): Promise<void> {
    if (this.bindingsById) {
      return
    }
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      const bindings = await this.readFromDisk()
      this.bindingsById = new Map(bindings.map((binding) => [binding.id, cloneBinding(binding)]))
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  private async readFromDisk(): Promise<CommanderChannelBinding[]> {
    let rawFile: string
    try {
      rawFile = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawFile) as unknown
    } catch {
      return []
    }

    const candidates = isObject(parsed) && Array.isArray(parsed.bindings) ? parsed.bindings : []
    return candidates
      .map((candidate) => parsePersistedBinding(candidate))
      .filter((binding): binding is CommanderChannelBinding => binding !== null)
  }

  private async writeToDisk(): Promise<void> {
    const bindings = [...this.bindings().values()]
      .map((binding) => cloneBinding(binding))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(
      this.filePath,
      JSON.stringify({ bindings }, null, 2),
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
