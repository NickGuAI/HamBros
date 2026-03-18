import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveCommanderDataDir } from '../commanders/paths.js'

const DEFAULT_TASK_STORE_PATH = 'data/command-room/tasks.json'

export type CommandRoomAgentType = 'claude' | 'codex'

export interface CronTask {
  id: string
  name: string
  description?: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  createdAt: string
  commanderId?: string
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

interface PersistedTaskCollection {
  tasks: CronTask[]
}

export interface CreateCronTaskInput {
  name: string
  description?: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  commanderId?: string
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

export interface UpdateCronTaskInput {
  name?: string
  description?: string
  schedule?: string
  timezone?: string
  machine?: string
  workDir?: string
  agentType?: CommandRoomAgentType
  instruction?: string
  enabled?: boolean
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

export interface CommandRoomTaskStoreOptions {
  filePath?: string
  commanderDataDir?: string | null
}

interface TaskLocation {
  task: CronTask
  filePath: string
}

const AGENT_TYPES = new Set<CommandRoomAgentType>(['claude', 'codex'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asAgentType(value: unknown): CommandRoomAgentType | null {
  if (value === 'claude' || value === 'codex') {
    return value
  }
  return null
}

function isCronTask(value: unknown): value is CronTask {
  if (!isObject(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.schedule === 'string' &&
    (value.timezone === undefined || typeof value.timezone === 'string') &&
    typeof value.machine === 'string' &&
    typeof value.workDir === 'string' &&
    AGENT_TYPES.has(value.agentType as CommandRoomAgentType) &&
    typeof value.instruction === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.createdAt === 'string' &&
    (value.commanderId === undefined || typeof value.commanderId === 'string')
  )
}

function parseTaskCollection(raw: unknown): PersistedTaskCollection {
  if (Array.isArray(raw)) {
    return {
      tasks: raw.filter((entry): entry is CronTask => isCronTask(entry)),
    }
  }

  if (isObject(raw) && Array.isArray(raw.tasks)) {
    return {
      tasks: raw.tasks.filter((entry): entry is CronTask => isCronTask(entry)),
    }
  }

  return { tasks: [] }
}

export function defaultCommandRoomTaskStorePath(): string {
  return path.resolve(process.cwd(), DEFAULT_TASK_STORE_PATH)
}

function resolveCommanderCronTasksPath(commanderDataDir: string, commanderId: string): string {
  return path.join(path.resolve(commanderDataDir), commanderId, '.memory', 'cron', 'tasks.json')
}

export class CommandRoomTaskStore {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly filePath: string
  private readonly commanderDataDir: string | null

  constructor(config: string | CommandRoomTaskStoreOptions = {}) {
    if (typeof config === 'string') {
      this.filePath = path.resolve(config)
      this.commanderDataDir = null
      return
    }

    this.filePath = path.resolve(config.filePath ?? defaultCommandRoomTaskStorePath())
    const commanderDataDir = config.commanderDataDir === null
      ? null
      : path.resolve(config.commanderDataDir ?? resolveCommanderDataDir())
    this.commanderDataDir = commanderDataDir
  }

  async listTasks(filter: { commanderId?: string } = {}): Promise<CronTask[]> {
    await this.mutationQueue
    const locations = await this.readTaskLocations()
    const tasks = [...locations.values()].map((entry) => entry.task)
    const sorted = tasks.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
    const commanderId = asTrimmedString(filter.commanderId)
    if (!commanderId) {
      return sorted
    }
    return sorted.filter((task) => task.commanderId === commanderId)
  }

  async listEnabledTasks(): Promise<CronTask[]> {
    const tasks = await this.listTasks()
    return tasks.filter((task) => task.enabled)
  }

  async getTask(taskId: string): Promise<CronTask | null> {
    const tasks = await this.listTasks()
    return tasks.find((task) => task.id === taskId) ?? null
  }

  async createTask(input: CreateCronTaskInput): Promise<CronTask> {
    const commanderId = asTrimmedString(input.commanderId)
    const description = asTrimmedString(input.description)
    const nextTask: CronTask = {
      id: randomUUID(),
      name: input.name,
      ...(description ? { description } : {}),
      schedule: input.schedule,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      machine: input.machine,
      workDir: input.workDir,
      agentType: input.agentType,
      instruction: input.instruction,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      ...(commanderId ? { commanderId } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.sessionType ? { sessionType: input.sessionType } : {}),
    }

    return this.withMutationLock(async () => {
      const targetPath = this.resolveCreatePath(commanderId)
      const tasks = await this.readTasksFromFile(targetPath)
      tasks.push(nextTask)
      await this.writeTasksToFile(targetPath, tasks)
      return nextTask
    })
  }

  async updateTask(taskId: string, update: UpdateCronTaskInput): Promise<CronTask | null> {
    return this.withMutationLock(async () => {
      const location = (await this.readTaskLocations()).get(taskId)
      if (!location) {
        return null
      }
      const tasks = await this.readTasksFromFile(location.filePath)
      const index = tasks.findIndex((task) => task.id === taskId)
      if (index < 0) {
        return null
      }

      const current = tasks[index]
      if (!current) {
        return null
      }

      const nextTask: CronTask = { ...current }
      const name = asTrimmedString(update.name)
      if (name) {
        nextTask.name = name
      }
      if (Object.prototype.hasOwnProperty.call(update, 'description')) {
        const description = asTrimmedString(update.description)
        if (description) {
          nextTask.description = description
        } else {
          delete nextTask.description
        }
      }
      const schedule = asTrimmedString(update.schedule)
      if (schedule) {
        nextTask.schedule = schedule
      }
      const timezone = asTrimmedString(update.timezone)
      if (timezone) {
        nextTask.timezone = timezone
      }
      const machine = asTrimmedString(update.machine)
      if (machine) {
        nextTask.machine = machine
      }
      const workDir = asTrimmedString(update.workDir)
      if (workDir) {
        nextTask.workDir = workDir
      }
      const agentType = asAgentType(update.agentType)
      if (agentType) {
        nextTask.agentType = agentType
      }
      const instruction = asTrimmedString(update.instruction)
      if (instruction) {
        nextTask.instruction = instruction
      }
      if (typeof update.enabled === 'boolean') {
        nextTask.enabled = update.enabled
      }
      if (Object.prototype.hasOwnProperty.call(update, 'permissionMode')) {
        const permissionMode = asTrimmedString(update.permissionMode)
        if (permissionMode) {
          nextTask.permissionMode = permissionMode
        } else {
          delete nextTask.permissionMode
        }
      }
      if (Object.prototype.hasOwnProperty.call(update, 'sessionType')) {
        if (update.sessionType === 'pty' || update.sessionType === 'stream') {
          nextTask.sessionType = update.sessionType
        } else {
          delete nextTask.sessionType
        }
      }

      tasks[index] = nextTask
      await this.writeTasksToFile(location.filePath, tasks)
      return nextTask
    })
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const location = (await this.readTaskLocations()).get(taskId)
      if (!location) {
        return false
      }
      const tasks = await this.readTasksFromFile(location.filePath)
      const nextTasks = tasks.filter((task) => task.id !== taskId)
      if (nextTasks.length === tasks.length) {
        return false
      }

      await this.writeTasksToFile(location.filePath, nextTasks)
      return true
    })
  }

  async deleteTaskEverywhere(taskId: string, commanderId?: string): Promise<number> {
    return this.withMutationLock(async () => {
      let deletedCount = 0

      for (const sourcePath of await this.listTaskSourcePaths()) {
        const tasks = await this.readTasksFromFile(sourcePath)
        const nextTasks = tasks.filter((task) => {
          const matchesCommander = commanderId === undefined || task.commanderId === commanderId
          const shouldDelete = task.id === taskId && matchesCommander
          if (shouldDelete) {
            deletedCount += 1
          }
          return !shouldDelete
        })

        if (nextTasks.length !== tasks.length) {
          await this.writeTasksToFile(sourcePath, nextTasks)
        }
      }

      return deletedCount
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

  private resolveCreatePath(commanderId: string | null): string {
    if (commanderId && this.commanderDataDir) {
      return resolveCommanderCronTasksPath(this.commanderDataDir, commanderId)
    }
    return this.filePath
  }

  private async readTaskLocations(): Promise<Map<string, TaskLocation>> {
    const locations = new Map<string, TaskLocation>()
    for (const sourcePath of await this.listTaskSourcePaths()) {
      const tasks = await this.readTasksFromFile(sourcePath)
      for (const task of tasks) {
        // Commander-owned entries override legacy global copies when IDs collide.
        locations.set(task.id, {
          task,
          filePath: sourcePath,
        })
      }
    }
    return locations
  }

  private async listTaskSourcePaths(): Promise<string[]> {
    const sourcePaths = [this.filePath]
    if (!this.commanderDataDir) {
      return sourcePaths
    }

    const commanderIds = await this.listCommanderIds()
    for (const commanderId of commanderIds) {
      sourcePaths.push(resolveCommanderCronTasksPath(this.commanderDataDir, commanderId))
    }
    return sourcePaths
  }

  private async listCommanderIds(): Promise<string[]> {
    if (!this.commanderDataDir) {
      return []
    }

    try {
      const entries = await readdir(this.commanderDataDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch (error) {
      if (
        isObject(error) &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code === 'ENOENT'
      ) {
        return []
      }
      throw error
    }
  }

  private async readTasksFromFile(filePath: string): Promise<CronTask[]> {
    let contents: string
    try {
      contents = await readFile(filePath, 'utf8')
    } catch (error) {
      if (
        isObject(error) &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code === 'ENOENT'
      ) {
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

    return parseTaskCollection(parsed).tasks
  }

  private async writeTasksToFile(filePath: string, tasks: CronTask[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    const payload: PersistedTaskCollection = { tasks }
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
