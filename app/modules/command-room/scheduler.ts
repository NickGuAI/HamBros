import cron from 'node-cron'
import type { WorkflowRun } from './run-store.js'
import { CommandRoomTaskStore, type CronTask, type CreateCronTaskInput, type UpdateCronTaskInput } from './task-store.js'
import type { WorkflowTriggerSource } from './executor.js'

interface CronScheduledJob {
  stop?: () => void
  destroy?: () => void
}

export interface CronScheduler {
  schedule(
    expression: string,
    task: () => Promise<void> | void,
    options?: { name?: string; timezone?: string },
  ): CronScheduledJob
  validate(expression: string): boolean
}

export interface CommandRoomTaskExecutor {
  executeTask(taskId: string, source: WorkflowTriggerSource): Promise<WorkflowRun | null>
}

interface CommandRoomSchedulerOptions {
  taskStore?: CommandRoomTaskStore
  scheduler?: CronScheduler
  executor?: CommandRoomTaskExecutor
}

const noopExecutor: CommandRoomTaskExecutor = {
  executeTask: async () => null,
}

export class InvalidCronExpressionError extends Error {
  constructor(public readonly expression: string) {
    super(`Invalid cron expression: ${expression}`)
    this.name = 'InvalidCronExpressionError'
  }
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

export class CommandRoomScheduler {
  private readonly store: CommandRoomTaskStore
  private readonly scheduler: CronScheduler
  private readonly executor: CommandRoomTaskExecutor
  private readonly activeJobs = new Map<string, CronScheduledJob>()

  constructor(options: CommandRoomSchedulerOptions = {}) {
    this.store = options.taskStore ?? new CommandRoomTaskStore()
    this.scheduler = options.scheduler ?? defaultScheduler()
    this.executor = options.executor ?? noopExecutor
  }

  async initialize(): Promise<void> {
    this.stopAllJobs()
    const tasks = await this.store.listEnabledTasks()
    for (const task of tasks) {
      this.registerJob(task)
    }
  }

  async listTasks(): Promise<CronTask[]> {
    return this.store.listTasks()
  }

  async getTask(taskId: string): Promise<CronTask | null> {
    return this.store.getTask(taskId)
  }

  isCronExpressionValid(expression: string): boolean {
    return this.scheduler.validate(expression)
  }

  async createTask(input: CreateCronTaskInput): Promise<CronTask> {
    this.assertValidExpression(input.schedule)
    const created = await this.store.createTask(input)
    if (created.enabled) {
      this.registerJob(created)
    }
    return created
  }

  async updateTask(taskId: string, update: UpdateCronTaskInput): Promise<CronTask | null> {
    if (typeof update.schedule === 'string') {
      this.assertValidExpression(update.schedule)
    }

    const updated = await this.store.updateTask(taskId, update)
    if (!updated) {
      return null
    }

    this.unregisterJob(taskId)
    if (updated.enabled) {
      this.registerJob(updated)
    }
    return updated
  }

  async deleteTask(taskId: string): Promise<boolean> {
    this.unregisterJob(taskId)
    return this.store.deleteTask(taskId)
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

  private registerJob(task: CronTask): void {
    this.unregisterJob(task.id)
    const job = this.scheduler.schedule(
      task.schedule,
      async () => {
        await this.handleTaskTick(task.id)
      },
      {
        name: `command-room-${task.id}`,
        timezone: task.timezone,
      },
    )
    this.activeJobs.set(task.id, job)
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

  private async handleTaskTick(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId)
    if (!task?.enabled) {
      return
    }

    try {
      await this.executor.executeTask(taskId, 'cron')
    } catch (error) {
      console.error('[command-room] Cron task execution failed:', error)
    }
  }
}
