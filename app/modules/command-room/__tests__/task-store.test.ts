import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
})
