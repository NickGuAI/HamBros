import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderAgent } from '../agent.js'

describe('CommanderAgent identity prompt injection', () => {
  let tmpDir: string
  const commanderId = 'cmdr-identity-agent'

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-agent-identity-test-'))
    const memoryRoot = join(tmpDir, commanderId, '.memory')
    await mkdir(join(memoryRoot, 'journal'), { recursive: true })
    await mkdir(join(memoryRoot, 'repos'), { recursive: true })
    await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
    await writeFile(join(memoryRoot, 'MEMORY.md'), '# Commander Memory\n\n- Keep changes surgical.', 'utf-8')
    await writeFile(join(memoryRoot, 'backlog', 'thin-index.md'), '- #557 commander identity', 'utf-8')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('prepends identity.md body (without front matter) ahead of the base prompt', async () => {
    await writeFile(
      join(tmpDir, commanderId, '.memory', 'identity.md'),
      [
        '---',
        'id: "cmdr-identity-agent"',
        'host: "athena"',
        'persona: "Athena, engineering commander"',
        'created: "2026-03-18T00:00:00.000Z"',
        'cwd: "/workspace/repo"',
        '---',
        '',
        '# Identity Section',
        '',
        'You are Athena, engineering commander.',
      ].join('\n'),
      'utf8',
    )

    const agent = new CommanderAgent(commanderId, tmpDir)
    const built = await agent.buildTaskPickupSystemPrompt('Base system prompt', {
      currentTask: null,
      recentConversation: [],
    })

    expect(built.systemPrompt).toContain('# Identity Section')
    expect(built.systemPrompt).toContain('You are Athena, engineering commander.')
    expect(built.systemPrompt).toContain('Base system prompt')
    expect(built.systemPrompt).not.toContain('id: "cmdr-identity-agent"')
    expect(built.systemPrompt.indexOf('# Identity Section')).toBeLessThan(
      built.systemPrompt.indexOf('Base system prompt'),
    )
    expect(built.memorySection).toBe(built.systemPromptSection)
    expect(built.memorySection).not.toContain('# Identity Section')
    expect(built.memorySection).not.toContain('You are Athena, engineering commander.')
    expect(built.memorySection).not.toContain('Base system prompt')
  })

  it('keeps current behavior when commander.md does not exist', async () => {
    const agent = new CommanderAgent(commanderId, tmpDir)
    const built = await agent.buildTaskPickupSystemPrompt('Base system prompt', {
      currentTask: null,
      recentConversation: [],
    })

    expect(built.systemPrompt.startsWith('Base system prompt')).toBe(true)
  })
})
