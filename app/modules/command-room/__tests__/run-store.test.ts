import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRoomRunStore } from '../run-store.js'
import { CommandRoomTaskStore } from '../task-store.js'

describe('CommandRoomRunStore', () => {
  let tmpDir = ''
  let store: CommandRoomRunStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'command-room-run-store-'))
    store = new CommandRoomRunStore(join(tmpDir, 'runs.json'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates runs and filters by task id', async () => {
    const first = await store.createRun({
      cronTaskId: 'task-1',
      startedAt: '2026-03-01T01:00:00.000Z',
      completedAt: '2026-03-01T01:02:00.000Z',
      status: 'complete',
      report: 'Finished',
      costUsd: 0.12,
      sessionId: 'session-1',
    })

    await store.createRun({
      cronTaskId: 'task-2',
      startedAt: '2026-03-01T01:10:00.000Z',
      completedAt: '2026-03-01T01:11:00.000Z',
      status: 'failed',
      report: 'Failure',
      costUsd: 0,
      sessionId: 'session-2',
    })

    const taskRuns = await store.listRunsForTask('task-1')
    expect(taskRuns).toHaveLength(1)
    expect(taskRuns[0]?.id).toBe(first.id)

    const latestByTask = await store.listLatestRunsByTaskIds(['task-1', 'task-2'])
    expect(latestByTask.get('task-1')?.id).toBe(first.id)
    expect(latestByTask.get('task-2')?.status).toBe('failed')
  })

  it('routes commander-owned run records using task ownership lookup', async () => {
    const commanderDataDir = join(tmpDir, 'commanders')
    const taskStore = new CommandRoomTaskStore({
      filePath: join(tmpDir, 'legacy-tasks.json'),
      commanderDataDir,
    })
    const runStore = new CommandRoomRunStore({
      filePath: join(tmpDir, 'legacy-runs.json'),
      commanderDataDir,
      taskStore,
    })

    const commanderTask = await taskStore.createTask({
      name: 'Commander task',
      schedule: '0 2 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run commander task',
      enabled: true,
      commanderId: 'commander-run',
    })

    const run = await runStore.createRun({
      cronTaskId: commanderTask.id,
      startedAt: '2026-03-02T01:00:00.000Z',
      completedAt: '2026-03-02T01:01:00.000Z',
      status: 'complete',
      report: 'done',
      costUsd: 0,
      sessionId: 'session-9',
    })

    const commanderRunsPath = join(
      commanderDataDir,
      'commander-run',
      '.memory',
      'cron',
      'runs.json',
    )
    const commanderRuns = JSON.parse(await readFile(commanderRunsPath, 'utf8')) as {
      runs?: Array<{ id: string }>
    }

    expect(commanderRuns.runs?.map((entry) => entry.id)).toEqual([run.id])
  })
})
