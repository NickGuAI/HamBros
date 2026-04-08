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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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

  it('kills command-room session after monitorSession completion', async () => {
    const task = await taskStore.createTask({
      name: 'One-shot stream cleanup',
      schedule: '0 1 * * *',
      machine: 'local-machine',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run one-shot command',
      enabled: true,
      sessionType: 'stream',
    })

    const createSession = vi.fn(async () => ({ sessionId: 'session-cleanup-1' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'session-cleanup-1',
      status: 'SUCCESS' as const,
      finalComment: 'Cleanup done.',
      filesChanged: 0,
      durationMin: 0.5,
      raw: { total_cost_usd: 0.01 },
    }))
    const killSession = vi.fn(async () => undefined)

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      now: () => new Date('2026-03-02T01:00:00.000Z'),
      agentSessionFactory: () => ({
        createSession,
        monitorSession,
        killSession,
      }),
    })

    const run = await executor.executeTask(task.id, 'manual')
    expect(run?.status).toBe('complete')
    expect(monitorSession).toHaveBeenCalledWith('session-cleanup-1', undefined)
    expect(killSession).toHaveBeenCalledTimes(1)
    expect(killSession).toHaveBeenCalledWith('session-cleanup-1')
  })

  it('retries kill cleanup in finally when first kill attempt fails', async () => {
    const task = await taskStore.createTask({
      name: 'One-shot stream cleanup retry',
      schedule: '0 1 * * *',
      machine: 'local-machine',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: 'Run one-shot command',
      enabled: true,
      sessionType: 'stream',
    })

    const createSession = vi.fn(async () => ({ sessionId: 'session-cleanup-2' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'session-cleanup-2',
      status: 'SUCCESS' as const,
      finalComment: 'Cleanup done.',
      filesChanged: 0,
      durationMin: 0.5,
      raw: {},
    }))
    const killSession = vi
      .fn(async (_sessionId: string) => undefined)
      .mockRejectedValueOnce(new Error('temporary cleanup error'))
      .mockResolvedValueOnce(undefined)

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      now: () => new Date('2026-03-02T01:00:00.000Z'),
      agentSessionFactory: () => ({
        createSession,
        monitorSession,
        killSession,
      }),
    })

    const run = await executor.executeTask(task.id, 'manual')
    expect(run?.status).toBe('complete')
    expect(killSession).toHaveBeenCalledTimes(2)
    expect(killSession).toHaveBeenNthCalledWith(1, 'session-cleanup-2')
    expect(killSession).toHaveBeenNthCalledWith(2, 'session-cleanup-2')
  })

  it('passes configured monitor options to agent session monitoring', async () => {
    const task = await taskStore.createTask({
      name: 'Daily review',
      schedule: '0 1 * * *',
      machine: 'local-machine',
      workDir: '/tmp/example-repo',
      agentType: 'claude',
      instruction: '/daily-review',
      enabled: true,
    })

    const createSession = vi.fn(async () => ({ sessionId: 'session-456' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'session-456',
      status: 'SUCCESS' as const,
      finalComment: 'Completed after a long run.',
      filesChanged: 0,
      durationMin: 12,
      raw: { total_cost_usd: 0.64 },
    }))

    const monitorOptions = {
      pollIntervalMs: 2_000,
      maxPollAttempts: 1_350,
    }

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      monitorOptions,
      agentSessionFactory: () => ({
        createSession,
        monitorSession,
      }),
    })

    const run = await executor.executeTask(task.id, 'manual')
    if (!run) {
      throw new Error('Expected workflow run to be created')
    }

    expect(run.status).toBe('complete')
    expect(monitorSession).toHaveBeenCalledWith('session-456', monitorOptions)
  })

  it('executes memory_compact tasks via internal API instead of agent session creation', async () => {
    const task = await taskStore.createTask({
      name: 'Commander memory compact',
      schedule: '0 2 * * *',
      machine: '',
      workDir: '',
      agentType: 'claude',
      instruction: 'Run internal commander memory compaction maintenance.',
      taskType: 'memory_compact',
      enabled: true,
      commanderId: 'cmdr-memory-1',
    })

    const createSession = vi.fn(async () => ({ sessionId: 'unused' }))
    const monitorSession = vi.fn(async () => ({
      sessionId: 'unused',
      status: 'SUCCESS' as const,
      finalComment: 'unused',
      filesChanged: 0,
      durationMin: 0,
      raw: {},
    }))
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        factsExtracted: 4,
        memoryMdLineCount: 22,
        debrifsProcessed: 1,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      now: () => new Date('2026-03-12T02:00:00.000Z'),
      internalToken: 'internal-token',
      fetchImpl,
      agentSessionFactory: () => ({
        createSession,
        monitorSession,
      }),
    })

    const run = await executor.executeTask(task.id, 'cron')
    if (!run) {
      throw new Error('Expected workflow run to be created')
    }

    expect(createSession).not.toHaveBeenCalled()
    expect(monitorSession).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/api\/commanders\/cmdr-memory-1\/memory\/compact$/)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-hammurabi-internal-token': 'internal-token',
      }),
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? '{}'))).toEqual({
      source: 'cron',
      targetDate: '2026-03-11',
    })
    expect(run.status).toBe('complete')
    expect(run.report).toContain('targetDate=2026-03-11')
  })

  it('records skipped memory_compact runs when commander session is active', async () => {
    const task = await taskStore.createTask({
      name: 'Commander memory compact',
      schedule: '0 2 * * *',
      machine: '',
      workDir: '',
      agentType: 'claude',
      instruction: 'Run internal commander memory compaction maintenance.',
      taskType: 'memory_compact',
      enabled: true,
      commanderId: 'cmdr-memory-2',
    })

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        skipped: true,
        reason: 'commander_running',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const executor = new CommandRoomExecutor({
      taskStore,
      runStore,
      now: () => new Date('2026-03-12T02:00:00.000Z'),
      fetchImpl,
      internalToken: 'internal-token',
    })

    const run = await executor.executeTask(task.id, 'cron')
    expect(run?.status).toBe('complete')
    expect(run?.report).toContain('Memory compaction skipped')
    const persisted = await runStore.listRunsForTask(task.id)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe('complete')
  })

  it('does not warn when internalToken is provided', () => {
    const previousInternalApiKey = process.env.HAMBROS_INTERNAL_API_KEY
    const previousApiKey = process.env.HAMBROS_API_KEY
    delete process.env.HAMBROS_INTERNAL_API_KEY
    delete process.env.HAMBROS_API_KEY

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      new CommandRoomExecutor({
        taskStore,
        runStore,
        internalToken: 'auto-generated-token',
      })

      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      if (previousInternalApiKey === undefined) {
        delete process.env.HAMBROS_INTERNAL_API_KEY
      } else {
        process.env.HAMBROS_INTERNAL_API_KEY = previousInternalApiKey
      }

      if (previousApiKey === undefined) {
        delete process.env.HAMBROS_API_KEY
      } else {
        process.env.HAMBROS_API_KEY = previousApiKey
      }
    }
  })

  it('warns at startup when no internal API key is configured', () => {
    const previousInternalApiKey = process.env.HAMBROS_INTERNAL_API_KEY
    const previousApiKey = process.env.HAMBROS_API_KEY
    delete process.env.HAMBROS_INTERNAL_API_KEY
    delete process.env.HAMBROS_API_KEY

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      new CommandRoomExecutor({
        taskStore,
        runStore,
      })

      expect(warnSpy).toHaveBeenCalledWith(
        '[command-room] WARNING: No internal token or HAMBROS_INTERNAL_API_KEY set - cron triggers may fail',
      )
    } finally {
      warnSpy.mockRestore()
      if (previousInternalApiKey === undefined) {
        delete process.env.HAMBROS_INTERNAL_API_KEY
      } else {
        process.env.HAMBROS_INTERNAL_API_KEY = previousInternalApiKey
      }

      if (previousApiKey === undefined) {
        delete process.env.HAMBROS_API_KEY
      } else {
        process.env.HAMBROS_API_KEY = previousApiKey
      }
    }
  })
})
