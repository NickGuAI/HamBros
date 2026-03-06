import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CommanderCronManager,
  type CronScheduler,
} from '../cron-manager.js'
import { CommanderCronTaskStore, type CronTask } from '../cron-store.js'

const NEXT_RUN_ISO = '2026-03-02T02:00:00.000Z'

interface MockJob {
  stop: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  getNextRun: ReturnType<typeof vi.fn>
}

interface ScheduledRegistration {
  expression: string
  task: () => Promise<void> | void
  options?: { name?: string; timezone?: string }
  job: MockJob
}

function createMockScheduler(): {
  scheduler: CronScheduler
  scheduled: ScheduledRegistration[]
} {
  const scheduled: ScheduledRegistration[] = []
  const scheduler: CronScheduler = {
    validate: vi.fn(() => true),
    schedule: vi.fn((expression, task, options) => {
      const job: MockJob = {
        stop: vi.fn(),
        destroy: vi.fn(),
        getNextRun: vi.fn(() => new Date(NEXT_RUN_ISO)),
      }
      scheduled.push({
        expression,
        task,
        options,
        job,
      })
      return job
    }),
  }

  return { scheduler, scheduled }
}

async function writeCommanderTasks(
  store: CommanderCronTaskStore,
  commanderId: string,
  tasks: CronTask[],
): Promise<void> {
  const filePath = store.getCommanderFilePath(commanderId)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf8')
}

describe('CommanderCronManager file watch reload', () => {
  let tmpDir: string
  let store: CommanderCronTaskStore
  let manager: CommanderCronManager | null = null

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-cron-watch-test-'))
    store = new CommanderCronTaskStore({ dataDir: tmpDir })
  })

  afterEach(async () => {
    manager?.dispose()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('registers a newly added task from direct file edits', async () => {
    const commanderId = 'cmdr-watch-1'
    const { scheduler, scheduled } = createMockScheduler()
    manager = new CommanderCronManager({
      store,
      scheduler,
    })

    await writeCommanderTasks(store, commanderId, [])
    await manager.initialize()
    expect(scheduled).toHaveLength(0)

    const task: CronTask = {
      id: 'task-a',
      commanderId,
      schedule: '0 2 * * *',
      instruction: 'run nightly test suite',
      enabled: true,
      lastRun: null,
      nextRun: null,
    }
    await writeCommanderTasks(store, commanderId, [task])

    await vi.waitFor(() => {
      expect(scheduled).toHaveLength(1)
    }, { timeout: 4_000 })
    expect(scheduled[0]?.expression).toBe('0 2 * * *')
  })

  it('re-registers an active job when file edits change schedule', async () => {
    const commanderId = 'cmdr-watch-2'
    const { scheduler, scheduled } = createMockScheduler()
    manager = new CommanderCronManager({
      store,
      scheduler,
    })

    const initialTask: CronTask = {
      id: 'task-b',
      commanderId,
      schedule: '0 2 * * *',
      instruction: 'run report',
      enabled: true,
      lastRun: null,
      nextRun: null,
    }
    await writeCommanderTasks(store, commanderId, [initialTask])
    await manager.initialize()
    expect(scheduled).toHaveLength(1)
    const initialJob = scheduled[0]?.job

    await writeCommanderTasks(store, commanderId, [
      {
        ...initialTask,
        schedule: '0 3 * * *',
      },
    ])

    await vi.waitFor(() => {
      expect(scheduled).toHaveLength(2)
      expect(initialJob?.stop).toHaveBeenCalledTimes(1)
      expect(initialJob?.destroy).toHaveBeenCalledTimes(1)
    }, { timeout: 4_000 })
    expect(scheduled[1]?.expression).toBe('0 3 * * *')
  })

  it('stops an active job when its task is removed from file', async () => {
    const commanderId = 'cmdr-watch-3'
    const { scheduler, scheduled } = createMockScheduler()
    manager = new CommanderCronManager({
      store,
      scheduler,
    })

    const initialTask: CronTask = {
      id: 'task-c',
      commanderId,
      schedule: '0 2 * * *',
      instruction: 'run cleanup',
      enabled: true,
      lastRun: null,
      nextRun: null,
    }
    await writeCommanderTasks(store, commanderId, [initialTask])
    await manager.initialize()
    expect(scheduled).toHaveLength(1)
    const initialJob = scheduled[0]?.job

    await writeCommanderTasks(store, commanderId, [])

    await vi.waitFor(() => {
      expect(initialJob?.stop).toHaveBeenCalledTimes(1)
      expect(initialJob?.destroy).toHaveBeenCalledTimes(1)
    }, { timeout: 4_000 })
  })
})
