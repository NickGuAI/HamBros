import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface ClaudeCodeOtelEnvVars {
  CLAUDE_CODE_ENABLE_TELEMETRY: string
  OTEL_EXPORTER_OTLP_ENDPOINT: string
  OTEL_EXPORTER_OTLP_PROTOCOL: string
  OTEL_EXPORTER_OTLP_HEADERS: string
  OTEL_METRICS_EXPORTER: string
  OTEL_LOGS_EXPORTER: string
  OTEL_METRIC_EXPORT_INTERVAL: string
  OTEL_LOG_USER_PROMPTS: string
}

/** Keys that the old onboarding flow wrote — cleaned up during re-onboard. */
const LEGACY_KEYS = ['HAMMURABI_ENDPOINT', 'HAMMURABI_API_KEY'] as const

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

export function defaultClaudeSettingsPath(): string {
  return path.join(homedir(), '.claude', 'settings.json')
}

export function buildClaudeCodeOtelEnv(endpoint: string, apiKey: string): ClaudeCodeOtelEnvVars {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: `x-hammurabi-api-key=${apiKey}`,
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '5000',
    OTEL_LOG_USER_PROMPTS: '1',
  }
}

export async function mergeClaudeCodeEnv(
  vars: ClaudeCodeOtelEnvVars,
  settingsPath: string = defaultClaudeSettingsPath(),
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

  const currentEnv = isObject(existing.env) ? { ...existing.env } : {}

  // Remove legacy keys from previous onboarding
  for (const key of LEGACY_KEYS) {
    delete currentEnv[key]
  }

  existing.env = {
    ...currentEnv,
    ...vars,
  }

  await mkdir(path.dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}
