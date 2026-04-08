import path from 'node:path'

export const SENTINEL_DATA_DIR_ENV = 'SENTINEL_DATA_DIR'
export const DEFAULT_SENTINEL_DATA_DIR = path.resolve(process.cwd(), 'data/sentinels')

export function resolveSentinelDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env[SENTINEL_DATA_DIR_ENV]?.trim()
  if (configured && configured.length > 0) {
    return path.resolve(configured)
  }
  return DEFAULT_SENTINEL_DATA_DIR
}

export function resolveSentinelStorePath(
  dataDir: string = resolveSentinelDataDir(),
): string {
  return path.join(path.resolve(dataDir), 'sentinels.json')
}

export function resolveSentinelDir(
  dataDir: string,
  sentinelId: string,
): string {
  return path.join(path.resolve(dataDir), sentinelId)
}

export function resolveSentinelRunsDir(
  dataDir: string,
  sentinelId: string,
): string {
  return path.join(resolveSentinelDir(dataDir, sentinelId), 'runs')
}
