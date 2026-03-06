import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TASK_STORE_PATH = 'data/command-room/tasks.json'

export type CommandRoomAgentType = 'claude' | 'codex'

export interface CronTask {
  id: string
  name: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  createdAt: string
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

interface PersistedTaskCollection {
  tasks: CronTask[]
}

export interface CreateCronTaskInput {
  name: string
  schedule: string
  timezone?: string
  machine: string
  workDir: string
  agentType: CommandRoomAgentType
  instruction: string
  enabled: boolean
  permissionMode?: string
  sessionType?: 'stream' | 'pty'
}

export interface UpdateCronTaskInput {
  name?: string
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
    typeof value.schedule === 'string' &&
    (value.timezone === undefined || typeof value.timezone === 'string') &&
    typeof value.machine === 'string' &&
    typeof value.workDir === 'string' &&
    AGENT_TYPES.has(value.agentType as CommandRoomAgentType) &&
    typeof value.instruction === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.createdAt === 'string'
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

export class CommandRoomTaskStore {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(filePath: string = defaultCommandRoomTaskStorePath()) {
    this.filePath = path.resolve(filePath)
  }

  async listTasks(): Promise<CronTask[]> {
    await this.mutationQueue
    const tasks = await this.readTasks()
    return tasks.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
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
    const nextTask: CronTask = {
      id: randomUUID(),
      name: input.name,
      schedule: input.schedule,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      machine: input.machine,
      workDir: input.workDir,
      agentType: input.agentType,
      instruction: input.instruction,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.sessionType ? { sessionType: input.sessionType } : {}),
    }

    return this.withMutationLock(async () => {
      const tasks = await this.readTasks()
      tasks.push(nextTask)
      await this.writeTasks(tasks)
      return nextTask
    })
  }

  async updateTask(taskId: string, update: UpdateCronTaskInput): Promise<CronTask | null> {
    return this.withMutationLock(async () => {
      const tasks = await this.readTasks()
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

      tasks[index] = nextTask
      await this.writeTasks(tasks)
      return nextTask
    })
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const tasks = await this.readTasks()
      const nextTasks = tasks.filter((task) => task.id !== taskId)
      if (nextTasks.length === tasks.length) {
        return false
      }

      await this.writeTasks(nextTasks)
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

  private async readTasks(): Promise<CronTask[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
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

  private async writeTasks(tasks: CronTask[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: PersistedTaskCollection = { tasks }
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
