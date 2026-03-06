import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface CronTask {
  id: string
  commanderId: string
  schedule: string
  timezone?: string
  instruction: string
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  eventBridgeRuleArn?: string
  agentType?: 'claude' | 'codex'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

interface PersistedCronTaskCollection {
  tasks: CronTask[]
}

export interface CreateCronTaskInput {
  commanderId: string
  schedule: string
  timezone?: string
  instruction: string
  enabled: boolean
  nextRun?: string | null
  eventBridgeRuleArn?: string
  agentType?: 'claude' | 'codex'
  sessionType?: 'stream' | 'pty'
  permissionMode?: string
  workDir?: string
  machine?: string
}

export interface UpdateCronTaskInput {
  schedule?: string
  timezone?: string
  instruction?: string
  enabled?: boolean
  lastRun?: string | null
  nextRun?: string | null
  eventBridgeRuleArn?: string
}

export interface CommanderCronTaskStoreOptions {
  dataDir?: string
  legacyFilePath?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCronTask(value: unknown): value is CronTask {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.commanderId === 'string' &&
    typeof value.schedule === 'string' &&
    (value.timezone === undefined || typeof value.timezone === 'string') &&
    typeof value.instruction === 'string' &&
    typeof value.enabled === 'boolean' &&
    (value.lastRun === null || typeof value.lastRun === 'string') &&
    (value.nextRun === null || typeof value.nextRun === 'string') &&
    (value.eventBridgeRuleArn === undefined || typeof value.eventBridgeRuleArn === 'string') &&
    (value.agentType === undefined || value.agentType === 'claude' || value.agentType === 'codex') &&
    (value.sessionType === undefined || value.sessionType === 'stream' || value.sessionType === 'pty') &&
    (value.permissionMode === undefined || typeof value.permissionMode === 'string') &&
    (value.workDir === undefined || typeof value.workDir === 'string') &&
    (value.machine === undefined || typeof value.machine === 'string')
  )
}

function parseCollection(value: unknown): PersistedCronTaskCollection {
  if (Array.isArray(value)) {
    return {
      tasks: value.filter((item): item is CronTask => isCronTask(item)),
    }
  }

  if (isObject(value) && Array.isArray(value.tasks)) {
    return {
      tasks: value.tasks.filter((item): item is CronTask => isCronTask(item)),
    }
  }

  return { tasks: [] }
}

function defaultCronTaskDataDir(): string {
  return path.resolve(process.cwd(), 'data/commanders')
}

export function defaultCronTaskStorePath(commanderId: string): string {
  return path.resolve(defaultCronTaskDataDir(), commanderId, 'crons.json')
}

function resolveLegacyStorePath(dataDir: string, legacyFilePath?: string): string {
  if (typeof legacyFilePath === 'string' && legacyFilePath.trim().length > 0) {
    return path.resolve(legacyFilePath)
  }
  return path.resolve(dataDir, 'cron-tasks.json')
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    isObject(error) &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  )
}

export class CommanderCronTaskStore {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly dataDir: string
  private readonly legacyFilePath: string
  private legacyMigrationComplete = false
  private legacyMigrationPromise: Promise<void> | null = null

  constructor(options: CommanderCronTaskStoreOptions | string = {}) {
    if (typeof options === 'string') {
      const resolvedLegacyPath = path.resolve(options)
      this.dataDir = path.dirname(resolvedLegacyPath)
      this.legacyFilePath = resolvedLegacyPath
      return
    }

    this.dataDir = path.resolve(options.dataDir ?? defaultCronTaskDataDir())
    this.legacyFilePath = resolveLegacyStorePath(this.dataDir, options.legacyFilePath)
  }

  getCommanderFilePath(commanderId: string): string {
    return this.resolveCommanderFilePath(commanderId)
  }

  async listCommanderIdsWithConfig(): Promise<string[]> {
    await this.mutationQueue
    await this.ensureMigratedFromLegacyFile()
    return this.readCommanderIdsWithConfig()
  }

  async listTasks(): Promise<CronTask[]> {
    await this.mutationQueue
    await this.ensureMigratedFromLegacyFile()
    const commanderIds = await this.readCommanderIdsWithConfig()
    const batches = await Promise.all(
      commanderIds.map((commanderId) => this.readTasksForCommander(commanderId)),
    )
    const tasks = batches.flat()
    return tasks.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listTasksForCommander(commanderId: string): Promise<CronTask[]> {
    await this.mutationQueue
    await this.ensureMigratedFromLegacyFile()
    const tasks = await this.readTasksForCommander(commanderId)
    return tasks.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listEnabledTasks(): Promise<CronTask[]> {
    const tasks = await this.listTasks()
    return tasks.filter((task) => task.enabled)
  }

  async getTask(commanderId: string, taskId: string): Promise<CronTask | null> {
    const tasks = await this.listTasksForCommander(commanderId)
    return tasks.find((task) => task.id === taskId) ?? null
  }

  async createTask(input: CreateCronTaskInput): Promise<CronTask> {
    const nextTask: CronTask = {
      id: randomUUID(),
      commanderId: input.commanderId,
      schedule: input.schedule,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      instruction: input.instruction,
      enabled: input.enabled,
      lastRun: null,
      nextRun: input.nextRun ?? null,
      ...(input.eventBridgeRuleArn ? { eventBridgeRuleArn: input.eventBridgeRuleArn } : {}),
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ...(input.sessionType ? { sessionType: input.sessionType } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.workDir ? { workDir: input.workDir } : {}),
      ...(input.machine ? { machine: input.machine } : {}),
    }

    return this.withMutationLock(async () => {
      await this.ensureMigratedFromLegacyFile()
      const tasks = await this.readTasksForCommander(nextTask.commanderId)
      tasks.push(nextTask)
      await this.writeTasksForCommander(nextTask.commanderId, tasks)
      return nextTask
    })
  }

  async updateTask(
    commanderId: string,
    taskId: string,
    update: UpdateCronTaskInput,
  ): Promise<CronTask | null> {
    return this.withMutationLock(async () => {
      await this.ensureMigratedFromLegacyFile()
      const tasks = await this.readTasksForCommander(commanderId)
      const index = tasks.findIndex((task) => task.id === taskId)
      if (index < 0) {
        return null
      }

      const current = tasks[index]
      if (!current) {
        return null
      }

      const nextTask: CronTask = {
        ...current,
      }
      if (typeof update.schedule === 'string') {
        nextTask.schedule = update.schedule
      }
      if (typeof update.timezone === 'string') {
        nextTask.timezone = update.timezone
      }
      if (typeof update.instruction === 'string') {
        nextTask.instruction = update.instruction
      }
      if (typeof update.enabled === 'boolean') {
        nextTask.enabled = update.enabled
      }
      if (update.lastRun !== undefined) {
        nextTask.lastRun = update.lastRun
      }
      if (update.nextRun !== undefined) {
        nextTask.nextRun = update.nextRun
      }
      if (typeof update.eventBridgeRuleArn === 'string') {
        nextTask.eventBridgeRuleArn = update.eventBridgeRuleArn
      }

      tasks[index] = nextTask
      await this.writeTasksForCommander(commanderId, tasks)
      return nextTask
    })
  }

  async deleteTask(commanderId: string, taskId: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      await this.ensureMigratedFromLegacyFile()
      const tasks = await this.readTasksForCommander(commanderId)
      const next = tasks.filter((task) => task.id !== taskId)
      if (next.length === tasks.length) {
        return false
      }

      await this.writeTasksForCommander(commanderId, next)
      return true
    })
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private resolveCommanderFilePath(commanderId: string): string {
    const safeCommanderId = commanderId.trim()
    if (!safeCommanderId) {
      throw new Error('commanderId must be a non-empty string')
    }

    const resolved = path.resolve(this.dataDir, safeCommanderId, 'crons.json')
    const basePath = this.dataDir.endsWith(path.sep)
      ? this.dataDir
      : `${this.dataDir}${path.sep}`
    if (!resolved.startsWith(basePath)) {
      throw new Error(`Invalid commanderId path: ${commanderId}`)
    }
    return resolved
  }

  private async readCommanderIdsWithConfig(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true })
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }

    const commanderIds: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const taskFilePath = this.resolveCommanderFilePath(entry.name)
      try {
        const fileStat = await stat(taskFilePath)
        if (fileStat.isFile()) {
          commanderIds.push(entry.name)
        }
      } catch (error) {
        if (isNodeErrorWithCode(error, 'ENOENT')) {
          continue
        }
        throw error
      }
    }

    return commanderIds.sort((left, right) => left.localeCompare(right))
  }

  private async ensureMigratedFromLegacyFile(): Promise<void> {
    if (this.legacyMigrationComplete) {
      return
    }

    if (!this.legacyMigrationPromise) {
      this.legacyMigrationPromise = this.migrateFromLegacyStore().then(() => {
        this.legacyMigrationComplete = true
      }).finally(() => {
        this.legacyMigrationPromise = null
      })
    }

    await this.legacyMigrationPromise
  }

  private async migrateFromLegacyStore(): Promise<void> {
    const legacyTasks = await this.readTasksFromFile(this.legacyFilePath)
    if (legacyTasks.length === 0) {
      return
    }

    const tasksByCommander = new Map<string, CronTask[]>()
    for (const task of legacyTasks) {
      const current = tasksByCommander.get(task.commanderId) ?? []
      current.push(task)
      tasksByCommander.set(task.commanderId, current)
    }

    const retainedLegacyTasks: CronTask[] = []
    let migratedAny = false

    for (const [commanderId, tasks] of tasksByCommander.entries()) {
      const commanderPath = this.resolveCommanderFilePath(commanderId)
      let commanderFileExists = false
      try {
        const fileStat = await stat(commanderPath)
        commanderFileExists = fileStat.isFile()
      } catch (error) {
        if (!isNodeErrorWithCode(error, 'ENOENT')) {
          throw error
        }
      }

      if (commanderFileExists) {
        retainedLegacyTasks.push(...tasks)
        continue
      }

      await this.writeTasksForCommander(commanderId, tasks)
      migratedAny = true
    }

    if (!migratedAny) {
      return
    }

    await this.writeTasksToFile(this.legacyFilePath, retainedLegacyTasks)
  }

  private async readTasksForCommander(commanderId: string): Promise<CronTask[]> {
    const tasks = await this.readTasksFromFile(this.resolveCommanderFilePath(commanderId))
    return tasks.filter((task) => task.commanderId === commanderId)
  }

  private async readTasksFromFile(filePath: string): Promise<CronTask[]> {
    let contents: string
    try {
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch {
      return []
    }

    return parseCollection(parsed).tasks
  }

  private async writeTasksForCommander(
    commanderId: string,
    tasks: CronTask[],
  ): Promise<void> {
    const filtered = tasks.filter((task) => task.commanderId === commanderId)
    await this.writeTasksToFile(this.resolveCommanderFilePath(commanderId), filtered)
  }

  private async writeTasksToFile(filePath: string, tasks: CronTask[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    const payload: PersistedCronTaskCollection = { tasks }
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
