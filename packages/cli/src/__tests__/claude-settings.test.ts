import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClaudeCodeOtelEnv, mergeClaudeCodeEnv } from '../claude-settings.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const vars = buildClaudeCodeOtelEnv('https://hammurabi.gehirn.ai', 'hmrb_test_key')

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

describe('mergeClaudeCodeEnv', () => {
  it('creates settings file when it does not exist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'claude-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, '.claude', 'settings.json')

    await mergeClaudeCodeEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://hammurabi.gehirn.ai',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-hammurabi-api-key=hmrb_test_key',
    })
    // Legacy keys should NOT be present
    expect(result.env).not.toHaveProperty('HAMMURABI_ENDPOINT')
    expect(result.env).not.toHaveProperty('HAMMURABI_API_KEY')
  })

  it('adds env key when file exists without one', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'claude-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: [] } }), 'utf8')

    await mergeClaudeCodeEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, unknown>
    expect(result.permissions).toEqual({ allow: [] })
    expect(result.env).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://hammurabi.gehirn.ai',
    })
  })

  it('merges without removing existing env keys', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'claude-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(
      settingsPath,
      JSON.stringify({ env: { MY_VAR: 'keep_me' } }),
      'utf8',
    )

    await mergeClaudeCodeEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result.env.MY_VAR).toBe('keep_me')
    expect(result.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://hammurabi.gehirn.ai')
  })

  it('removes legacy HAMMURABI_* keys on re-onboard', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'claude-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          MY_VAR: 'keep_me',
          HAMMURABI_ENDPOINT: 'https://old-endpoint.example.com',
          HAMMURABI_API_KEY: 'old_key',
        },
      }),
      'utf8',
    )

    await mergeClaudeCodeEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result.env.MY_VAR).toBe('keep_me')
    expect(result.env).not.toHaveProperty('HAMMURABI_ENDPOINT')
    expect(result.env).not.toHaveProperty('HAMMURABI_API_KEY')
    expect(result.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://hammurabi.gehirn.ai')
  })
})
