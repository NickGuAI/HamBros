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

describe('runWorkersCli dispatch --type', () => {
  it('allows --type agent without --issue or --branch when --session is provided', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'agent-123',
          workerType: 'agent',
          cwd: '/repo',
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
        '--type',
        'agent',
        '--task',
        'Investigate flaky tests',
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
    expect(stdout.read()).toContain('Worker dispatched: agent-123')
    expect(stdout.read()).toContain('Type: agent')
    expect(stdout.read()).toContain('Cwd: /repo')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/sessions/dispatch-worker',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          parentSession: 'commander-main',
          task: 'Investigate flaky tests',
          workerType: 'agent',
        }),
      }),
    )
  })

  it('requires --session when --type agent is used', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runWorkersCli(
      [
        'dispatch',
        '--type',
        'agent',
        '--task',
        'Investigate flaky tests',
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

  it('defaults to factory behavior when --type is omitted', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'factory-feat-123',
          workerType: 'factory',
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
        '--issue',
        'https://github.com/NickGuAI/monorepo-g/issues/123',
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

    const dispatchCall = fetchImpl.mock.calls[0]
    const dispatchInit = dispatchCall?.[1]
    const dispatchBody =
      dispatchInit && typeof dispatchInit === 'object' && 'body' in dispatchInit
        ? dispatchInit.body
        : undefined
    const payload = typeof dispatchBody === 'string' ? (JSON.parse(dispatchBody) as Record<string, unknown>) : {}

    expect(payload.workerType).toBeUndefined()
    expect(payload.issueUrl).toBe('https://github.com/NickGuAI/monorepo-g/issues/123')
    expect(payload.parentSession).toBeUndefined()
  })

  it('requires --issue or --branch when --type is factory or omitted', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const missingForDefaultFactory = await runWorkersCli(
      ['dispatch'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      },
    )

    const missingForExplicitFactory = await runWorkersCli(
      ['dispatch', '--type', 'factory'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
      },
    )

    expect(missingForDefaultFactory).toBe(1)
    expect(missingForExplicitFactory).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects invalid --type values', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runWorkersCli(
      ['dispatch', '--type', 'invalid', '--task', 'x'],
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
})

describe('runWorkersCli list worker type output', () => {
  it('shows type labels when both factory and agent workers are present', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'factory-feat-1', sessionType: 'stream', cwd: '/tmp/.factory/repo/worktree-a' },
          { name: 'agent-1710000000000', sessionType: 'stream', host: 'mac-mini' },
          { name: 'dev-session', sessionType: 'stream' },
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
    expect(stdout.read()).toContain('Active workers:')
    expect(stdout.read()).toContain('factory-feat-1 cwd=/tmp/.factory/repo/worktree-a type=factory')
    expect(stdout.read()).toContain('agent-1710000000000 host=mac-mini type=agent')
    expect(stdout.read()).not.toContain('dev-session')
  })

  it('keeps factory-only output stable when no agent workers are present', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: 'factory-feat-1', sessionType: 'stream', cwd: '/tmp/.factory/repo/worktree-a' },
          { name: 'factory-feat-2', sessionType: 'stream' },
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
    expect(stdout.read()).not.toContain('type=factory')
  })
})
