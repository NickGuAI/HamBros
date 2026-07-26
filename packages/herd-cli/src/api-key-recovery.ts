import { homedir } from 'node:os'
import path from 'node:path'
import { defaultConfigPath, normalizeEndpoint } from './config.js'

export const BOOTSTRAP_MASTER_KEY_ENV = 'HERD_BOOTSTRAP_MASTER_KEY'

export function defaultKeystorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HERD_DATA_DIR?.trim()
  const dataDir = configured && configured.length > 0
    ? path.resolve(configured)
    : path.join(homedir(), '.herd')

  return path.join(dataDir, 'api-keys', 'keys.json')
}

export function formatStoredApiKeyUnauthorizedMessage(input: {
  endpoint: string
  configPath?: string
  keystorePath?: string
}): string {
  const configPath = input.configPath ?? defaultConfigPath()
  const keystorePath = input.keystorePath ?? defaultKeystorePath()
  const endpoint = normalizeEndpoint(input.endpoint)

  return [
    `Stored API key in ${configPath} was rejected by ${endpoint} (401 Unauthorized).`,
    `The Herd keystore is likely empty or rotated: ${keystorePath}.`,
    'Restore the keystore or configure this CLI with a valid permanent API key.',
    `Bootstrap access cannot be recreated after keystore initialization; on a genuinely fresh server only, set ${BOOTSTRAP_MASTER_KEY_ENV} to an operator-generated secret of at least 32 bytes before first boot.`,
  ].join(' ')
}
