import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInitCli } from '../init.js'

const createdDirectories: string[] = []

async function createInstallRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hambros-init-'))
  createdDirectories.push(directory)
  const appRoot = path.join(directory, 'app')
  await mkdir(appRoot, { recursive: true })
  await writeFile(path.join(appRoot, 'package.json'), '{\"name\":\"hambros\"}\n', 'utf8')
  return directory
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('runInitCli', () => {
  it('writes a local app env file and Hambros CLI config', async () => {
    const installRoot = await createInstallRoot()
    const promptTextImpl = vi
      .fn<typeof import('../prompts.js').promptText>()
      .mockResolvedValueOnce('21000')
      .mockResolvedValueOnce('hmrb_admin_key')
    const promptMultiSelectImpl = vi
      .fn<typeof import('../prompts.js').promptMultiSelect>()
      .mockResolvedValue(['claude-code', 'codex'])
    const writeConfig = vi.fn<typeof import('../config.js').writeHammurabiConfig>().mockResolvedValue()
    const mergeClaudeCodeEnvImpl = vi.fn<typeof import('../claude-settings.js').mergeClaudeCodeEnv>().mockResolvedValue()
    const mergeCodexOtelConfigImpl = vi.fn<typeof import('../codex-settings.js').mergeCodexOtelConfig>().mockResolvedValue()

    const exitCode = await runInitCli([], {
      env: { ...process.env, HAMBROS_HOME: installRoot },
      promptTextImpl,
      promptMultiSelectImpl,
      writeConfig,
      mergeClaudeCodeEnvImpl,
      mergeCodexOtelConfigImpl,
      mergeCursorEnvImpl: vi.fn().mockResolvedValue(),
    })

    expect(exitCode).toBe(0)
    const envContents = await readFile(path.join(installRoot, 'app', '.env'), 'utf8')
    expect(envContents).toContain('PORT=21000')
    expect(envContents).toContain('HAMBROS_ALLOWED_ORIGINS=http://localhost:5173')
    expect(envContents).toContain('HAMBROS_DEFAULT_KEY=hmrb_admin_key')

    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://localhost:21000',
        apiKey: 'hmrb_admin_key',
        agents: ['claude-code', 'codex'],
      }),
    )
    expect(mergeClaudeCodeEnvImpl).toHaveBeenCalled()
    expect(mergeCodexOtelConfigImpl).toHaveBeenCalled()
  })

  it('preserves unrelated env settings on re-run', async () => {
    const installRoot = await createInstallRoot()
    const envPath = path.join(installRoot, 'app', '.env')
    await writeFile(
      envPath,
      [
        'PORT=20001',
        'AUTH0_DOMAIN=tenant.example.com',
        'HAMBROS_ALLOWED_ORIGINS=http://localhost:3000',
        '',
      ].join('\n'),
      'utf8',
    )

    const exitCode = await runInitCli([], {
      env: { ...process.env, HAMBROS_HOME: installRoot },
      promptTextImpl: vi
        .fn<typeof import('../prompts.js').promptText>()
        .mockResolvedValueOnce('22000')
        .mockResolvedValueOnce('HAMBROS!'),
      promptMultiSelectImpl: vi.fn<typeof import('../prompts.js').promptMultiSelect>().mockResolvedValue(['cursor']),
      writeConfig: vi.fn<typeof import('../config.js').writeHammurabiConfig>().mockResolvedValue(),
      mergeClaudeCodeEnvImpl: vi.fn().mockResolvedValue(),
      mergeCodexOtelConfigImpl: vi.fn().mockResolvedValue(),
      mergeCursorEnvImpl: vi.fn().mockResolvedValue(),
    })

    expect(exitCode).toBe(0)
    const envContents = await readFile(envPath, 'utf8')
    expect(envContents).toContain('PORT=22000')
    expect(envContents).toContain('AUTH0_DOMAIN=tenant.example.com')
    expect(envContents).toContain('HAMBROS_ALLOWED_ORIGINS=http://localhost:3000')
    expect(envContents).toContain('HAMBROS_DEFAULT_KEY=HAMBROS!')
  })
})
