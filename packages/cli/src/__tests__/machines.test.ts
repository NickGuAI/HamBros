import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runMachinesCli } from '../machines.js'

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

describe('runMachinesCli', () => {
  it('lists registered machines in table form', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'local', label: 'Local', host: null },
          { id: 'gpu-1', label: 'GPU', host: '10.0.1.50', port: 22, cwd: '/srv/workspace' },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('ID')
    expect(stdout.read()).toContain('local')
    expect(stdout.read()).toContain('gpu-1')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/machines',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('adds a machine through the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'gpu-2',
          label: 'GPU 2',
          host: '10.0.1.60',
          user: 'ec2-user',
          port: 2222,
          cwd: '/srv/workspace',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(
      ['add', '--id', 'gpu-2', '--label', 'GPU 2', '--host', '10.0.1.60', '--user', 'ec2-user', '--port', '2222', '--cwd', '/srv/workspace'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Registered machine: gpu-2')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/machines',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          id: 'gpu-2',
          label: 'GPU 2',
          host: '10.0.1.60',
          user: 'ec2-user',
          port: 2222,
          cwd: '/srv/workspace',
        }),
      }),
    )
  })

  it('prints machine health for check', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          machineId: 'gpu-1',
          mode: 'ssh',
          ssh: {
            ok: true,
            destination: 'ec2-user@10.0.1.50',
          },
          tools: {
            claude: { ok: true, version: '1.0.31', raw: '1.0.31' },
            codex: { ok: false, version: null, raw: 'missing' },
            git: { ok: true, version: 'git version 2.45.1', raw: 'git version 2.45.1' },
            node: { ok: true, version: 'v22.14.0', raw: 'v22.14.0' },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(['check', 'gpu-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Machine: gpu-1')
    expect(stdout.read()).toContain('SSH: ok (ec2-user@10.0.1.50)')
    expect(stdout.read()).toContain('- codex: missing')
  })

  it('removes a machine through the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(['remove', 'gpu-1'], {
      fetchImpl,
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Removed machine: gpu-1')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/agents/machines/gpu-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('bootstraps a remote machine and prints service health proof', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'gpu-1',
              label: 'GPU',
              host: '10.0.1.50',
              user: 'ec2-user',
              port: 2222,
            },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            machineId: 'gpu-1',
            mode: 'ssh',
            ssh: {
              ok: true,
              destination: 'ec2-user@10.0.1.50',
            },
            tools: {
              claude: { ok: true, version: '1.0.31', raw: '1.0.31' },
              codex: { ok: true, version: '0.1.2503271400', raw: '0.1.2503271400' },
              git: { ok: true, version: 'git version 2.45.1', raw: 'git version 2.45.1' },
              node: { ok: true, version: 'v22.14.0', raw: 'v22.14.0' },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
    const runCommand = vi.fn().mockResolvedValue({
      stdout: 'telemetry:configured\ninstalled:claude:1.0.31\ninstalled:codex:0.1.2503271400\nbootstrap:ok\n',
      stderr: '',
      code: 0,
    })
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(['bootstrap', 'gpu-1'], {
      fetchImpl,
      readConfig: async () => config,
      runCommand,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(runCommand).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-p',
        '2222',
        'ec2-user@10.0.1.50',
      ]),
      expect.objectContaining({
        timeoutMs: 300000,
      }),
    )
    const remoteCommand = runCommand.mock.calls[0]?.[1]?.at(-1) as string
    expect(remoteCommand).toContain('/bin/bash -lc')
    expect(remoteCommand).toContain('@anthropic-ai/claude-code')
    expect(remoteCommand).toContain('@openai/codex')
    expect(stdout.read()).toContain('Service health after bootstrap:')
    expect(stdout.read()).toContain('Machine: gpu-1')
    expect(stdout.read()).toContain('Manual prerequisites:')
  })

  it('rejects add when host incorrectly includes user@host syntax', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMachinesCli(
      ['add', '--id', 'gpu-2', '--label', 'GPU 2', '--host', 'ec2-user@10.0.1.60'],
      {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('Invalid add arguments.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
