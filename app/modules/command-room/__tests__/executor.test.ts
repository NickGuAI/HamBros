import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRoomExecutor } from '../executor.js'
import { CommandRoomRunStore } from '../run-store.js'
import { CommandRoomTaskStore } from '../task-store.js'

describe('CommandRoomExecutor', () => {
  let tmpDir = ''
  let taskStore: CommandRoomTaskStore
  let runStore: CommandRoomRunStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'command-room-executor-'))
    taskStore = new CommandRoomTaskStore(join(tmpDir, 'tasks.json'))
    runStore = new CommandRoomRunStore(join(tmpDir, 'runs.json'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a session, monitors completion, and stores run output', async () => {
    const task = await taskStore.createTask({
      name: 'Daily summary',
      schedule: '0 1 * * *',
      machine: 'local-machine',
      workDir: '/tmp/example-repo',
      agentType: 'codex',
      instruction: 'Summarize today.',
      enabled: true,
    })

    const createSession = vi.fn(async () => ({ sessionId: 'session-123' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'session-123',
      status: 'SUCCESS' as const,
      finalComment: 'Workflow completed.',
      filesChanged: 0,
      durationMin: 1.2,
      raw: { total_cost_usd: 0.42 },
    }))

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      now: () => new Date('2026-03-02T01:00:00.000Z'),
      agentSessionFactory: () => ({
        createSession,
        monitorSession,
      }),
    })

    const run = await executor.executeTask(task.id, 'manual')
    if (!run) {
      throw new Error('Expected workflow run to be created')
    }

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      task: 'Summarize today.',
      agentType: 'codex',
      cwd: '/tmp/example-repo',
      host: 'local-machine',
    })
    expect(monitorSession).toHaveBeenCalledWith('session-123', undefined)

    expect(run.status).toBe('complete')
    expect(run.sessionId).toBe('session-123')
    expect(run.report).toContain('Workflow completed.')
    expect(run.costUsd).toBe(0.42)

    const persisted = await runStore.listRunsForTask(task.id)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe('complete')
  })
})
