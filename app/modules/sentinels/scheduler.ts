import cron from 'node-cron'
import { resolveCommanderPaths } from '../commanders/paths.js'
import { resolveSkill } from './skills.js'
import { SentinelExecutor, type SentinelExecutionResult } from './executor.js'
import { SentinelStore } from './store.js'
import type {
  CreateSentinelInput,
  Sentinel,
  SentinelStatus,
  UpdateSentinelInput,
} from './types.js'

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

interface CommanderLookupStore {
  get(commanderId: string): Promise<unknown | null>
}

export interface SentinelSchedulerOptions {
  store?: SentinelStore
  scheduler?: CronScheduler
  executor?: SentinelExecutor
  commanderStore?: CommanderLookupStore
}

export class InvalidSentinelCronExpressionError extends Error {
  constructor(public readonly expression: string) {
    super(`Invalid cron expression: ${expression}`)
    this.name = 'InvalidSentinelCronExpressionError'
  }
}

export class ParentCommanderNotFoundError extends Error {
  constructor(public readonly commanderId: string) {
    super(`Parent commander ${commanderId} not found`)
    this.name = 'ParentCommanderNotFoundError'
  }
}

export class MissingSentinelSkillError extends Error {
  constructor(public readonly skillName: string) {
    super(`Skill "${skillName}" not found`)
    this.name = 'MissingSentinelSkillError'
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

function canBeScheduled(status: SentinelStatus): boolean {
  return status === 'active'
}

export class SentinelScheduler {
  private readonly store: SentinelStore
  private readonly scheduler: CronScheduler
  private readonly executor: SentinelExecutor
  private readonly commanderStore?: CommanderLookupStore
  private readonly activeJobs = new Map<string, CronScheduledJob>()

  constructor(options: SentinelSchedulerOptions = {}) {
    this.store = options.store ?? new SentinelStore()
    this.scheduler = options.scheduler ?? defaultScheduler()
    this.executor = options.executor ?? new SentinelExecutor({ store: this.store })
    this.commanderStore = options.commanderStore
  }

  async initialize(): Promise<void> {
    this.stopAllJobs()
    const sentinels = await this.store.list()
    for (const sentinel of sentinels) {
      if (canBeScheduled(sentinel.status)) {
        this.registerJob(sentinel)
      }
    }
  }

  async listSentinels(filter: { parentCommanderId?: string; status?: SentinelStatus } = {}): Promise<Sentinel[]> {
    return this.store.list(filter)
  }

  async getSentinel(sentinelId: string): Promise<Sentinel | null> {
    return this.store.get(sentinelId)
  }

  isCronExpressionValid(expression: string): boolean {
    return this.scheduler.validate(expression)
  }

  async createSentinel(input: CreateSentinelInput): Promise<Sentinel> {
    this.assertValidExpression(input.schedule)
    await this.assertParentCommanderExists(input.parentCommanderId)
    await this.assertSkillsExist(input.skills ?? [], input.parentCommanderId)

    const created = await this.store.create(input)
    if (canBeScheduled(created.status)) {
      this.registerJob(created)
    }
    return created
  }

  async updateSentinel(sentinelId: string, patch: UpdateSentinelInput): Promise<Sentinel | null> {
    if (patch.schedule !== undefined) {
      this.assertValidExpression(patch.schedule)
    }
    if (patch.skills) {
      const existing = await this.store.get(sentinelId)
      await this.assertSkillsExist(patch.skills, existing?.parentCommanderId)
    }

    const updated = await this.store.update(sentinelId, patch)
    if (!updated) {
      return null
    }

    this.unregisterJob(sentinelId)
    if (canBeScheduled(updated.status)) {
      this.registerJob(updated)
    }

    return updated
  }

  async pauseSentinel(sentinelId: string): Promise<Sentinel | null> {
    return this.updateSentinel(sentinelId, { status: 'paused' })
  }

  async resumeSentinel(sentinelId: string): Promise<Sentinel | null> {
    return this.updateSentinel(sentinelId, { status: 'active' })
  }

  async completeSentinel(sentinelId: string): Promise<Sentinel | null> {
    return this.updateSentinel(sentinelId, { status: 'completed' })
  }

  async cancelSentinel(sentinelId: string): Promise<Sentinel | null> {
    return this.updateSentinel(sentinelId, { status: 'cancelled' })
  }

  async deleteSentinel(sentinelId: string): Promise<boolean> {
    this.unregisterJob(sentinelId)
    return this.store.delete(sentinelId, { removeFiles: true })
  }

  async triggerSentinel(
    sentinelId: string,
  ): Promise<SentinelExecutionResult | null> {
    return this.executor.executeSentinel(sentinelId, 'manual')
  }

  getNextRun(sentinelId: string): Date | null {
    const nextRun = this.activeJobs.get(sentinelId)?.getNextRun?.()
    if (!(nextRun instanceof Date) || Number.isNaN(nextRun.getTime())) {
      return null
    }
    return nextRun
  }

  stopAllJobs(): void {
    for (const [sentinelId] of this.activeJobs) {
      this.unregisterJob(sentinelId)
    }
  }

  private assertValidExpression(expression: string): void {
    if (!this.scheduler.validate(expression)) {
      throw new InvalidSentinelCronExpressionError(expression)
    }
  }

  private async assertParentCommanderExists(parentCommanderId: string): Promise<void> {
    if (!this.commanderStore) {
      return
    }

    const commander = await this.commanderStore.get(parentCommanderId)
    if (!commander) {
      throw new ParentCommanderNotFoundError(parentCommanderId)
    }
  }

  private async assertSkillsExist(skills: readonly string[], parentCommanderId?: string): Promise<void> {
    const commanderSkillsDir = parentCommanderId
      ? resolveCommanderPaths(parentCommanderId).skillsRoot
      : undefined
    for (const skillName of skills) {
      const resolved = await resolveSkill(skillName, commanderSkillsDir)
      if (!resolved) {
        throw new MissingSentinelSkillError(skillName)
      }
    }
  }

  private registerJob(sentinel: Sentinel): void {
    this.unregisterJob(sentinel.id)

    const job = this.scheduler.schedule(
      sentinel.schedule,
      async () => {
        await this.handleTick(sentinel.id)
      },
      {
        name: `sentinel-${sentinel.id}`,
        timezone: sentinel.timezone,
      },
    )

    this.activeJobs.set(sentinel.id, job)
  }

  private unregisterJob(sentinelId: string): void {
    const existing = this.activeJobs.get(sentinelId)
    if (!existing) {
      return
    }

    existing.stop?.()
    existing.destroy?.()
    this.activeJobs.delete(sentinelId)
  }

  private async handleTick(sentinelId: string): Promise<void> {
    const sentinel = await this.store.get(sentinelId)
    if (!sentinel || !canBeScheduled(sentinel.status)) {
      this.unregisterJob(sentinelId)
      return
    }

    if (sentinel.maxRuns && sentinel.totalRuns >= sentinel.maxRuns) {
      await this.completeSentinel(sentinel.id)
      return
    }

    try {
      const result = await this.executor.executeSentinel(sentinel.id, 'cron')
      if (!result) {
        return
      }

      if (!canBeScheduled(result.sentinel.status)) {
        this.unregisterJob(sentinel.id)
      }
    } catch (error) {
      console.error('[sentinel] Scheduled run failed:', error)
    }
  }
}
