import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCommanderCli } from '../commander.js'

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

describe('runCommanderCli', () => {
  it('prints usage and returns 1 when no subcommand given', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCommanderCli([], { stdout: stdout.writer, stderr: stderr.writer })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('hambros commander init')
  })

  it('prints usage and returns 1 for unknown subcommand', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCommanderCli(['unknown'], { stdout: stdout.writer, stderr: stderr.writer })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('hambros commander init')
  })

  it('creates COMMANDER.md when it does not exist', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()
    let writtenPath = ''
    let writtenContent = ''

    const exitCode = await runCommanderCli(['init'], {
      cwd: '/tmp/test-project',
      fileExists: () => false,
      writeFile: (path, content) => {
        writtenPath = path
        writtenContent = content
      },
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(0)
    expect(writtenPath).toBe('/tmp/test-project/COMMANDER.md')
    expect(stdout.read()).toContain('Created COMMANDER.md')
    expect(writtenContent).toContain('heartbeat.interval')
    expect(writtenContent).toContain('heartbeat.message')
    expect(writtenContent).toContain('maxTurns')
    expect(writtenContent).toContain('contextMode')
    expect(writtenContent).toContain('System prompt')
    expect(writtenContent).toContain('## Memory')
    expect(writtenContent).toContain('/tmp/test-project')
  })

  it('generated file enables the default heartbeat source-of-truth fields', async () => {
    let writtenContent = ''

    await runCommanderCli(['init'], {
      cwd: '/tmp/test-project',
      fileExists: () => false,
      writeFile: (_path, content) => {
        writtenContent = content
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    })

    const lines = writtenContent.split('\n')
    expect(lines).toContain('heartbeat.interval: 900000')
    expect(lines).toContain('heartbeat.message: "Check your quest board. What is your current task? Post a progress note, then continue or pick up the next quest."')
    expect(lines).toContain('contextMode: fat')
    expect(lines).toContain('# maxTurns: 3')
  })

  it('generated file body teaches the commander to read memory on demand', async () => {
    let writtenContent = ''

    await runCommanderCli(['init'], {
      cwd: '/tmp/test-project',
      fileExists: () => false,
      writeFile: (_path, content) => {
        writtenContent = content
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    })

    const closingDelimiter = writtenContent.indexOf('\n---\n')
    const body = closingDelimiter >= 0 ? writtenContent.slice(closingDelimiter + 5).trim() : writtenContent
    expect(body).toContain('## Quest Board')
    expect(body).toContain('## Memory')
    expect(body).toContain('.memory/MEMORY.md')
    expect(body).toContain('hambros memory find --commander [COMMANDER_ID] "<query>"')
  })

  it('errors and returns 1 when COMMANDER.md already exists', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()
    let writeFileCalled = false

    const exitCode = await runCommanderCli(['init'], {
      cwd: '/tmp/existing-project',
      fileExists: () => true,
      writeFile: () => {
        writeFileCalled = true
      },
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(writeFileCalled).toBe(false)
    expect(stderr.read()).toContain('already exists')
    expect(stderr.read()).toContain('Refusing to overwrite')
  })

  it('requires commander id for remote init', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runCommanderCli(
      ['init', '--remote', 'https://hammurabi.gehirn.ai', '--token', 'sync-token', '--once'],
      {
        commanderId: null,
        stdout: stdout.writer,
        stderr: stderr.writer,
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('HAMMURABI_COMMANDER_ID')
  })

  it('bootstraps remote memory and performs one quest sync cycle in --once mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hammurabi-cli-remote-init-'))
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()
    let questsNextCallCount = 0
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof URL ? input.toString() : String(input)
        if (url.endsWith('/memory/export')) {
          return new Response(
            JSON.stringify({
              memoryMd: '# Commander Memory\n\n- exported fact',
              journal: {
                '2026-03-10': '## 09:00 — Existing entry ⚪ ROUTINE\n\n**Repo:** unknown\n\n---\n\n',
              },
              repos: {
                'NickGuAI/monorepo-g.md': '# repo memory',
              },
              skills: {
                'auth-fix/SKILL.md': '# Auth Fix Skill',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }

        if (url.endsWith('/quests/next')) {
          questsNextCallCount += 1
          return new Response(
            JSON.stringify({
              quest: {
                id: 'quest-1',
                instruction: 'Investigate remote commander sync',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }

        if (url.endsWith('/memory/journal')) {
          expect(init?.method).toBe('POST')
          expect(typeof init?.body).toBe('string')
          const body = JSON.parse(String(init?.body)) as {
            date: string
            entries: Array<{ outcome: string }>
          }
          expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          expect(body.entries[0]?.outcome).toContain('Claimed quest quest-1')
          return new Response(
            JSON.stringify({ appended: 1, skipped: 0 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }

        if (url.endsWith('/memory/sync')) {
          expect(init?.method).toBe('PUT')
          return new Response(
            JSON.stringify({ memoryUpdated: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }

        return new Response(JSON.stringify({ error: `Unexpected URL: ${url}` }), { status: 404 })
      },
    )

    try {
      const exitCode = await runCommanderCli(
        [
          'init',
          '--remote', 'https://hammurabi.gehirn.ai',
          '--token', 'sync-token',
          '--commander', 'cmdr-remote-1',
          '--once',
        ],
        {
          cwd,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(questsNextCallCount).toBe(1)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('Bootstrapped remote memory')
      expect(stdout.read()).toContain('Claimed and synced quest quest-1')

      const memory = await readFile(join(cwd, '.memory', 'MEMORY.md'), 'utf8')
      expect(memory).toContain('exported fact')
      const skill = await readFile(join(cwd, 'skills', 'auth-fix', 'SKILL.md'), 'utf8')
      expect(skill).toContain('Auth Fix Skill')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
