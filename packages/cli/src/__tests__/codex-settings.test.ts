import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { buildCodexOtelConfig, mergeCodexOtelConfig } from '../codex-settings.js'

const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const config = buildCodexOtelConfig('https://hammurabi.gehirn.ai', 'hmrb_test_key')

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  return parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
}

describe('mergeCodexOtelConfig', () => {
  it('creates config.toml when it does not exist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-settings-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, '.codex', 'config.toml')

    await mergeCodexOtelConfig(config, configPath)

    const result = await readToml(configPath)
    const otel = result.otel as Record<string, unknown>
    expect(otel.log_user_prompt).toBe(true)

    const exporter = otel.exporter as Record<string, Record<string, unknown>>
    const httpConfig = exporter['otlp-http']
    expect(httpConfig.endpoint).toBe('https://hammurabi.gehirn.ai/v1/logs')
    expect(httpConfig.protocol).toBe('json')

    const headers = httpConfig.headers as Record<string, string>
    expect(headers['x-hammurabi-api-key']).toBe('hmrb_test_key')
  })

  it('adds otel section when file exists without one', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-settings-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, 'config.toml')

    await writeFile(configPath, 'model = "gpt-5.3-codex"\n', 'utf8')

    await mergeCodexOtelConfig(config, configPath)

    const result = await readToml(configPath)
    expect(result.model).toBe('gpt-5.3-codex')

    const otel = result.otel as Record<string, unknown>
    expect(otel.log_user_prompt).toBe(true)

    const exporter = otel.exporter as Record<string, Record<string, unknown>>
    expect(exporter['otlp-http'].endpoint).toBe('https://hammurabi.gehirn.ai/v1/logs')
  })

  it('preserves existing otel keys like environment and trace_exporter', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-settings-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, 'config.toml')

    await writeFile(
      configPath,
      '[otel]\nenvironment = "production"\ntrace_exporter = "none"\n',
      'utf8',
    )

    await mergeCodexOtelConfig(config, configPath)

    const result = await readToml(configPath)
    const otel = result.otel as Record<string, unknown>
    expect(otel.environment).toBe('production')
    expect(otel.trace_exporter).toBe('none')
    expect(otel.log_user_prompt).toBe(true)
  })

  it('overwrites previous otel exporter on re-onboard', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-settings-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, 'config.toml')

    // First onboard
    await mergeCodexOtelConfig(config, configPath)

    // Re-onboard with different endpoint
    const newConfig = buildCodexOtelConfig('https://new-hammurabi.gehirn.ai', 'hmrb_new_key')
    await mergeCodexOtelConfig(newConfig, configPath)

    const result = await readToml(configPath)
    const otel = result.otel as Record<string, unknown>
    const exporter = otel.exporter as Record<string, Record<string, unknown>>
    const httpConfig = exporter['otlp-http']
    expect(httpConfig.endpoint).toBe('https://new-hammurabi.gehirn.ai/v1/logs')

    const headers = httpConfig.headers as Record<string, string>
    expect(headers['x-hammurabi-api-key']).toBe('hmrb_new_key')
  })

  it('preserves project trust levels and other config', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-settings-'))
    createdDirectories.push(directory)
    const configPath = path.join(directory, 'config.toml')

    const existingConfig = [
      'model = "gpt-5.3-codex"',
      '',
      '[projects."/home/user/app"]',
      'trust_level = "trusted"',
      '',
      '[features]',
      'multi_agent = true',
      '',
    ].join('\n')

    await writeFile(configPath, existingConfig, 'utf8')

    await mergeCodexOtelConfig(config, configPath)

    const result = await readToml(configPath)
    expect(result.model).toBe('gpt-5.3-codex')

    const projects = result.projects as Record<string, Record<string, string>>
    expect(projects['/home/user/app'].trust_level).toBe('trusted')

    const features = result.features as Record<string, boolean>
    expect(features.multi_agent).toBe(true)

    const otel = result.otel as Record<string, unknown>
    expect(otel.log_user_prompt).toBe(true)
  })
})
