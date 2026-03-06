import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCursorOtelEnv, mergeCursorEnv } from '../cursor-settings.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const vars = buildCursorOtelEnv('https://hammurabi.gehirn.ai', 'hmrb_test_key')

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}

function expectedEnvKey(): string {
  if (process.platform === 'darwin') return 'terminal.integrated.env.osx'
  if (process.platform === 'win32') return 'terminal.integrated.env.windows'
  return 'terminal.integrated.env.linux'
}

describe('mergeCursorEnv', () => {
  it('creates settings file when it does not exist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cursor-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'Cursor', 'User', 'settings.json')

    await mergeCursorEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result[expectedEnvKey()]).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://hammurabi.gehirn.ai',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-hammurabi-api-key=hmrb_test_key',
    })
    expect(result[expectedEnvKey()]).not.toHaveProperty('HAMMURABI_ENDPOINT')
    expect(result[expectedEnvKey()]).not.toHaveProperty('HAMMURABI_API_KEY')
  })

  it('adds env key when file exists without one', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cursor-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(settingsPath, JSON.stringify({ 'editor.fontSize': 14 }), 'utf8')

    await mergeCursorEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, unknown>
    expect(result['editor.fontSize']).toBe(14)
    expect(result[expectedEnvKey()]).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://hammurabi.gehirn.ai',
    })
  })

  it('merges without removing existing env keys', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cursor-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(
      settingsPath,
      JSON.stringify({ [expectedEnvKey()]: { MY_VAR: 'keep_me' } }),
      'utf8',
    )

    await mergeCursorEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result[expectedEnvKey()]?.MY_VAR).toBe('keep_me')
    expect(result[expectedEnvKey()]?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://hammurabi.gehirn.ai')
  })

  it('removes legacy HAMMURABI_* keys on re-onboard', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cursor-settings-'))
    createdDirectories.push(directory)
    const settingsPath = path.join(directory, 'settings.json')

    await writeFile(
      settingsPath,
      JSON.stringify({
        [expectedEnvKey()]: {
          MY_VAR: 'keep_me',
          HAMMURABI_ENDPOINT: 'https://old-endpoint.example.com',
          HAMMURABI_API_KEY: 'old_key',
        },
      }),
      'utf8',
    )

    await mergeCursorEnv(vars, settingsPath)

    const result = await readJson(settingsPath) as Record<string, Record<string, string>>
    expect(result[expectedEnvKey()]?.MY_VAR).toBe('keep_me')
    expect(result[expectedEnvKey()]).not.toHaveProperty('HAMMURABI_ENDPOINT')
    expect(result[expectedEnvKey()]).not.toHaveProperty('HAMMURABI_API_KEY')
    expect(result[expectedEnvKey()]?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://hammurabi.gehirn.ai')
  })
})
