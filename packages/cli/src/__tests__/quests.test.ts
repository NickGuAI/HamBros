import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runQuestsCli } from '../quests.js'

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

describe('runQuestsCli', () => {
  it('formats pending and active quests for list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          quests: [
            {
              id: 'quest-1',
              status: 'pending',
              title: 'Prepare deployment checklist',
              artifacts: [{ type: 'url', label: 'Doc', href: 'https://example.com/doc' }],
            },
            { id: 'quest-2', status: 'active', title: 'Patch telemetry emitter' },
            { id: 'quest-3', status: 'done', title: 'Archive incident writeup' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain(
      'Pending quests:\n- quest-1: Prepare deployment checklist [1 artifacts]\n',
    )
    expect(stdout.read()).toContain('Active quests:\n- quest-2: Patch telemetry emitter\n')
    expect(stdout.read()).not.toContain('quest-3')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer hmrb_test_key',
        }),
      }),
    )
  })

  it('sends PATCH for claim', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['claim', 'quest-42'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests/quest-42')
    expect(call?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({ status: 'active' })
  })

  it('sends POST for note', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['note', 'quest-88', 'Progress made'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe(
      'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests/quest-88/notes',
    )
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({ note: 'Progress made' })
  })

  it('sends PATCH for done with status done', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['done', 'quest-9', '--note', 'Completed rollout'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const call = fetchImpl.mock.calls[0]
    expect(call?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      status: 'done',
      note: 'Completed rollout',
    })
  })

  it('sends PATCH for fail with status failed', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['fail', 'quest-11', '--note', 'Blocked by API outage'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const call = fetchImpl.mock.calls[0]
    expect(call?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      status: 'failed',
      note: 'Blocked by API outage',
    })
  })

  it('adds quest artifact via GET then PATCH', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            quests: [
              {
                id: 'quest-42',
                artifacts: [
                  {
                    type: 'github_issue',
                    label: 'Issue #55',
                    href: 'https://github.com/NickGuAI/monorepo-g/issues/55',
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(
      [
        'artifact',
        'add',
        'quest-42',
        '--type',
        'github_pr',
        '--label',
        'PR #77',
        '--href',
        'https://github.com/NickGuAI/monorepo-g/pull/77',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: 'cmdr-1',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const getCall = fetchImpl.mock.calls[0]
    expect(getCall?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests')
    expect(getCall?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
      }),
    })

    const patchCall = fetchImpl.mock.calls[1]
    expect(patchCall?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests/quest-42')
    expect(patchCall?.[1]).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((patchCall?.[1]?.body as string) ?? '{}')).toEqual({
      artifacts: [
        {
          type: 'github_issue',
          label: 'Issue #55',
          href: 'https://github.com/NickGuAI/monorepo-g/issues/55',
        },
        {
          type: 'github_pr',
          label: 'PR #77',
          href: 'https://github.com/NickGuAI/monorepo-g/pull/77',
        },
      ],
    })
  })

  it('removes quest artifact via GET then PATCH', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            quests: [
              {
                id: 'quest-99',
                artifacts: [
                  {
                    type: 'github_issue',
                    label: 'Issue #10',
                    href: 'https://github.com/NickGuAI/monorepo-g/issues/10',
                  },
                  {
                    type: 'url',
                    label: 'Spec',
                    href: 'https://example.com/spec',
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(
      ['artifact', 'remove', 'quest-99', 'https://example.com/spec'],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: 'cmdr-1',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const patchCall = fetchImpl.mock.calls[1]
    expect(JSON.parse((patchCall?.[1]?.body as string) ?? '{}')).toEqual({
      artifacts: [
        {
          type: 'github_issue',
          label: 'Issue #10',
          href: 'https://github.com/NickGuAI/monorepo-g/issues/10',
        },
      ],
    })
  })

  it('fails when HAMMURABI_COMMANDER_ID is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['list'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: '',
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('HAMMURABI_COMMANDER_ID is required.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends POST for create with contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'quest-new-1', status: 'pending' }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(
      [
        'create',
        '--instruction', 'Deploy the new service',
        '--cwd', '/home/user/app',
        '--mode', 'default',
        '--agent', 'claude',
        '--skills', 'commit,test',
        '--source', 'manual',
        '--issue', 'https://github.com/org/repo/issues/42',
        '--note', 'High priority',
      ],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: 'cmdr-1',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Quest created: quest-new-1')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests')
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer hmrb_test_key',
        'content-type': 'application/json',
      }),
    })
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      instruction: 'Deploy the new service',
      contract: {
        cwd: '/home/user/app',
        permissionMode: 'default',
        agentType: 'claude',
        skillsToUse: ['commit', 'test'],
      },
      source: 'manual',
      githubIssueUrl: 'https://github.com/org/repo/issues/42',
      note: 'High priority',
    })
  })

  it('supports issue-only create without explicit contract flags', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'quest-new-2', status: 'pending' }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(
      ['create', '--issue', 'https://github.com/org/repo/issues/544'],
      {
        fetchImpl,
        readConfig: async () => config,
        commanderId: 'cmdr-1',
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Quest created: quest-new-2')

    const call = fetchImpl.mock.calls[0]
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      githubIssueUrl: 'https://github.com/org/repo/issues/544',
    })
  })

  it('supports instruction-only create without explicit contract flags', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'quest-new-3', status: 'pending' }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['create', '--instruction', 'Do something'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Quest created: quest-new-3')

    const call = fetchImpl.mock.calls[0]
    expect(JSON.parse((call?.[1]?.body as string) ?? '{}')).toEqual({
      instruction: 'Do something',
    })
  })

  it('requires --instruction or --issue for create', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stdout = createBufferWriter()

    const exitCode = await runQuestsCli(['create', '--source', 'manual'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
    })

    expect(exitCode).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends DELETE for delete', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    )
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['delete', 'quest-99'], {
      fetchImpl,
      readConfig: async () => config,
      commanderId: 'cmdr-1',
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(stderr.read()).toBe('')
    expect(stdout.read()).toContain('Quest quest-99 deleted.')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = fetchImpl.mock.calls[0]
    expect(call?.[0]).toBe('https://hammurabi.gehirn.ai/api/commanders/cmdr-1/quests/quest-99')
    expect(call?.[1]).toMatchObject({ method: 'DELETE' })
  })

  it('fails when hambros config is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const stderr = createBufferWriter()

    const exitCode = await runQuestsCli(['list'], {
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
