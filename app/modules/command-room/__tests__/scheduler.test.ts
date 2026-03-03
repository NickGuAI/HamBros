import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRoomScheduler, type CronScheduler } from '../scheduler.js'
import { CommandRoomTaskStore } from '../task-store.js'

interface MockJob {
  stop: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

interface ScheduledRegistration {
  expression: string
  task: () => Promise<void> | void
  job: MockJob
}

function createMockScheduler(): { scheduler: CronScheduler; scheduled: ScheduledRegistration[] } {
  const scheduled: ScheduledRegistration[] = []
  const scheduler: CronScheduler = {
    validate: vi.fn((expression: string) => expression !== 'invalid cron'),
    schedule: vi.fn((expression, task) => {
      const job: MockJob = {
        stop: vi.fn(),
        destroy: vi.fn(),
      }
      scheduled.push({ expression, task, job })
      return job
    }),
  }
  return { scheduler, scheduled }
}

describe('CommandRoomScheduler', () => {
  let tmpDir = ''
  let store: CommandRoomTaskStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'command-room-scheduler-'))
    store = new CommandRoomTaskStore(join(tmpDir, 'tasks.json'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('registers enabled tasks and executes task executor when cron fires', async () => {
    const { scheduler, scheduled } = createMockScheduler()
    const executor = { executeTask: vi.fn(async () => null) }
    const manager = new CommandRoomScheduler({
      taskStore: store,
      scheduler,
      executor,
    })

    const created = await manager.createTask({
      name: 'Nightly run',
      schedule: '0 1 * * *',
      machine: 'local',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run nightly report',
      enabled: true,
    })

    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.expression).toBe('0 1 * * *')

    const callback = scheduled[0]?.task
    if (!callback) {
      throw new Error('Expected scheduled callback to exist')
    }
    await callback()

    expect(executor.executeTask).toHaveBeenCalledWith(created.id, 'cron')
  })
})
