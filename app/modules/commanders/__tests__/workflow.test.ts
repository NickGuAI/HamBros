import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCommanderWorkflow, mergeWorkflows } from '../workflow'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ),
  )
})

describe('commander workflow helpers', () => {
  it('returns null when both workflows are absent', () => {
    expect(mergeWorkflows(null, null)).toBeNull()
  })

  it('returns a copy of the base workflow when override is absent', () => {
    const base = {
      heartbeatInterval: '1000',
      heartbeatMessage: '[base]',
    }

    expect(mergeWorkflows(base, null)).toEqual(base)
    expect(mergeWorkflows(base, null)).not.toBe(base)
  })

  it('returns a copy of the override workflow when base is absent', () => {
    const override = {
      systemPromptTemplate: 'Override prompt',
      maxTurns: 4,
    }

    expect(mergeWorkflows(null, override)).toEqual(override)
    expect(mergeWorkflows(null, override)).not.toBe(override)
  })

  it('prefers non-undefined override fields while preserving base fields', () => {
    const merged = mergeWorkflows(
      {
        heartbeatInterval: '1500',
        heartbeatMessage: '[base hb]',
        systemPromptTemplate: 'Base prompt',
      },
      {
        heartbeatMessage: '[cwd hb]',
        maxTurns: 2,
        systemPromptTemplate: 'Override prompt',
      },
    )

    expect(merged).toEqual({
      heartbeatInterval: '1500',
      heartbeatMessage: '[cwd hb]',
      maxTurns: 2,
      systemPromptTemplate: 'Override prompt',
    })
  })

  it('loads COMMANDER.md front matter and body from disk', async () => {
    const dir = await createTempDir('hammurabi-workflow-test-')
    await writeFile(
      join(dir, 'COMMANDER.md'),
      [
        '---',
        'heartbeat.interval: 2500',
        'heartbeat.message: "[workflow {{timestamp}}]"',
        'maxTurns: 4',
        '---',
        '',
        'You are the test commander.',
      ].join('\n'),
      'utf8',
    )

    await expect(loadCommanderWorkflow(dir)).resolves.toEqual({
      heartbeatInterval: '2500',
      heartbeatMessage: '[workflow {{timestamp}}]',
      maxTurns: 4,
      systemPromptTemplate: 'You are the test commander.',
    })
  })
})
