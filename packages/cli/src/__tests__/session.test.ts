import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runSessionCli } from '../session.js'

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

describe('runSessionCli', () => {
  it('prints usage when no subcommand given', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli([], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Usage:')
    expect(stdout.read()).toContain('hammurabi session register')
  })

  it('prints usage on --help', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(['--help'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('Usage:')
  })

  it('register requires --name', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(['register', '--machine', 'laptop'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('--name is required')
  })

  it('register requires --machine', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(['register', '--name', 'my-session'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('--machine is required')
  })

  it('registers an external session', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          registered: true,
          name: 'my-session',
          agentType: 'claude',
          machine: 'my-laptop',
          cwd: '/home/user/project',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['register', '--name', 'my-session', '--machine', 'my-laptop', '--cwd', '/home/user/project'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Registered session "my-session" from my-laptop')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          name: 'my-session',
          machine: 'my-laptop',
          cwd: '/home/user/project',
        }),
      }),
    )
  })

  it('handles register conflict', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Session "my-session" already exists' }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['register', '--name', 'my-session', '--machine', 'laptop'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Register failed (409)')
    expect(stderr.read()).toContain('already exists')
  })

  it('sends a heartbeat', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, status: 'connected' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['heartbeat', '--name', 'my-session'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Heartbeat sent for "my-session"')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/my-session/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('pushes events', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: 2 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const events = JSON.stringify([
      { type: 'assistant', message: { role: 'assistant' } },
      { type: 'result', subtype: 'success' },
    ])

    const exitCode = await runSessionCli(
      ['events', '--name', 'my-session', '--events', events],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Pushed 2 event(s) to "my-session"')
  })

  it('unregisters a session', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ killed: true }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['unregister', '--name', 'my-session'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Session "my-session" unregistered')
  })

  it('fails when not configured', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(['register', '--name', 'x', '--machine', 'y'], {
      readConfig: async () => null,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Not configured')
  })

  it('rejects unknown subcommand', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(['bogus'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Unknown session subcommand: bogus')
  })

  it('events requires valid JSON', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['events', '--name', 'my-session', '--events', 'not-json'],
      {
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('must be valid JSON')
  })

  it('events requires JSON array', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runSessionCli(
      ['events', '--name', 'my-session', '--events', '{"type":"foo"}'],
      {
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('must be a JSON array')
  })
})
