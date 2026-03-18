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
  it('lists cron tasks in a table', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'cron-1',
            schedule: '*/5 * * * *',
            enabled: true,
            agentType: 'claude',
            sessionType: 'stream',
            nextRun: '2026-03-09T20:00:00.000Z',
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['list', '--commander', 'cmdr-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('| ID')
    expect(stdout.read()).toContain('cron-1')
    expect(stdout.read()).toContain('*/5 * * * *')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/crons',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('adds a cron task and prints created id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cron-42',
          commanderId: 'cmdr-1',
          schedule: '0 * * * *',
          instruction: 'Hourly health check',
          enabled: false,
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      [
        'add',
        '--commander',
        'cmdr-1',
        '--schedule',
        '0 * * * *',
        '--instruction',
        'Hourly health check',
        '--name',
        'hourly-health',
        '--agent',
        'codex',
        '--session-type',
        'pty',
        '--permission-mode',
        'bypassPermissions',
        '--work-dir',
        '/tmp/worktrees/hourly-health',
        '--machine',
        'ops-1',
        '--disabled',
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
    expect(stdout.read()).toContain('Created cron task ID: cron-42')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/crons')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      schedule: '0 * * * *',
      instruction: 'Hourly health check',
      enabled: false,
      name: 'hourly-health',
      agentType: 'codex',
      sessionType: 'pty',
      permissionMode: 'bypassPermissions',
      workDir: '/tmp/worktrees/hourly-health',
      machine: 'ops-1',
    })
  })

  it('deletes a cron task and prints confirmation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['delete', '--commander', 'cmdr-1', 'cron-9'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Deleted cron task cron-9.')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/crons/cron-9',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('returns non-zero when cron list API request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad commander id' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['list', '--commander', 'bad-id'], {
      fetchImpl,
      readConfig: async () => config,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (400): Bad commander id')
  })

  it('returns non-zero when cron add API request fails', async () => {
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
        '--commander',
        'cmdr-1',
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

  it('returns non-zero when cron delete API request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Cron task not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['delete', '--commander', 'cmdr-1', 'missing'], {
      fetchImpl,
      readConfig: async () => config,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (404): Cron task not found')
  })
})
