import path from 'node:path'

export const COMMANDER_DATA_DIR_ENV = 'COMMANDER_DATA_DIR'
export const LEGACY_COMMANDER_DATA_DIR_ENV = 'HAMBROS_COMMANDER_MEMORY_DIR'
export const COMMANDER_MACHINE_ID_ENV = 'COMMANDER_MACHINE_ID'
export const DEFAULT_COMMANDER_DATA_DIR = path.resolve(process.cwd(), 'data/commanders')

export interface CommanderPaths {
  dataDir: string
  commanderRoot: string
  memoryRoot: string
  skillsRoot: string
}

function parseEnvPath(raw: string | undefined): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? path.resolve(trimmed) : null
}

function parseMachineId(raw: string | undefined): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.length > 0 ? normalized : null
}

export function resolveCommanderDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = parseEnvPath(env[COMMANDER_DATA_DIR_ENV])
  if (configured) {
    return configured
  }

  const legacy = parseEnvPath(env[LEGACY_COMMANDER_DATA_DIR_ENV])
  if (legacy) {
    return legacy
  }

  return DEFAULT_COMMANDER_DATA_DIR
}

export function resolveCommanderPaths(
  commanderId: string,
  basePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): CommanderPaths {
  const dataDir = basePath ? path.resolve(basePath) : resolveCommanderDataDir(env)
  const commanderRoot = path.join(dataDir, commanderId)
  const memoryRoot = path.join(commanderRoot, '.memory')
  const skillsRoot = path.join(commanderRoot, 'skills')
  return {
    dataDir,
    commanderRoot,
    memoryRoot,
    skillsRoot,
  }
}

export function resolveCommanderSessionStorePath(
  dataDir: string = resolveCommanderDataDir(),
): string {
  return path.join(path.resolve(dataDir), 'sessions.json')
}

export function resolveCommanderNamesPath(
  dataDir: string = resolveCommanderDataDir(),
): string {
  return path.join(path.resolve(dataDir), 'names.json')
}

export function resolveCommanderMachineId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    parseMachineId(env[COMMANDER_MACHINE_ID_ENV]) ??
    parseMachineId(env.HOSTNAME) ??
    'unknown-machine'
  )
}
