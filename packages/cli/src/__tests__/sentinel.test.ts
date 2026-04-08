import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runSentinelCli } from '../sentinel.js'

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

describe('runSentinelCli', () => {
  it('prints usage when no subcommand is provided', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSentinelCli([], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Usage:')
    expect(stderr.read()).toBe('')
  })

  it('prints usage for an unknown subcommand', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSentinelCli(['unknown'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('hammurabi sentinel create')
  })

  it('lists sentinels as a table', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([
        {
          id: 'sentinel-1',
          parentCommanderId: 'cmd-1',
          name: 'dispute-followup',
          schedule: '0 9 */2 * *',
          status: 'active',
          maxRuns: 15,
        },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSentinelCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('dispute-followup')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/sentinels',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('lists sentinels with --parent filter', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['list', '--parent', 'cmd-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/sentinels?parentCommanderId=cmd-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('handles an empty sentinel list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('No sentinels found.')
  })

  it('creates a sentinel with all supported flags', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'sentinel-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSentinelCli(
      [
        'create',
        '--parent',
        'cmd-1',
        '--name',
        'dispute-followup',
        '--schedule',
        '0 9 */2 * *',
        '--instruction',
        'Follow up on dispute email thread',
        '--skills',
        'gog,write-report',
        '--seed-memory',
        'Dispute about a charge and promised resolution date.',
        '--max-runs',
        '15',
        '--timezone',
        'America/New_York',
        '--agent',
        'claude',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'claude-opus-4-6',
        '--work-dir',
        '/home/ec2-user/App',
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
    expect(stdout.read()).toContain('Created sentinel ID: sentinel-1')

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/sentinels')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })

    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      parentCommanderId: 'cmd-1',
      name: 'dispute-followup',
      schedule: '0 9 */2 * *',
      instruction: 'Follow up on dispute email thread',
      skills: ['gog', 'write-report'],
      seedMemory: 'Dispute about a charge and promised resolution date.',
      maxRuns: 15,
      timezone: 'America/New_York',
      agentType: 'claude',
      permissionMode: 'acceptEdits',
      model: 'claude-opus-4-6',
      workDir: '/home/ec2-user/App',
    })
  })

  it('splits and normalizes --skills into a JSON array', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'sentinel-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(
      [
        'create',
        '--parent',
        'cmd-1',
        '--name',
        'name',
        '--schedule',
        '0 9 * * *',
        '--instruction',
        'instruction',
        '--skills',
        'gog, write-email,',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      },
    )

    expect(exitCode).toBe(0)
    const call = fetchImpl.mock.calls[0]
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toMatchObject({
      skills: ['gog', 'write-email'],
      seedMemory: '',
      agentType: 'claude',
      permissionMode: 'acceptEdits',
      workDir: '/home/ec2-user',
    })
  })

  it('requires --parent, --name, --schedule, and --instruction for create', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(
      [
        'create',
        '--name',
        'dispute-followup',
        '--schedule',
        '0 9 */2 * *',
        '--instruction',
        'Follow up',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Usage:')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns request errors from create', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'invalid cron expression' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stderr = createBufferWriter()

    const exitCode = await runSentinelCli(
      [
        'create',
        '--parent',
        'cmd-1',
        '--name',
        'dispute-followup',
        '--schedule',
        'bad cron',
        '--instruction',
        'Follow up',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Request failed (400): invalid cron expression')
  })

  it('shows sentinel details', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'sentinel-1',
        parentCommanderId: 'cmd-1',
        name: 'dispute-followup',
        schedule: '0 9 */2 * *',
        status: 'active',
        skills: ['gog', 'write-email'],
        maxRuns: 15,
        runCount: 2,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['show', 'sentinel-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    const output = stdout.read()
    expect(output).toContain('ID: sentinel-1')
    expect(output).toContain('Parent Commander: cmd-1')
    expect(output).toContain('Skills: gog, write-email')
  })

  it('pause, resume, and complete patch the sentinel status', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const commands: Array<[string, 'paused' | 'active' | 'completed']> = [
      ['pause', 'paused'],
      ['resume', 'active'],
      ['complete', 'completed'],
    ]

    for (const [command] of commands) {
      const exitCode = await runSentinelCli([command, 'sentinel-1'], {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      })
      expect(exitCode).toBe(0)
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    for (const [index, [, status]] of commands.entries()) {
      const call = fetchImpl.mock.calls[index]
      expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/sentinels/sentinel-1')
      expect(call?.[1]).toMatchObject({ method: 'PATCH' })
      expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({ status })
    }
  })

  it('fires a manual trigger run', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'run-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['trigger', 'sentinel-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('Triggered sentinel sentinel-1 (run run-1).')

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/sentinels/sentinel-1/trigger')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({})
  })

  it('shows run history with action/result/cost table columns', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([
        {
          timestamp: '2026-04-06T13:00:00.000Z',
          action: 'email_followup',
          result: 'sent',
          costUsd: 0.0312,
        },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['history', 'sentinel-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    const output = stdout.read()
    expect(output).toContain('TIMESTAMP')
    expect(output).toContain('ACTION')
    expect(output).toContain('RESULT')
    expect(output).toContain('COST')
    expect(output).toContain('email_followup')
    expect(output).toContain('0.0312')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/sentinels/sentinel-1/history',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('deletes a sentinel', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    const stdout = createBufferWriter()

    const exitCode = await runSentinelCli(['delete', 'sentinel-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('Deleted sentinel sentinel-1.')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/sentinels/sentinel-1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
