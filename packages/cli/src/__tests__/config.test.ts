import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHammurabiConfig,
  readHammurabiConfig,
  writeHammurabiConfig,
} from '../config.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('createHammurabiConfig', () => {
  it('normalizes endpoint and preserves selected agents', () => {
    const configuredAt = new Date('2026-02-17T00:00:00.000Z')
    const config = createHammurabiConfig({
      endpoint: 'https://hammurabi.gehirn.ai/',
      apiKey: 'hmrb_test_key',
      agents: ['claude-code', 'codex', 'claude-code'],
      configuredAt,
    })

    expect(config).toEqual({
      endpoint: 'https://hammurabi.gehirn.ai',
      apiKey: 'hmrb_test_key',
      agents: ['claude-code', 'codex'],
      configuredAt: configuredAt.toISOString(),
    })
  })
})

describe('readHammurabiConfig/writeHammurabiConfig', () => {
  it('writes and reads a config file from a custom path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-cli-config-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, '.hambros.json')

    const config = createHammurabiConfig({
      endpoint: 'https://hammurabi.gehirn.ai',
      apiKey: 'hmrb_test_key',
      agents: ['claude-code', 'codex'],
      configuredAt: new Date('2026-02-17T00:00:00.000Z'),
    })

    await writeHammurabiConfig(config, configPath)
    await expect(readHammurabiConfig(configPath)).resolves.toEqual(config)
  })

  it('returns null when config file does not exist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-cli-config-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, '.hambros.json')

    await expect(readHammurabiConfig(configPath)).resolves.toBeNull()
  })
})
