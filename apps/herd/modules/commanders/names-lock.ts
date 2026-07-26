import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
  resolveCommanderNamesPath,
  resolveCommanderPaths,
  resolveCommanderSessionStorePath,
} from './paths.js'
import { CommanderSessionStore } from './store.js'
import { withCommanderMutation } from './child-mutation-coordinator.js'

const namesMutexByPath = new Map<string, Promise<void>>()

interface CommanderNamesState {
  exists: boolean
  names: Record<string, string>
}

export interface PruneOrphanCommanderNamesResult {
  namesPath: string
  sessionStorePath: string
  totalBefore: number
  totalAfter: number
  keptCommanderIds: string[]
  removedCommanderIds: string[]
  removedNames: Record<string, string>
}

export class UnknownCommanderError extends Error {
  constructor(commanderId: string) {
    super(`Commander "${commanderId}" is not a registered commander`)
    this.name = 'UnknownCommanderError'
  }
}

async function readNamesState(namesPath: string): Promise<CommanderNamesState> {
  try {
    const raw = await readFile(namesPath, 'utf8')
    try {
      return {
        exists: true,
        names: JSON.parse(raw) as Record<string, string>,
      }
    } catch {
      return {
        exists: true,
        names: {},
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        names: {},
      }
    }
    throw error
  }
}

export async function readCommanderDisplayNames(dataDir: string): Promise<Record<string, string>> {
  const { names } = await readNamesState(resolveCommanderNamesPath(dataDir))
  return names
}

async function writeNamesFile(
  namesPath: string,
  names: Record<string, string>,
): Promise<void> {
  await mkdir(path.dirname(namesPath), { recursive: true })
  const tempPath = path.join(
    path.dirname(namesPath),
    `${path.basename(namesPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  await writeFile(tempPath, JSON.stringify(names, null, 2), 'utf8')
  try {
    await rename(tempPath, namesPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function loadPersistedCommanderIds(dataDir: string): Promise<Set<string>> {
  const sessionStore = new CommanderSessionStore(resolveCommanderSessionStorePath(dataDir))
  const sessions = await sessionStore.list()
  return new Set(sessions.map((session) => session.id))
}

function isCanonicalCommanderId(commanderId: string, dataDir: string): boolean {
  try {
    resolveCommanderPaths(commanderId, dataDir)
    return true
  } catch {
    return false
  }
}

async function assertRegisteredCommanderId(
  dataDir: string,
  commanderId: string,
): Promise<void> {
  const persistedCommanderIds = await loadPersistedCommanderIds(dataDir)
  if (persistedCommanderIds.has(commanderId) && isCanonicalCommanderId(commanderId, dataDir)) {
    return
  }

  console.warn(
    `[commanders] Refused to persist display name for unregistered commander "${commanderId}".`,
  )
  throw new UnknownCommanderError(commanderId)
}

// Serialize read-modify-write on names.json per file path to prevent
// concurrent mutation races without cross-directory coupling.
export function withNamesLock(
  dataDir: string,
  fn: (names: Record<string, string>) => void,
): Promise<void> {
  const namesPath = resolveCommanderNamesPath(dataDir)
  const previous = namesMutexByPath.get(namesPath) ?? Promise.resolve()
  const next = previous.then(async () => {
    const { names } = await readNamesState(namesPath)
    fn(names)
    await writeNamesFile(namesPath, names)
  })

  const guarded = next.catch(() => {})
  namesMutexByPath.set(namesPath, guarded)
  return next.finally(() => {
    if (namesMutexByPath.get(namesPath) === guarded) {
      namesMutexByPath.delete(namesPath)
    }
  })
}

export function mutateCommanderDisplayName(
  dataDir: string,
  commanderId: string,
  mutate: (names: Record<string, string>) => void,
): Promise<void> {
  return withCommanderMutation(commanderId, dataDir, () => (
    withNamesLock(dataDir, mutate)
  ))
}

export async function setCommanderDisplayName(
  dataDir: string,
  commanderId: string,
  displayName: string,
): Promise<void> {
  await assertRegisteredCommanderId(dataDir, commanderId)
  await mutateCommanderDisplayName(dataDir, commanderId, (names) => {
    names[commanderId] = displayName
  })
}

export async function deleteCommanderDisplayName(
  dataDir: string,
  commanderId: string,
): Promise<void> {
  await withNamesLock(dataDir, (names) => {
    delete names[commanderId]
  })
}

export async function pruneOrphanCommanderNames(
  dataDir: string,
): Promise<PruneOrphanCommanderNamesResult> {
  const namesPath = resolveCommanderNamesPath(dataDir)
  const sessionStorePath = resolveCommanderSessionStorePath(dataDir)
  const state = await readNamesState(namesPath)
  const persistedCommanderIds = await loadPersistedCommanderIds(dataDir)
  const keptNames: Record<string, string> = {}
  const removedNames: Record<string, string> = {}

  for (const [commanderId, displayName] of Object.entries(state.names)) {
    if (persistedCommanderIds.has(commanderId)) {
      keptNames[commanderId] = displayName
      continue
    }
    removedNames[commanderId] = displayName
  }

  const removedCommanderIds = Object.keys(removedNames)
  if (state.exists && removedCommanderIds.length > 0) {
    await writeNamesFile(namesPath, keptNames)
  }

  return {
    namesPath,
    sessionStorePath,
    totalBefore: Object.keys(state.names).length,
    totalAfter: Object.keys(keptNames).length,
    keptCommanderIds: Object.keys(keptNames),
    removedCommanderIds,
    removedNames,
  }
}
