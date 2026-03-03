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
    options?: { name?: string },
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

const noopDispatcher: CronInstructionDispatcher = {
  sendInstruction: async () => {},
}

function defaultScheduler(): CronScheduler {
  return {
    schedule(expression, task, options) {
      return cron.schedule(expression, task, {
        name: options?.name,
      })
    },
    validate(expression) {
      return cron.validate(expression)
    },
  }
}

export class CommanderCronManager {
  private readonly activeJobs = new Map<string, CronScheduledJob>()
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
    const tasks = await this.store.listEnabledTasks()
    for (const task of tasks) {
      const nextRun = this.registerJob(task)
      await this.store.updateTask(task.commanderId, task.id, { nextRun })
    }
  }

  async listTasks(commanderId: string): Promise<CronTask[]> {
    return this.store.listTasksForCommander(commanderId)
  }

  isCronExpressionValid(expression: string): boolean {
    return this.scheduler.validate(expression)
  }

  async createTask(input: {
    commanderId: string
    schedule: string
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
      instruction: input.instruction,
      enabled: input.enabled,
      nextRun: null,
      agentType: input.agentType,
      sessionType: input.sessionType,
      permissionMode: input.permissionMode,
      workDir: input.workDir,
      machine: input.machine,
    })

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

    this.unregisterJob(taskId)

    if (!updated.enabled) {
      const disabledTask = await this.store.updateTask(commanderId, taskId, { nextRun: null })
      return disabledTask ?? updated
    }

    const nextRun = this.registerJob(updated)
    const withNextRun = await this.store.updateTask(commanderId, taskId, { nextRun })
    return withNextRun ?? updated
  }

  async deleteTask(commanderId: string, taskId: string): Promise<boolean> {
    this.unregisterJob(taskId)
    return this.store.deleteTask(commanderId, taskId)
  }

  async triggerInstruction(commanderId: string, instruction: string): Promise<void> {
    await this.dispatcher.sendInstruction(commanderId, instruction)
  }

  stopAllJobs(): void {
    for (const [taskId] of this.activeJobs) {
      this.unregisterJob(taskId)
    }
  }

  private assertValidExpression(expression: string): void {
    if (!this.scheduler.validate(expression)) {
      throw new InvalidCronExpressionError(expression)
    }
  }

  private registerJob(task: CronTask): string | null {
    this.unregisterJob(task.id)
    const job = this.scheduler.schedule(
      task.schedule,
      async () => {
        await this.handleTaskTick(task.commanderId, task.id)
      },
      {
        name: `commander-${task.commanderId}-cron-${task.id}`,
      },
    )
    this.activeJobs.set(task.id, job)
    return this.resolveNextRunIso(job)
  }

  private unregisterJob(taskId: string): void {
    const existing = this.activeJobs.get(taskId)
    if (!existing) {
      return
    }

    existing.stop?.()
    existing.destroy?.()
    this.activeJobs.delete(taskId)
  }

  private async handleTaskTick(commanderId: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(commanderId, taskId)
    if (!task?.enabled) {
      return
    }

    await this.dispatcher.sendInstruction(task.commanderId, task.instruction)

    const nowIso = this.now().toISOString()
    const nextRun = this.resolveNextRunIso(this.activeJobs.get(taskId) ?? null)
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
