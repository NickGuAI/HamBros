import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CommanderEmailConfigStore,
  CommanderEmailStateStore,
  parseEmailSourceConfig,
} from '../email-config.js'

const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('commander email config store', () => {
  it('parses and persists commander email config', async () => {
    const dir = await createTempDir('hammurabi-email-config-')
    const parsed = parseEmailSourceConfig({
      account: 'assistant@pioneeringminds.ai',
      query: 'label:commander',
      pollIntervalMinutes: 7,
      replyAccount: 'nickgu@gehirn.ai',
      enabled: true,
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }

    const store = new CommanderEmailConfigStore(dir)
    await store.set('cmdr-1', parsed.value)

    const reloaded = new CommanderEmailConfigStore(dir)
    await expect(reloaded.get('cmdr-1')).resolves.toEqual({
      account: 'assistant@pioneeringminds.ai',
      query: 'label:commander',
      pollIntervalMinutes: 7,
      replyAccount: 'nickgu@gehirn.ai',
      enabled: true,
    })
  })

  it('deduplicates seen ids and persists lastCheckedAt', async () => {
    const dir = await createTempDir('hammurabi-email-state-')
    const store = new CommanderEmailStateStore(dir)

    await store.markSeen('cmdr-1', ['mid-1', 'mid-2', 'mid-1'])
    await store.setLastCheckedAt('cmdr-1', '2026-04-03T10:00:00.000Z')

    const reloaded = new CommanderEmailStateStore(dir)
    await expect(reloaded.get('cmdr-1')).resolves.toEqual({
      lastCheckedAt: '2026-04-03T10:00:00.000Z',
      seenMessageIds: ['mid-1', 'mid-2'],
    })
  })
})
