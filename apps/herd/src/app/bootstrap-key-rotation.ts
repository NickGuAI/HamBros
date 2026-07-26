import type { ApiKeyScopeCatalog, ApiKeyView } from '@/hooks/use-api-keys'

export interface BootstrapKeyRotationState {
  shouldPrompt: boolean
  expiresAt: string | null
  keyName: string | null
  keyId: string | null
}

function sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  const rightScopes = new Set(right)
  return left.every((scope) => rightScopes.has(scope))
}

function getExpiryTime(expiresAt: string | null): number | null {
  if (!expiresAt) {
    return null
  }

  const timestamp = Date.parse(expiresAt)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function getBootstrapKeyRotationState(
  keys: readonly ApiKeyView[],
  scopeCatalog: Pick<ApiKeyScopeCatalog, 'defaultBootstrapScopes'> | null | undefined,
  now: Date = new Date(),
): BootstrapKeyRotationState {
  const bootstrapScopes = scopeCatalog?.defaultBootstrapScopes ?? []
  if (bootstrapScopes.length === 0) {
    return { shouldPrompt: false, expiresAt: null, keyName: null, keyId: null }
  }

  const hasPermanentBootstrapEquivalent = keys.some((key) => (
    key.purpose === 'permanent' &&
    !key.expiresAt &&
    sameScopeSet(key.scopes, bootstrapScopes)
  ))
  if (hasPermanentBootstrapEquivalent) {
    return { shouldPrompt: false, expiresAt: null, keyName: null, keyId: null }
  }

  const nowMs = now.getTime()
  const activeSystemBootstrapKeys = keys
    .map((key) => ({
      key,
      expiresAtMs: getExpiryTime(key.expiresAt),
    }))
    .filter(({ key, expiresAtMs }) => (
      key.purpose === 'bootstrap' &&
      expiresAtMs !== null &&
      expiresAtMs > nowMs &&
      sameScopeSet(key.scopes, bootstrapScopes)
    ))
    .sort((left, right) => (left.expiresAtMs ?? 0) - (right.expiresAtMs ?? 0))

  const expiringKey = activeSystemBootstrapKeys[0]?.key
  return {
    shouldPrompt: Boolean(expiringKey),
    expiresAt: expiringKey?.expiresAt ?? null,
    keyName: expiringKey?.name ?? null,
    keyId: expiringKey?.id ?? null,
  }
}
