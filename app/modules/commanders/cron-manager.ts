import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import cron from 'node-cron'
import { CommanderCronTaskStore, type CronTask } from './cron-store.js'

export class InvalidCronExpressionError extends Error {
  constructor(public readonly expression: string) {
    super(`Invalid cron expression: ${expression}`)
    this.name = 'InvalidCronExpressionError'
  }
}

interface CronScheduledJob {
  stop?: () => void
  destroy?: () => void
  getNextRun?: () => Date | null
}

export interface CronScheduler {
  schedule(
    expression: string,
    task: () => Promise<void> | void,
    options?: { name?: string; timezone?: string },
  ): CronScheduledJob
  validate(expression: string): boolean
}

export interface CronInstructionDispatcher {
  sendInstruction(commanderId: string, instruction: string): Promise<void>
}

interface CommanderCronManagerOptions {
  store?: CommanderCronTaskStore
  scheduler?: CronScheduler
  dispatcher?: CronInstructionDispatcher
  now?: () => Date
}

const FILE_RELOAD_DEBOUNCE_MS = 300
const JOB_KEY_SEPARATOR = '::'

const noopDispatcher: CronInstructionDispatcher = {
  sendInstruction: async () => {},
}

function defaultScheduler(): CronScheduler {
  return {
    schedule(expression, task, options) {
      return cron.schedule(expression, task, {
        name: options?.name,
        timezone: options?.timezone,
      })
    },
    validate(expression) {
      return cron.validate(expression)
    },
  }
}

export class CommanderCronManager {
  private readonly activeJobs = new Map<string, CronScheduledJob>()
  private readonly activeTaskSignatures = new Map<string, string>()
  private readonly fileWatchers = new Map<string, FSWatcher>()
  private readonly watchSetupPromises = new Map<string, Promise<void>>()
  private readonly reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly scheduler: CronScheduler
  private readonly dispatcher: CronInstructionDispatcher
  private readonly now: () => Date
  private readonly store: CommanderCronTaskStore

  constructor(options: CommanderCronManagerOptions = {}) {
    this.store = options.store ?? new CommanderCronTaskStore()
    this.scheduler = options.scheduler ?? defaultScheduler()
    this.dispatcher = options.dispatcher ?? noopDispatcher
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    this.stopAllJobs()
    this.stopAllFileWatchers()

    const allTasks = await this.store.listTasks()
    for (const task of allTasks) {
      if (!task.enabled) {
        continue
      }

      const nextRun = this.registerJob(task)
      await this.store.updateTask(task.commanderId, task.id, { nextRun })
    }

    const commanderIdsWithConfig = await this.store.listCommanderIdsWithConfig()
    const commanderIds = new Set<string>([
      ...commanderIdsWithConfig,
      ...allTasks.map((task) => task.commanderId),
    ])
    for (const commanderId of commanderIds) {
      await this.watchConfigFile(commanderId)
    }
  }

  async listTasks(commanderId: string): Promise<CronTask[]> {
    await this.watchConfigFile(commanderId)
    return this.store.listTasksForCommander(commanderId)
  }

  isCronExpressionValid(expression: string): boolean {
    return this.scheduler.validate(expression)
  }

  async createTask(input: {
    commanderId: string
    schedule: string
    timezone?: string
    instruction: string
    enabled: boolean
    agentType?: 'claude' | 'codex'
    sessionType?: 'stream' | 'pty'
    permissionMode?: string
    workDir?: string
    machine?: string
  }): Promise<CronTask> {
    this.assertValidExpression(input.schedule)

    const created = await this.store.createTask({
      commanderId: input.commanderId,
      schedule: input.schedule,
      timezone: input.timezone,
      instruction: input.instruction,
      enabled: input.enabled,
      nextRun: null,
      agentType: input.agentType,
      sessionType: input.sessionType,
      permissionMode: input.permissionMode,
      workDir: input.workDir,
      machine: input.machine,
    })

    await this.watchConfigFile(created.commanderId)

    if (!created.enabled) {
      return created
    }

    const nextRun = this.registerJob(created)
    const updated = await this.store.updateTask(created.commanderId, created.id, { nextRun })
    return updated ?? created
  }

  async updateTask(
    commanderId: string,
    taskId: string,
    update: {
      schedule?: string
      timezone?: string
      instruction?: string
      enabled?: boolean
    },
  ): Promise<CronTask | null> {
    if (typeof update.schedule === 'string') {
      this.assertValidExpression(update.schedule)
    }

    const updated = await this.store.updateTask(commanderId, taskId, update)
    if (!updated) {
      return null
    }

    await this.watchConfigFile(commanderId)
    this.unregisterJob(commanderId, taskId)

    if (!updated.enabled) {
      const disabledTask = await this.store.updateTask(commanderId, taskId, { nextRun: null })
      return disabledTask ?? updated
    }

    const nextRun = this.registerJob(updated)
    const withNextRun = await this.store.updateTask(commanderId, taskId, { nextRun })
    return withNextRun ?? updated
  }

  async deleteTask(commanderId: string, taskId: string): Promise<boolean> {
    this.unregisterJob(commanderId, taskId)
    const deleted = await this.store.deleteTask(commanderId, taskId)
    if (deleted) {
      await this.watchConfigFile(commanderId)
    }
    return deleted
  }

  async triggerInstruction(commanderId: string, instruction: string): Promise<void> {
    await this.dispatcher.sendInstruction(commanderId, instruction)
  }

  stopAllJobs(): void {
    for (const existing of this.activeJobs.values()) {
      existing.stop?.()
      existing.destroy?.()
    }
    this.activeJobs.clear()
    this.activeTaskSignatures.clear()
  }

  dispose(): void {
    this.stopAllJobs()
    this.stopAllFileWatchers()
  }

  private stopAllFileWatchers(): void {
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer)
    }
    this.reloadTimers.clear()

    for (const watcher of this.fileWatchers.values()) {
      watcher.close()
    }
    this.fileWatchers.clear()
    this.watchSetupPromises.clear()
  }

  private assertValidExpression(expression: string): void {
    if (!this.scheduler.validate(expression)) {
      throw new InvalidCronExpressionError(expression)
    }
  }

  private taskKey(commanderId: string, taskId: string): string {
    return `${commanderId}${JOB_KEY_SEPARATOR}${taskId}`
  }

  private taskSignature(task: CronTask): string {
    return JSON.stringify({
      schedule: task.schedule,
      timezone: task.timezone ?? null,
      instruction: task.instruction,
      enabled: task.enabled,
    })
  }

  private registerJob(task: CronTask): string | null {
    const jobKey = this.taskKey(task.commanderId, task.id)
    this.unregisterJob(task.commanderId, task.id)
    const job = this.scheduler.schedule(
      task.schedule,
      async () => {
        await this.handleTaskTick(task.commanderId, task.id)
      },
      {
        name: `commander-${task.commanderId}-cron-${task.id}`,
        timezone: task.timezone,
      },
    )
    this.activeJobs.set(jobKey, job)
    this.activeTaskSignatures.set(jobKey, this.taskSignature(task))
    return this.resolveNextRunIso(job)
  }

  private unregisterJob(commanderId: string, taskId: string): void {
    const jobKey = this.taskKey(commanderId, taskId)
    const existing = this.activeJobs.get(jobKey)
    if (!existing) {
      return
    }

    existing.stop?.()
    existing.destroy?.()
    this.activeJobs.delete(jobKey)
    this.activeTaskSignatures.delete(jobKey)
  }

  private getActiveTaskIdsForCommander(commanderId: string): string[] {
    const prefix = `${commanderId}${JOB_KEY_SEPARATOR}`
    const taskIds: string[] = []
    for (const key of this.activeJobs.keys()) {
      if (key.startsWith(prefix)) {
        taskIds.push(key.slice(prefix.length))
      }
    }
    return taskIds
  }

  private async watchConfigFile(commanderId: string): Promise<void> {
    if (this.fileWatchers.has(commanderId)) {
      return
    }

    const pending = this.watchSetupPromises.get(commanderId)
    if (pending) {
      await pending
      return
    }

    const setup = this.createFileWatcher(commanderId).finally(() => {
      this.watchSetupPromises.delete(commanderId)
    })
    this.watchSetupPromises.set(commanderId, setup)
    await setup
  }

  private async createFileWatcher(commanderId: string): Promise<void> {
    const configPath = this.store.getCommanderFilePath(commanderId)
    const configDir = path.dirname(configPath)
    const configFileName = path.basename(configPath)
    await mkdir(configDir, { recursive: true })

    const watcher = watch(configDir, { persistent: false }, (_eventType, filename) => {
      const changedName = filename?.toString()
      if (changedName && changedName !== configFileName) {
        return
      }
      this.scheduleReload(commanderId)
    })
    watcher.on('error', (error) => {
      console.error(
        `[commanders] Cron file watch failed for commander ${commanderId}:`,
        error,
      )
      watcher.close()
      this.fileWatchers.delete(commanderId)
    })
    this.fileWatchers.set(commanderId, watcher)
  }

  private scheduleReload(commanderId: string): void {
    const existing = this.reloadTimers.get(commanderId)
    if (existing) {
      clearTimeout(existing)
    }

    const timer = setTimeout(() => {
      this.reloadTimers.delete(commanderId)
      void this.reloadFromFile(commanderId).catch((error) => {
        console.error(
          `[commanders] Failed to reload cron config for commander ${commanderId}:`,
          error,
        )
      })
    }, FILE_RELOAD_DEBOUNCE_MS)
    this.reloadTimers.set(commanderId, timer)
  }

  private async reloadFromFile(commanderId: string): Promise<void> {
    const tasks = await this.store.listTasksForCommander(commanderId)
    const enabledTasks = tasks.filter((task) => task.enabled)
    const enabledTaskById = new Map(enabledTasks.map((task) => [task.id, task]))

    const activeTaskIds = this.getActiveTaskIdsForCommander(commanderId)
    for (const activeTaskId of activeTaskIds) {
      if (!enabledTaskById.has(activeTaskId)) {
        this.unregisterJob(commanderId, activeTaskId)
      }
    }

    for (const task of enabledTasks) {
      const jobKey = this.taskKey(task.commanderId, task.id)
      const nextSignature = this.taskSignature(task)
      const currentSignature = this.activeTaskSignatures.get(jobKey)
      if (currentSignature === nextSignature) {
        continue
      }

      const nextRun = this.registerJob(task)
      await this.store.updateTask(task.commanderId, task.id, { nextRun })
    }

    for (const task of tasks) {
      if (!task.enabled && task.nextRun !== null) {
        await this.store.updateTask(task.commanderId, task.id, { nextRun: null })
      }
    }
  }

  private async handleTaskTick(commanderId: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(commanderId, taskId)
    if (!task?.enabled) {
      return
    }

    await this.dispatcher.sendInstruction(task.commanderId, task.instruction)

    const nowIso = this.now().toISOString()
    const jobKey = this.taskKey(commanderId, taskId)
    const nextRun = this.resolveNextRunIso(this.activeJobs.get(jobKey) ?? null)
    await this.store.updateTask(task.commanderId, task.id, {
      lastRun: nowIso,
      nextRun,
    })
  }

  private resolveNextRunIso(job: CronScheduledJob | null): string | null {
    if (!job?.getNextRun) {
      return null
    }

    const next = job.getNextRun()
    if (!(next instanceof Date) || Number.isNaN(next.getTime())) {
      return null
    }

    return next.toISOString()
  }
}
