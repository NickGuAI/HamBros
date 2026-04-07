import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStartTarget, runStartCli } from '../start.js'

const createdDirectories: string[] = []

async function createInstallRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hambros-start-'))
  createdDirectories.push(directory)
  const appRoot = path.join(directory, 'app')
  await mkdir(appRoot, { recursive: true })
  await writeFile(path.join(appRoot, 'package.json'), '{\"name\":\"hambros\"}\n', 'utf8')
  await writeFile(path.join(appRoot, '.env'), 'PORT=20001\n', 'utf8')
  return directory
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('resolveStartTarget', () => {
  it('prefers the startup wrapper with production mode when source files are available', () => {
    const appRoot = '/tmp/.hambros/app'
    const target = resolveStartTarget(
      appRoot,
      { NODE_ENV: '' },
      (candidate) =>
        candidate === path.join(appRoot, 'server', 'index.ts')
        || candidate === path.join(appRoot, 'scripts', 'start-with-memory-restore.sh')
        || candidate === path.join(appRoot, 'dist', 'index.html'),
    )

    expect(target).toEqual({
      command: 'bash',
      args: [path.join(appRoot, 'scripts', 'start-with-memory-restore.sh')],
      cwd: appRoot,
      env: {
        NODE_ENV: 'production',
      },
    })
  })
})

describe('runStartCli', () => {
  it('runs the startup wrapper from the Hambros install directory', async () => {
    const installRoot = await createInstallRoot()
    const sourceEntry = path.join(installRoot, 'app', 'server', 'index.ts')
    const startupWrapper = path.join(installRoot, 'app', 'scripts', 'start-with-memory-restore.sh')
    const builtClientEntry = path.join(installRoot, 'app', 'dist', 'index.html')
    await mkdir(path.dirname(sourceEntry), { recursive: true })
    await mkdir(path.dirname(startupWrapper), { recursive: true })
    await mkdir(path.dirname(builtClientEntry), { recursive: true })
    await writeFile(sourceEntry, '', 'utf8')
    await writeFile(startupWrapper, '', 'utf8')
    await writeFile(builtClientEntry, '', 'utf8')

    const runCommand = vi.fn().mockResolvedValue(0)
    const exitCode = await runStartCli([], {
      env: { ...process.env, HAMBROS_HOME: installRoot },
      runCommand,
    })

    expect(exitCode).toBe(0)
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'bash',
        args: [startupWrapper],
        cwd: path.join(installRoot, 'app'),
        env: expect.objectContaining({
          NODE_ENV: 'production',
        }),
      }),
    )
  })

  it('falls back to the compiled server when source files are unavailable', async () => {
    const installRoot = await createInstallRoot()
    const builtEntry = path.join(installRoot, 'app', 'dist-server', 'server', 'index.js')
    await mkdir(path.dirname(builtEntry), { recursive: true })
    await writeFile(builtEntry, '', 'utf8')

    const runCommand = vi.fn().mockResolvedValue(0)
    const exitCode = await runStartCli([], {
      env: { ...process.env, HAMBROS_HOME: installRoot },
      runCommand,
    })

    expect(exitCode).toBe(0)
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: [builtEntry],
        cwd: path.join(installRoot, 'app'),
      }),
    )
  })
})
