import { defaultApiKeyStorePath } from './store.js'

export const BOOTSTRAP_MASTER_KEY_ENV = 'HERD_BOOTSTRAP_MASTER_KEY'
export const HERD_BOOTSTRAP_MASTER_KEY_ENV = 'HERD_BOOTSTRAP_MASTER_KEY'
export const BOOTSTRAP_MASTER_KEY_EXPIRES_IN_HOURS = 24
export const BOOTSTRAP_MASTER_KEY_MIN_BYTES = 32

interface BootstrapApiKeyStoreLike {
  hasAnyKeys(): Promise<boolean>
  canSeedDefaultKey(): Promise<boolean>
  seedDefaultKey(rawKey: string, label?: string, now?: Date): Promise<string | null>
}

interface BootstrapDefaultMasterKeyOptions {
  env?: NodeJS.ProcessEnv
  keystorePath?: string
  logWarn?: (message: string) => void
}

function resolveConfiguredBootstrapKey(env: NodeJS.ProcessEnv): string | null {
  const canonical = env[BOOTSTRAP_MASTER_KEY_ENV]?.trim() || null
  const herdAlias = env[HERD_BOOTSTRAP_MASTER_KEY_ENV]?.trim() || null

  if (canonical && herdAlias && canonical !== herdAlias) {
    throw new Error(
      `${BOOTSTRAP_MASTER_KEY_ENV} and ${HERD_BOOTSTRAP_MASTER_KEY_ENV} are both set but do not match.`,
    )
  }

  const configured = canonical ?? herdAlias
  if (configured && Buffer.byteLength(configured, 'utf8') < BOOTSTRAP_MASTER_KEY_MIN_BYTES) {
    throw new Error(
      `${BOOTSTRAP_MASTER_KEY_ENV} must contain at least ${BOOTSTRAP_MASTER_KEY_MIN_BYTES} bytes.`,
    )
  }

  return configured
}

/**
 * Seeds an operator-provided bootstrap key exactly once for a genuinely fresh
 * keystore. The store persists only the key hash and a consumed marker; the
 * plaintext secret remains in the operator's environment and is never logged
 * or written to a recovery file by the server.
 */
export async function bootstrapDefaultMasterKey(
  store: BootstrapApiKeyStoreLike,
  options: BootstrapDefaultMasterKeyOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env
  const keystorePath = options.keystorePath ?? defaultApiKeyStorePath()
  const logWarn = options.logWarn ?? (() => {})
  const rawKey = resolveConfiguredBootstrapKey(env)

  if (!rawKey) {
    const hasKeys = await store.hasAnyKeys()
    if (!hasKeys && await store.canSeedDefaultKey()) {
      logWarn(`[api-keys] Keystore is empty: ${keystorePath}`)
      logWarn(
        `[api-keys] No bootstrap master key was seeded. Configure ${BOOTSTRAP_MASTER_KEY_ENV} `
        + `(or ${HERD_BOOTSTRAP_MASTER_KEY_ENV}) before the first boot.`,
      )
    } else if (!hasKeys) {
      logWarn(
        `[api-keys] Keystore initialization was already consumed at ${keystorePath}; `
        + 'bootstrap access will not be recreated.',
      )
    }
    return null
  }

  const seeded = await store.seedDefaultKey(rawKey, 'Bootstrap Master Key', new Date())
  if (!seeded) {
    return null
  }

  logWarn(
    `[api-keys] Seeded the configured one-time bootstrap master key in ${keystorePath}.`,
  )
  logWarn(
    `[api-keys] Sign in once, create a permanent API key, then rotate or revoke the bootstrap key. `
    + `It expires after ${BOOTSTRAP_MASTER_KEY_EXPIRES_IN_HOURS} hours.`,
  )
  return seeded
}
