import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppRoot } from '../runtime-paths'

const createdDirectories: string[] = []

async function createAppRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hambros-paths-'))
  createdDirectories.push(directory)
  await writeFile(path.join(directory, 'package.json'), '{\"name\":\"hambros\"}\n', 'utf8')
  await mkdir(path.join(directory, 'server'), { recursive: true })
  return directory
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('resolveAppRoot', () => {
  it('resolves the app root from source files', async () => {
    const appRoot = await createAppRoot()
    const sourceUrl = pathToFileURL(path.join(appRoot, 'server', 'index.ts')).toString()

    expect(resolveAppRoot(sourceUrl)).toBe(appRoot)
  })

  it('resolves the app root from compiled dist-server files', async () => {
    const appRoot = await createAppRoot()
    await mkdir(path.join(appRoot, 'dist-server', 'server'), { recursive: true })
    const compiledUrl = pathToFileURL(path.join(appRoot, 'dist-server', 'server', 'index.js')).toString()

    expect(resolveAppRoot(compiledUrl)).toBe(appRoot)
  })
})
