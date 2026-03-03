import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface CronTask {
  id: string
  commanderId: string
  schedule: string
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
  instruction?: string
  enabled?: boolean
  lastRun?: string | null
  nextRun?: string | null
  eventBridgeRuleArn?: string
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

export function defaultCronTaskStorePath(): string {
  return path.resolve(process.cwd(), 'data/commanders/cron-tasks.json')
}

export class CommanderCronTaskStore {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string = defaultCronTaskStorePath()) {}

  async listTasks(): Promise<CronTask[]> {
    await this.mutationQueue
    const tasks = await this.readTasks()
    return tasks.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listTasksForCommander(commanderId: string): Promise<CronTask[]> {
    const tasks = await this.listTasks()
    return tasks.filter((task) => task.commanderId === commanderId)
  }

  async listEnabledTasks(): Promise<CronTask[]> {
    const tasks = await this.listTasks()
    return tasks.filter((task) => task.enabled)
  }

  async getTask(commanderId: string, taskId: string): Promise<CronTask | null> {
    const tasks = await this.listTasks()
    return tasks.find((task) => task.commanderId === commanderId && task.id === taskId) ?? null
  }

  async createTask(input: CreateCronTaskInput): Promise<CronTask> {
    const nextTask: CronTask = {
      id: randomUUID(),
      commanderId: input.commanderId,
      schedule: input.schedule,
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
      const tasks = await this.readTasks()
      tasks.push(nextTask)
      await this.writeTasks(tasks)
      return nextTask
    })
  }

  async updateTask(
    commanderId: string,
    taskId: string,
    update: UpdateCronTaskInput,
  ): Promise<CronTask | null> {
    return this.withMutationLock(async () => {
      const tasks = await this.readTasks()
      const index = tasks.findIndex(
        (task) => task.commanderId === commanderId && task.id === taskId,
      )
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
      await this.writeTasks(tasks)
      return nextTask
    })
  }

  async deleteTask(commanderId: string, taskId: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      const tasks = await this.readTasks()
      const next = tasks.filter(
        (task) => !(task.commanderId === commanderId && task.id === taskId),
      )
      if (next.length === tasks.length) {
        return false
      }

      await this.writeTasks(next)
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

    return parseCollection(parsed).tasks
  }

  private async writeTasks(tasks: CronTask[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const payload: PersistedCronTaskCollection = { tasks }
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}
