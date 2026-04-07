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
  it('sends PATCH for update with all fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'cron-1', schedule: '*/10 * * * *' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      [
        'update',
        'cron-1',
        '--commander',
        'cmdr-2',
        '--schedule',
        '*/10 * * * *',
        '--instruction',
        'Check logs',
        '--disabled',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: '',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Cron cron-1 updated.')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-2/crons/cron-1')
    expect(call?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      schedule: '*/10 * * * *',
      instruction: 'Check logs',
      enabled: false,
    })
  })

  it('requires at least one updatable field', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runCronCli(['update', 'cron-1', '--commander', 'cmdr-1'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: '',
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends POST for trigger with --instruction and reports triggered=true', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, triggered: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      ['trigger', '--commander', 'cmdr-2', '--instruction', 'Check logs'],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: '',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Cron instruction triggered.')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-2/cron-trigger')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      instruction: 'Check logs',
    })
  })

  it('sends POST for trigger without --instruction', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, triggered: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['trigger'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stdout.read()).toContain('no instruction pending')

    const call = fetchImpl.mock.calls[0]
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({})
  })

  it('supports --enabled shorthand on update', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'cron-1', enabled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(
      ['update', 'cron-1', '--enabled', '--instruction', 'Check logs'],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: 'cmdr-1',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    const call = fetchImpl.mock.calls[0]
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      instruction: 'Check logs',
      enabled: true,
    })
  })

  it('fails when HAMMURABI_COMMANDER_ID is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['trigger'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: '',
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('--commander or HAMMURABI_COMMANDER_ID is required.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails when config is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stderr = createBufferWriter()

    const exitCode = await runCronCli(['trigger'], {
      fetchImpl,
      readConfig: async () => null,
      commanderId: 'cmdr-1',
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('HamBros config not found.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
