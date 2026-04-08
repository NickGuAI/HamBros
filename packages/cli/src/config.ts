import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const HAMMURABI_CONFIG_FILENAME = '.hammurabi.json'

export const HAMMURABI_AGENTS = [
  'claude-code',
  'codex',
  'terminal-cri',
  'cursor',
  'anti-gravity',
] as const

export type HammurabiAgent = (typeof HAMMURABI_AGENTS)[number]

export interface HammurabiConfig {
  endpoint: string
  apiKey: string
  agents: HammurabiAgent[]
  configuredAt: string
}

interface CreateConfigInput {
  endpoint: string
  apiKey: string
  agents: readonly HammurabiAgent[]
  configuredAt?: Date
}

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

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/u, '')
}

export function isHammurabiAgent(value: string): value is HammurabiAgent {
  return HAMMURABI_AGENTS.includes(value as HammurabiAgent)
}

export function defaultConfigPath(): string {
  return path.join(homedir(), HAMMURABI_CONFIG_FILENAME)
}

export function createHammurabiConfig(input: CreateConfigInput): HammurabiConfig {
  const endpoint = normalizeEndpoint(input.endpoint)
  const apiKey = input.apiKey.trim()
  const agents = [...new Set(input.agents)]

  if (!endpoint) {
    throw new Error('endpoint is required')
  }
  if (!apiKey) {
    throw new Error('apiKey is required')
  }
  if (agents.length === 0) {
    throw new Error('at least one agent must be selected')
  }

  return {
    endpoint,
    apiKey,
    agents,
    configuredAt: (input.configuredAt ?? new Date()).toISOString(),
  }
}

function parseConfig(value: unknown): HammurabiConfig | null {
  if (!isObject(value)) {
    return null
  }

  const endpoint = typeof value.endpoint === 'string' ? normalizeEndpoint(value.endpoint) : ''
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  const configuredAt = typeof value.configuredAt === 'string' ? value.configuredAt : ''
  const agents = value.agents

  if (!endpoint || !apiKey || !configuredAt || !Array.isArray(agents)) {
    return null
  }

  if (!agents.every((agent) => typeof agent === 'string' && isHammurabiAgent(agent))) {
    return null
  }

  return {
    endpoint,
    apiKey,
    agents,
    configuredAt,
  }
}

export async function readHammurabiConfig(
  configPath: string = defaultConfigPath(),
): Promise<HammurabiConfig | null> {
  let raw: string

  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }

  return parseConfig(parsed)
}

export async function writeHammurabiConfig(
  config: HammurabiConfig,
  configPath: string = defaultConfigPath(),
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
