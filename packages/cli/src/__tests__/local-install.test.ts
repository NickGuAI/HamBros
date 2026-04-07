import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHambrosAppRoot, resolveHambrosHome } from '../local-install.js'

const createdDirectories: string[] = []

async function createInstallRoot(): Promise<{
  installRoot: string
  symlinkPath: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hambros-local-install-'))
  createdDirectories.push(directory)

  const installRoot = path.join(directory, 'custom-home')
  const appRoot = path.join(installRoot, 'app')
  const binRoot = path.join(directory, 'bin')
  const scriptPath = path.join(appRoot, 'hambros-cli.mjs')
  const symlinkPath = path.join(binRoot, 'hambros')

  await mkdir(appRoot, { recursive: true })
  await mkdir(binRoot, { recursive: true })
  await writeFile(path.join(appRoot, 'package.json'), '{"name":"hambros"}\n', 'utf8')
  await writeFile(scriptPath, '#!/usr/bin/env node\n', 'utf8')
  await symlink(scriptPath, symlinkPath)

  return {
    installRoot,
    symlinkPath,
  }
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('resolveHambrosHome', () => {
  it('infers a custom install root from the symlinked hambros binary when env is unset', async () => {
    const { installRoot, symlinkPath } = await createInstallRoot()

    expect(resolveHambrosHome({}, symlinkPath)).toBe(installRoot)
    expect(resolveHambrosAppRoot({}, symlinkPath)).toBe(path.join(installRoot, 'app'))
  })
})
