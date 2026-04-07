import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runWorkersCli } from '../workers.js'

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

describe('runWorkersCli', () => {
  it('lists active factory stream sessions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'factory-feat-1', sessionType: 'stream', cwd: '/tmp/.factory/repo/worktree-a' },
          { name: 'factory-feat-2', sessionType: 'pty' },
          { name: 'dev-session', sessionType: 'stream' },
          { name: 'factory-feat-3', sessionType: 'stream', host: 'mac-mini' },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Active factory workers:')
    expect(stdout.read()).toContain('- factory-feat-1 cwd=/tmp/.factory/repo/worktree-a')
    expect(stdout.read()).toContain('- factory-feat-3 host=mac-mini')
    expect(stdout.read()).not.toContain('factory-feat-2')
    expect(stdout.read()).not.toContain('dev-session')
  })

  it('dispatches a worker via dispatch-worker endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'factory-feat-123',
          branch: 'feat-123',
          worktree: '/tmp/.factory/NickGuAI/monorepo-g/worktrees/feat-123',
        }),
        {
          status: 202,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(
      [
        'dispatch',
        '--session',
        'commander-main',
        '--issue',
        'https://github.com/NickGuAI/monorepo-g/issues/123',
        '--task',
        'Handle edge cases',
        '--machine',
        'gpu-1',
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
    expect(stdout.read()).toContain('Worker dispatched: factory-feat-123')
    expect(stdout.read()).toContain('Branch: feat-123')
    expect(stdout.read()).toContain('Worktree: /tmp/.factory/NickGuAI/monorepo-g/worktrees/feat-123')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/dispatch-worker',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          parentSession: 'commander-main',
          issueUrl: 'https://github.com/NickGuAI/monorepo-g/issues/123',
          task: 'Handle edge cases',
          machine: 'gpu-1',
        }),
      }),
    )

    const dispatchCall = fetchImpl.mock.calls[0]
    const dispatchInit = dispatchCall?.[1]
    const dispatchBody =
      dispatchInit && typeof dispatchInit === 'object' && 'body' in dispatchInit
        ? dispatchInit.body
        : undefined
    const payload = typeof dispatchBody === 'string' ? (JSON.parse(dispatchBody) as Record<string, unknown>) : {}
    expect(payload.agentType).toBeUndefined()
  })

  it('includes agentType when dispatching with --agent claude', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'factory-feat-123',
          branch: 'feat-123',
          worktree: '/tmp/.factory/NickGuAI/monorepo-g/worktrees/feat-123',
        }),
        {
          status: 202,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(
      [
        'dispatch',
        '--session',
        'commander-main',
        '--issue',
        'https://github.com/NickGuAI/monorepo-g/issues/123',
        '--agent',
        'claude',
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
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/dispatch-worker',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentSession: 'commander-main',
          issueUrl: 'https://github.com/NickGuAI/monorepo-g/issues/123',
          agentType: 'claude',
        }),
      }),
    )
  })

  it('includes agentType when dispatching with --agent codex', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'factory-feat-123',
          branch: 'feat-123',
          worktree: '/tmp/.factory/NickGuAI/monorepo-g/worktrees/feat-123',
        }),
        {
          status: 202,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(
      [
        'dispatch',
        '--session',
        'commander-main',
        '--issue',
        'https://github.com/NickGuAI/monorepo-g/issues/123',
        '--agent',
        'codex',
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
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/dispatch-worker',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentSession: 'commander-main',
          issueUrl: 'https://github.com/NickGuAI/monorepo-g/issues/123',
          agentType: 'codex',
        }),
      }),
    )
  })

  it('returns usage error for invalid dispatch --agent value', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runWorkersCli(
      [
        'dispatch',
        '--session',
        'commander-main',
        '--issue',
        'https://github.com/NickGuAI/monorepo-g/issues/123',
        '--agent',
        'invalid',
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

  it('requires --session and --issue or --branch for dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const missingSessionExit = await runWorkersCli(['dispatch', '--issue', 'https://github.com/a/b/issues/1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })
    expect(missingSessionExit).toBe(1)

    const missingIssueAndBranchExit = await runWorkersCli(
      ['dispatch', '--session', 'commander-main'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      },
    )
    expect(missingIssueAndBranchExit).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('kills a session via DELETE', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ killed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(['kill', 'factory-feat-42'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Session factory-feat-42 killed.')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/factory-feat-42',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('requires a session name for kill', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runWorkersCli(['kill'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends a message via POST /sessions/:name/send', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sent: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(['send', 'factory-feat-42', 'hello worker'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('sent: true')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/factory-feat-42/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ text: 'hello worker' }),
      }),
    )
  })

  it('requires a session name and text for send', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const missingTextExitCode = await runWorkersCli(['send', 'factory-feat-42'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })
    expect(missingTextExitCode).toBe(1)

    const blankTextExitCode = await runWorkersCli(['send', 'factory-feat-42', '   '], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
    })
    expect(blankTextExitCode).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails when config is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stderr = createBufferWriter()

    const exitCode = await runWorkersCli(['list'], {
      fetchImpl,
      readConfig: async () => null,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('HamBros config not found.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
