import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveCommanderNamesPath } from './paths.js'

const namesMutexByPath = new Map<string, Promise<void>>()

// Serialize read-modify-write on names.json per file path to prevent
// concurrent mutation races without cross-directory coupling.
export function withNamesLock(
  dataDir: string,
  fn: (names: Record<string, string>) => void,
): Promise<void> {
  const namesPath = resolveCommanderNamesPath(dataDir)
  const previous = namesMutexByPath.get(namesPath) ?? Promise.resolve()
  const next = previous.then(async () => {
    let names: Record<string, string> = {}
    try {
      names = JSON.parse(await readFile(namesPath, 'utf8')) as Record<string, string>
    } catch {
      // names.json may not exist yet
    }
    fn(names)
    await mkdir(path.dirname(namesPath), { recursive: true })
    await writeFile(namesPath, JSON.stringify(names, null, 2), 'utf8')
  })

  const guarded = next.catch(() => {})
  namesMutexByPath.set(namesPath, guarded)
  return next.finally(() => {
    if (namesMutexByPath.get(namesPath) === guarded) {
      namesMutexByPath.delete(namesPath)
    }
  })
}
