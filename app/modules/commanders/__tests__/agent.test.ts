import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderAgent } from '../agent.js'
import type { GHIssue } from '../memory/skill-matcher.js'

describe('CommanderAgent system prompt injection', () => {
  let tmpDir: string
  let commanderId: string
  let memoryRoot: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'commander-agent-test-'))
    commanderId = 'cmdr-agent'
    memoryRoot = join(tmpDir, commanderId, '.memory')
    await mkdir(join(memoryRoot, 'journal'), { recursive: true })
    await mkdir(join(memoryRoot, 'repos'), { recursive: true })
    await writeFile(join(memoryRoot, 'MEMORY.md'), '# Commander Memory\n\n- Prefer deterministic fixes.', 'utf-8')
    await mkdir(join(memoryRoot, 'backlog'), { recursive: true })
    await writeFile(join(memoryRoot, 'backlog', 'thin-index.md'), '- #77 Fix auth bug', 'utf-8')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('injects memory context for task pickup and heartbeat', async () => {
    const issue: GHIssue = {
      number: 77,
      title: 'Fix auth bug',
      body: 'Authentication fails during token refresh.',
      labels: [{ name: 'bug' }],
      owner: 'example-user',
      repo: 'example-repo',
    }

    const agent = new CommanderAgent(commanderId, tmpDir)

    const taskPickup = await agent.buildTaskPickupSystemPrompt(
      'You are the commander system.',
      {
        currentTask: issue,
        recentConversation: [{ role: 'user', content: 'Please handle this quickly.' }],
      },
    )

    const heartbeat = await agent.buildHeartbeatSystemPrompt(
      'You are the commander system.',
      {
        currentTask: issue,
        recentConversation: [{ role: 'assistant', content: 'I am still processing.' }],
      },
    )

    expect(taskPickup.systemPrompt).toContain('You are the commander system.')
    expect(taskPickup.systemPrompt).toContain('# Hammurabi Quest Board')
    expect(taskPickup.systemPrompt).toContain('hammurabi quests list')
    expect(taskPickup.systemPrompt).toContain('# Commander Memory Workflow')
    expect(taskPickup.systemPrompt).toContain(`hammurabi memory find --commander ${commanderId}`)
    expect(taskPickup.systemPrompt).toContain(`hammurabi memory save --commander ${commanderId}`)
    expect(taskPickup.systemPrompt).toContain(`hammurabi memory compact --commander ${commanderId}`)
    expect(taskPickup.systemPrompt).toContain('## Commander Memory')
    expect(taskPickup.layersIncluded).toContain(1)
    expect(taskPickup.layersIncluded).toContain(2)

    expect(heartbeat.systemPrompt).toContain('You are the commander system.')
    expect(heartbeat.systemPrompt).toContain('# Hammurabi Quest Board')
    expect(heartbeat.systemPrompt).toContain('# Commander Memory Workflow')
    expect(heartbeat.systemPrompt).toContain(`hammurabi memory find --commander ${commanderId}`)
    expect(heartbeat.systemPrompt).toContain('## Commander Memory')
    expect(heartbeat.layersIncluded).toContain(1)
    expect(heartbeat.layersIncluded).toContain(2)
  })
})
