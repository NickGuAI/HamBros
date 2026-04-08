import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../src/config.js'
import { runCronCli } from '../src/cron.js'

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

  it('adds a command-room cron task and prints created id', async () => {
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

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/command-room/tasks')
    expect(call?.[1]).toMatchObject({ method: 'POST' })
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
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['delete', 'task-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Deleted cron task task-1.')
  })

  it('returns non-zero when list API request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad commander id' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (400): Bad commander id')
  })

  it('returns non-zero when add API request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid cron expression' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      [
        'add',
        '--name',
        'daily-briefing',
        '--schedule',
        'bad cron',
        '--instruction',
        'broken instruction',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (400): Invalid cron expression')
  })

  it('returns non-zero when delete API request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Cron task not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['delete', 'missing'], {
      fetchImpl,
      readConfig: async () => config,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (404): Cron task not found')
  })
})
