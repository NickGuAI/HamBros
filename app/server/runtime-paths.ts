import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveAppRoot(fromUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(fromUrl))
  const candidates = [resolve(here, '..'), resolve(here, '..', '..')]

  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, 'package.json'))
      && (
        existsSync(join(candidate, 'server'))
        || existsSync(join(candidate, 'dist-server', 'server'))
      )
    ) {
      return candidate
    }
  }

  return resolve(here, '..')
}

export const APP_ROOT = resolveAppRoot()
export const DATA_DIR = join(APP_ROOT, 'data')
export const DIST_DIR = join(APP_ROOT, 'dist')

export function resolveDataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments)
}
