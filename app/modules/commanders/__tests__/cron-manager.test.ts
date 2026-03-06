import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CommanderCronManager,
  InvalidCronExpressionError,
  type CronScheduler,
} from '../cron-manager.js'
import { CommanderCronTaskStore } from '../cron-store.js'

const NOW_ISO = '2026-03-01T10:00:00.000Z'
const NEXT_RUN_ISO = '2026-03-02T02:00:00.000Z'

interface MockJob {
  stop: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  getNextRun: ReturnType<typeof vi.fn>
}

interface ScheduledJobRegistration {
  expression: string
  task: () => Promise<void> | void
  options?: { name?: string; timezone?: string }
  job: MockJob
}

interface MockSchedulerResult {
  scheduler: CronScheduler
  scheduled: ScheduledJobRegistration[]
}

function createMockScheduler(): MockSchedulerResult {
  const scheduled: ScheduledJobRegistration[] = []
  const scheduler: CronScheduler = {
    validate: vi.fn((expression: string) => expression !== 'invalid cron'),
    schedule: vi.fn((expression, task, options) => {
      const job: MockJob = {
        stop: vi.fn(),
        destroy: vi.fn(),
        getNextRun: vi.fn(() => new Date(NEXT_RUN_ISO)),
      }
      scheduled.push({ expression, task, options, job })
      return job
    }),
  }

  return {
    scheduler,
    scheduled,
  }
}

describe('CommanderCronManager', () => {
  let tmpDir: string
  let store: CommanderCronTaskStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-cron-manager-test-'))
    store = new CommanderCronTaskStore(join(tmpDir, 'cron-tasks.json'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a task and schedules it immediately when enabled', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const dispatcher = { sendInstruction: vi.fn(async () => {}) }
    const manager = new CommanderCronManager({
      store,
      scheduler,
      dispatcher,
      now: () => new Date(NOW_ISO),
    })

    const created = await manager.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      timezone: 'America/Los_Angeles',
      instruction: 'run nightly test suite',
      enabled: true,
    })

    expect(created.commanderId).toBe('cmdr-1')
    expect(created.enabled).toBe(true)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.expression).toBe('0 2 * * *')
    expect(scheduled[0]?.options?.timezone).toBe('America/Los_Angeles')

    const tasks = await manager.listTasks('cmdr-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.nextRun).toBe(NEXT_RUN_ISO)
  })

  it('pauses a task when updated with enabled: false without deleting it', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const manager = new CommanderCronManager({
      store,
      scheduler,
      now: () => new Date(NOW_ISO),
    })

    const created = await manager.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
    })

    const firstJob = scheduled[0]?.job
    const updated = await manager.updateTask('cmdr-1', created.id, {
      enabled: false,
    })

    expect(updated).not.toBeNull()
    expect(updated?.enabled).toBe(false)
    expect(updated?.nextRun).toBeNull()
    expect(firstJob?.stop).toHaveBeenCalledTimes(1)
    expect(firstJob?.destroy).toHaveBeenCalledTimes(1)

    const tasks = await manager.listTasks('cmdr-1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe(created.id)
    expect(tasks[0]?.enabled).toBe(false)
  })

  it('deletes a task and unregisters its active job', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const manager = new CommanderCronManager({
      store,
      scheduler,
      now: () => new Date(NOW_ISO),
    })

    const created = await manager.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
    })
    const firstJob = scheduled[0]?.job

    const deleted = await manager.deleteTask('cmdr-1', created.id)

    expect(deleted).toBe(true)
    expect(firstJob?.stop).toHaveBeenCalledTimes(1)
    expect(firstJob?.destroy).toHaveBeenCalledTimes(1)
    expect(await manager.listTasks('cmdr-1')).toEqual([])
  })

  it('re-registers enabled tasks from store on initialize', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const manager = new CommanderCronManager({
      store,
      scheduler,
      now: () => new Date(NOW_ISO),
    })

    const enabled = await store.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'enabled task',
      enabled: true,
      nextRun: null,
    })
    await store.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 5 * * *',
      instruction: 'disabled task',
      enabled: false,
      nextRun: null,
    })

    await manager.initialize()

    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.expression).toBe('0 2 * * *')

    const tasks = await manager.listTasks('cmdr-1')
    const enabledTask = tasks.find((task) => task.id === enabled.id)
    expect(enabledTask?.nextRun).toBe(NEXT_RUN_ISO)
  })

  it('updates lastRun after a cron tick fires', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const dispatcher = { sendInstruction: vi.fn(async () => {}) }
    const manager = new CommanderCronManager({
      store,
      scheduler,
      dispatcher,
      now: () => new Date(NOW_ISO),
    })

    const created = await manager.createTask({
      commanderId: 'cmdr-1',
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
    })
    const task = scheduled[0]?.task
    if (!task) {
      throw new Error('Expected scheduled cron callback')
    }

    await task()

    expect(dispatcher.sendInstruction).toHaveBeenCalledWith(
      'cmdr-1',
      'run nightly test suite',
    )

    const tasks = await manager.listTasks('cmdr-1')
    const updated = tasks.find((item) => item.id === created.id)
    expect(updated?.lastRun).toBe(NOW_ISO)
    expect(updated?.nextRun).toBe(NEXT_RUN_ISO)
  })

  it('rejects invalid cron expressions with InvalidCronExpressionError', async () => {
    const { scheduler } = createMockScheduler()
    const manager = new CommanderCronManager({
      store,
      scheduler,
      now: () => new Date(NOW_ISO),
    })

    await expect(
      manager.createTask({
        commanderId: 'cmdr-1',
        schedule: 'invalid cron',
        instruction: 'run nightly test suite',
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(InvalidCronExpressionError)
  })
})
