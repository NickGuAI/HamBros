import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'

export interface CursorOtelEnvVars {
  OTEL_EXPORTER_OTLP_ENDPOINT: string
  OTEL_EXPORTER_OTLP_PROTOCOL: string
  OTEL_EXPORTER_OTLP_HEADERS: string
}

/** Keys that the old onboarding flow wrote — cleaned up during re-onboard. */
const LEGACY_KEYS = ['HAMMURABI_ENDPOINT', 'HAMMURABI_API_KEY'] as const

type EnvPlatformKey =
  | 'terminal.integrated.env.osx'
  | 'terminal.integrated.env.linux'
  | 'terminal.integrated.env.windows'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  )
}

function envPlatformKey(): EnvPlatformKey {
  const os = platform()
  if (os === 'darwin') return 'terminal.integrated.env.osx'
  if (os === 'win32') return 'terminal.integrated.env.windows'
  return 'terminal.integrated.env.linux'
}

export function defaultCursorSettingsPath(): string {
  const home = homedir()
  const os = platform()

  if (os === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
  }
  if (os === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json')
  }
  return path.join(home, '.config', 'Cursor', 'User', 'settings.json')
}

export function buildCursorOtelEnv(endpoint: string, apiKey: string): CursorOtelEnvVars {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: `x-hammurabi-api-key=${apiKey}`,
  }
}

export async function mergeCursorEnv(
  vars: CursorOtelEnvVars,
  settingsPath: string = defaultCursorSettingsPath(),
): Promise<void> {
  let existing: Record<string, unknown> = {}

  try {
    const raw = await readFile(settingsPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isObject(parsed)) {
      existing = parsed
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // File doesn't exist yet — start fresh
    } else {
      throw error
    }
  }

  const key = envPlatformKey()
  const currentEnv = isObject(existing[key]) ? { ...existing[key] } : {}

  // Remove legacy keys from previous onboarding
  for (const legacyKey of LEGACY_KEYS) {
    delete currentEnv[legacyKey]
  }

  existing[key] = {
    ...currentEnv,
    ...vars,
  }

  await mkdir(path.dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}
