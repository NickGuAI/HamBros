import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRoomTaskStore } from '../task-store.js'

describe('CommandRoomTaskStore', () => {
  let tmpDir = ''
  let store: CommandRoomTaskStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'command-room-task-store-'))
    store = new CommandRoomTaskStore(join(tmpDir, 'tasks.json'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates, updates, and deletes cron tasks', async () => {
    const created = await store.createTask({
      name: 'Nightly review',
      schedule: '0 1 * * *',
      timezone: 'America/Los_Angeles',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Summarize open issues.',
      enabled: true,
    })

    expect(created.id).toBeTruthy()
    expect(created.name).toBe('Nightly review')
    expect(created.agentType).toBe('claude')
    expect(created.timezone).toBe('America/Los_Angeles')
    expect(created.createdAt).toBeTruthy()

    const listed = await store.listTasks()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)

    const updated = await store.updateTask(created.id, {
      name: 'Nightly triage',
      schedule: '0 2 * * *',
      timezone: 'America/New_York',
      enabled: false,
      agentType: 'codex',
    })
    expect(updated).not.toBeNull()
    expect(updated?.name).toBe('Nightly triage')
    expect(updated?.schedule).toBe('0 2 * * *')
    expect(updated?.timezone).toBe('America/New_York')
    expect(updated?.enabled).toBe(false)
    expect(updated?.agentType).toBe('codex')

    const enabled = await store.listEnabledTasks()
    expect(enabled).toEqual([])

    const deleted = await store.deleteTask(created.id)
    expect(deleted).toBe(true)
    expect(await store.listTasks()).toEqual([])
  })

  it('filters tasks by commanderId and preserves unfiltered backward compatibility', async () => {
    const cmdrX = await store.createTask({
      name: 'Commander X task',
      schedule: '0 1 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run X task.',
      enabled: true,
      commanderId: 'x',
    })
    const cmdrY = await store.createTask({
      name: 'Commander Y task',
      schedule: '0 2 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run Y task.',
      enabled: true,
      commanderId: 'y',
    })
    const shared = await store.createTask({
      name: 'Shared task',
      schedule: '0 3 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run shared task.',
      enabled: true,
    })

    const onlyX = await store.listTasks({ commanderId: 'x' })
    expect(onlyX.map((task) => task.id)).toEqual([cmdrX.id])

    const all = await store.listTasks()
    expect(all.map((task) => task.id).sort()).toEqual([cmdrX.id, cmdrY.id, shared.id].sort())
  })

  it('routes commander-owned tasks into commander durability paths when configured', async () => {
    const commanderDataDir = join(tmpDir, 'commanders')
    const routedStore = new CommandRoomTaskStore({
      filePath: join(tmpDir, 'legacy-tasks.json'),
      commanderDataDir,
    })

    const commanderTask = await routedStore.createTask({
      name: 'Commander owned',
      schedule: '0 4 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run commander task.',
      enabled: true,
      commanderId: 'commander-z',
    })

    const sharedTask = await routedStore.createTask({
      name: 'Shared',
      schedule: '0 5 * * *',
      machine: 'workstation-1',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run shared task.',
      enabled: true,
    })

    const commanderTasksPath = join(
      commanderDataDir,
      'commander-z',
      '.memory',
      'cron',
      'tasks.json',
    )
    const legacyTasksPath = join(tmpDir, 'legacy-tasks.json')

    const commanderPayload = JSON.parse(await readFile(commanderTasksPath, 'utf8')) as {
      tasks?: Array<{ id: string }>
    }
    const legacyPayload = JSON.parse(await readFile(legacyTasksPath, 'utf8')) as {
      tasks?: Array<{ id: string }>
    }

    expect(commanderPayload.tasks?.map((task) => task.id)).toEqual([commanderTask.id])
    expect(legacyPayload.tasks?.map((task) => task.id)).toEqual([sharedTask.id])
  })
})
