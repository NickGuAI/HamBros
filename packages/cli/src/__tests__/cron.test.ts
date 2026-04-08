import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runCronCli } from '../cron.js'

interface BufferWriter {
  writer: { write: (chunk: string) => boolean }
  read: () => string
}

function createBufferWriter(): BufferWriter {
  let buffer = ''
  return {
    writer: {
      write(chunk: string): boolean {
        buffer += chunk
        return true
      },
    },
    read(): string {
      return buffer
    },
  }
}

const config = createHammurabiConfig({
  endpoint: 'https://hammurabi.gehirn.ai',
  apiKey: 'hmrb_test_key',
  agents: ['claude-code'],
  configuredAt: new Date('2026-03-01T00:00:00.000Z'),
})

describe('runCronCli', () => {
  it('lists command-room cron tasks', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: 'task-1',
          name: 'daily-briefing',
          schedule: '27 6 * * *',
          enabled: true,
          agentType: 'claude',
          sessionType: 'stream',
          model: 'claude-opus-4-6',
        },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('daily-briefing')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/command-room/tasks',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('shows memory_compact task types in cron list output', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: 'task-memory',
          name: 'commander-cmdr-memory-compact',
          taskType: 'memory_compact',
          schedule: '0 2 * * *',
          enabled: true,
          agentType: 'claude',
        },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('memory_compact')
  })

  it('adds a command-room cron task with model override', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      [
        'add',
        '--name',
        'daily-briefing',
        '--schedule',
        '27 6 * * *',
        '--timezone',
        'America/New_York',
        '--instruction',
        '/daily-briefing',
        '--model',
        'claude-opus-4-6',
        '--agent',
        'claude',
        '--work-dir',
        '/home/ec2-user/App',
        '--permission-mode',
        'dangerouslySkipPermissions',
        '--session-type',
        'stream',
        '--description',
        'Morning briefing at 6:30 AM ET',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Created cron task ID: task-1')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      name: 'daily-briefing',
      schedule: '27 6 * * *',
      timezone: 'America/New_York',
      instruction: '/daily-briefing',
      model: 'claude-opus-4-6',
      enabled: true,
      agentType: 'claude',
      machine: '',
      workDir: '/home/ec2-user/App',
      permissionMode: 'dangerouslySkipPermissions',
      sessionType: 'stream',
      description: 'Morning briefing at 6:30 AM ET',
    })
  })

  it('updates a task', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      ['update', 'task-1', '--enabled', 'false', '--schedule', '0 7 * * *'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Updated cron task task-1.')

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks/task-1')
    expect(call?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      enabled: false,
      schedule: '0 7 * * *',
    })
  })

  it('deletes a task', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runCronCli(['delete', 'task-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('Deleted cron task task-1.')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/command-room/tasks/task-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('triggers a task manually', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'run-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runCronCli(['trigger', 'task-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('Triggered cron task task-1 (run run-1).')

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks/task-1/trigger')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({})
  })

  it('shows task details and recent runs', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            id: 'task-1',
            name: 'daily-briefing',
            schedule: '27 6 * * *',
            timezone: 'America/New_York',
            enabled: true,
            agentType: 'claude',
            sessionType: 'stream',
            model: 'claude-opus-4-6',
            machine: 'local-machine',
            workDir: '/home/ec2-user/App',
            instruction: '/daily-briefing',
            createdAt: '2026-03-31T06:27:00.000Z',
          },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          {
            id: 'run-1',
            status: 'complete',
            startedAt: '2026-03-31T10:27:00.000Z',
            completedAt: '2026-03-31T10:28:00.000Z',
            costUsd: 0.12,
            sessionId: 'session-1',
            report: 'done',
          },
        ]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['show', 'task-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    const output = stdout.read()
    expect(output).toContain('ID: task-1')
    expect(output).toContain('Task Type: instruction')
    expect(output).toContain('Model: claude-opus-4-6')
    expect(output).toContain('Recent Runs:')
    expect(output).toContain('run-1 status=complete')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks/task-1/runs')
  })
})
