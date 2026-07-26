import type {
  ProviderAdapter,
  ProviderModelDiscoveryContext,
  ProviderModelDiscoveryMetadata,
  ProviderModelOption,
  ResolvedProviderModels,
} from './provider-adapter.js'

export const DEFAULT_PROVIDER_MODEL_CACHE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_PROVIDER_MODEL_REFRESH_RATE_LIMIT_MS = 30 * 1000
export const DEFAULT_PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = 20 * 1000

interface ProviderModelCacheEntry {
  source: 'dynamic' | 'static-fallback'
  models: ProviderModelOption[]
  fetchedAtMs: number | null
  expiresAtMs: number | null
  refreshAllowedAtMs: number | null
  credentialPoolId?: string
  accountId?: string
  error: string | null
}

export interface ResolveProviderModelsOptions {
  forceRefresh?: boolean
  skipDiscovery?: boolean
  nowMs?: number
  ttlMs?: number
  refreshRateLimitMs?: number
  discoveryTimeoutMs?: number
}

export class ProviderModelRefreshRateLimitError extends Error {
  constructor(readonly retryAt: string) {
    super(`Model discovery refresh is rate limited until ${retryAt}`)
    this.name = 'ProviderModelRefreshRateLimitError'
  }
}

const modelCache = new Map<string, ProviderModelCacheEntry>()
const latestCacheKeyByCredentialScope = new Map<string, string>()
const discoveryInFlight = new Map<string, Promise<ResolvedProviderModels>>()
const lastRefreshAttemptMs = new Map<string, number>()
const providerWideFailureKeys = new Map<string, Set<string>>()

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function uniqueStrings(values: readonly unknown[]): string[] | undefined {
  const unique = [...new Set(values.map(trimmed).filter((value): value is string => Boolean(value)))]
  return unique.length > 0 ? unique : undefined
}

function normalizeModelOption(option: ProviderModelOption): ProviderModelOption | null {
  const id = trimmed(option.id)
  if (!id) {
    return null
  }
  const label = trimmed(option.label) ?? id
  const aliases = uniqueStrings(option.aliases ?? [])?.filter((alias) => alias !== id)
  const supportedEffortLevels = uniqueStrings(option.supportedEffortLevels ?? [])
  return {
    id,
    label,
    ...(trimmed(option.description) ? { description: trimmed(option.description) } : {}),
    ...(option.default !== undefined ? { default: option.default } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(option.hidden !== undefined ? { hidden: option.hidden } : {}),
    ...(option.deprecated !== undefined ? { deprecated: option.deprecated } : {}),
    ...(option.runtimeCompatible !== undefined ? { runtimeCompatible: option.runtimeCompatible } : {}),
    ...(trimmed(option.resolvedModel) ? { resolvedModel: trimmed(option.resolvedModel) } : {}),
    ...(option.supportsEffort !== undefined ? { supportsEffort: option.supportsEffort } : {}),
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    ...(trimmed(option.defaultEffort) ? { defaultEffort: trimmed(option.defaultEffort) } : {}),
    ...(option.supportsAdaptiveThinking !== undefined
      ? { supportsAdaptiveThinking: option.supportsAdaptiveThinking }
      : {}),
  }
}

function normalizeModelOptions(models: unknown): ProviderModelOption[] {
  if (!Array.isArray(models)) {
    return []
  }
  const normalized: ProviderModelOption[] = []
  for (const model of models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      continue
    }
    const option = normalizeModelOption(model as ProviderModelOption)
    if (option) {
      normalized.push(option)
    }
  }
  return normalized
}

function findCuratedOverlay(
  discovered: ProviderModelOption,
  curatedModels: readonly ProviderModelOption[],
): ProviderModelOption | undefined {
  const discoveredCanonicalIds = new Set([
    discovered.id,
    ...(discovered.resolvedModel ? [discovered.resolvedModel] : []),
  ])
  return curatedModels.find((curated) => {
    return discoveredCanonicalIds.has(curated.id)
      || Boolean(curated.resolvedModel && discoveredCanonicalIds.has(curated.resolvedModel))
      || (!discovered.resolvedModel && curated.aliases?.includes(discovered.id) === true)
  })
}

function visibleCompatibleModels(models: unknown): ProviderModelOption[] {
  const seen = new Set<string>()
  const resolved: ProviderModelOption[] = []
  for (const normalized of normalizeModelOptions(models)) {
    if (
      normalized.hidden === true
      || normalized.runtimeCompatible === false
      || seen.has(normalized.id)
    ) {
      continue
    }
    seen.add(normalized.id)
    resolved.push(normalized)
  }
  return resolved
}

export function applyProviderModelCuration(
  discoveredModels: readonly ProviderModelOption[],
  curatedModels: unknown,
  options: { includeUnmatchedCuratedModels?: boolean } = {},
): ProviderModelOption[] {
  const normalizedCuratedModels = normalizeModelOptions(curatedModels)
  const matchedCuratedModels = new Set<ProviderModelOption>()
  const merged = discoveredModels.map((discovered) => {
    const overlay = findCuratedOverlay(discovered, normalizedCuratedModels)
    if (!overlay) {
      return discovered
    }
    matchedCuratedModels.add(overlay)
    const aliases = uniqueStrings([
      ...(discovered.aliases ?? []),
      ...(overlay.aliases ?? []),
      ...(overlay.id !== discovered.id ? [overlay.id] : []),
    ])
    return {
      ...discovered,
      label: overlay.label || discovered.label,
      ...(overlay.description !== undefined ? { description: overlay.description } : {}),
      ...(overlay.default !== undefined ? { default: overlay.default } : {}),
      ...(overlay.hidden !== undefined ? { hidden: overlay.hidden } : {}),
      ...(overlay.deprecated !== undefined ? { deprecated: overlay.deprecated } : {}),
      ...(overlay.runtimeCompatible !== undefined
        ? { runtimeCompatible: overlay.runtimeCompatible }
        : {}),
      ...(discovered.supportsEffort !== undefined
        ? { supportsEffort: discovered.supportsEffort }
        : overlay.supportsEffort !== undefined
          ? { supportsEffort: overlay.supportsEffort }
          : {}),
      ...(discovered.supportedEffortLevels !== undefined
        ? { supportedEffortLevels: discovered.supportedEffortLevels }
        : overlay.supportedEffortLevels !== undefined
          ? { supportedEffortLevels: overlay.supportedEffortLevels }
          : {}),
      ...(discovered.defaultEffort !== undefined
        ? { defaultEffort: discovered.defaultEffort }
        : overlay.defaultEffort !== undefined
          ? { defaultEffort: overlay.defaultEffort }
          : {}),
      ...(discovered.supportsAdaptiveThinking !== undefined
        ? { supportsAdaptiveThinking: discovered.supportsAdaptiveThinking }
        : overlay.supportsAdaptiveThinking !== undefined
          ? { supportsAdaptiveThinking: overlay.supportsAdaptiveThinking }
          : {}),
      ...(aliases ? { aliases } : {}),
      ...(discovered.resolvedModel
        ? { resolvedModel: discovered.resolvedModel }
        : overlay.resolvedModel
          ? { resolvedModel: overlay.resolvedModel }
          : {}),
    }
  })
  if (!options.includeUnmatchedCuratedModels) {
    return visibleCompatibleModels(merged)
  }

  const completed = visibleCompatibleModels(merged)
  const claimedIdentifiers = new Set(completed.flatMap((model) => [
    model.id,
    ...(model.aliases ?? []),
    ...(model.resolvedModel ? [model.resolvedModel] : []),
  ]))
  let hasDefault = completed.some((model) => model.default === true)
  for (const model of normalizedCuratedModels) {
    if (
      matchedCuratedModels.has(model)
      || model.hidden === true
      || model.deprecated === true
      || model.runtimeCompatible === false
      || claimedIdentifiers.has(model.id)
      || Boolean(model.resolvedModel && claimedIdentifiers.has(model.resolvedModel))
    ) {
      continue
    }
    const aliases = (model.aliases ?? []).filter((alias) => !claimedIdentifiers.has(alias))
    const appended = { ...model }
    if (aliases.length > 0) {
      appended.aliases = aliases
    } else {
      delete appended.aliases
    }
    if (hasDefault && appended.default === true) {
      delete appended.default
    }
    completed.push(appended)
    hasDefault ||= appended.default === true
    claimedIdentifiers.add(appended.id)
    for (const alias of aliases) {
      claimedIdentifiers.add(alias)
    }
    if (appended.resolvedModel) {
      claimedIdentifiers.add(appended.resolvedModel)
    }
  }
  return visibleCompatibleModels(completed)
}

function providerCacheKey(
  provider: ProviderAdapter,
  context: Pick<ProviderModelDiscoveryContext, 'credentialPoolId' | 'accountId'>,
): string {
  if (provider.modelDiscovery?.catalogScope === 'provider') {
    return JSON.stringify([provider.id, 'provider-wide'])
  }
  return JSON.stringify([
    provider.id,
    trimmed(context.credentialPoolId) ?? 'default-pool',
    trimmed(context.accountId) ?? 'default-account',
  ])
}

function providerCredentialScopeKey(
  provider: ProviderAdapter,
  context: Pick<ProviderModelDiscoveryContext, 'credentialPoolId' | 'accountId'>,
): string {
  if (provider.modelDiscovery?.catalogScope === 'provider') {
    return JSON.stringify([
      provider.id,
      'provider-wide-attempt',
      trimmed(context.credentialPoolId) ?? 'default-pool',
      trimmed(context.accountId) ?? 'default-account',
    ])
  }
  return JSON.stringify([
    provider.id,
    trimmed(context.credentialPoolId) ?? 'default-pool',
  ])
}

function providerDiscoveryAttemptKey(
  provider: ProviderAdapter,
  context: Pick<ProviderModelDiscoveryContext, 'credentialPoolId' | 'accountId'>,
): string {
  return provider.modelDiscovery?.catalogScope === 'provider'
    ? providerCredentialScopeKey(provider, context)
    : providerCacheKey(provider, context)
}

function rememberProviderWideFailureKey(provider: ProviderAdapter, key: string): void {
  const keys = providerWideFailureKeys.get(provider.id) ?? new Set<string>()
  keys.add(key)
  providerWideFailureKeys.set(provider.id, keys)
}

function clearProviderWideFailures(provider: ProviderAdapter): void {
  const keys = providerWideFailureKeys.get(provider.id)
  if (!keys) {
    return
  }
  for (const key of keys) {
    modelCache.delete(key)
    lastRefreshAttemptMs.delete(key)
  }
  for (const [scopeKey, cacheKey] of latestCacheKeyByCredentialScope) {
    if (keys.has(cacheKey)) {
      latestCacheKeyByCredentialScope.delete(scopeKey)
    }
  }
  providerWideFailureKeys.delete(provider.id)
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function projectCacheEntry(entry: ProviderModelCacheEntry, nowMs: number): ResolvedProviderModels {
  const stale = entry.source === 'dynamic' && (
    entry.error !== null
    || (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs)
  )
  const discovery: ProviderModelDiscoveryMetadata = entry.source === 'dynamic'
    ? {
        source: stale ? 'stale-cache' : 'dynamic',
        freshness: stale ? 'stale' : 'fresh',
        fetchedAt: iso(entry.fetchedAtMs),
        expiresAt: iso(entry.expiresAtMs),
        refreshAllowedAt: iso(entry.refreshAllowedAtMs),
        error: entry.error,
        credentialPoolId: entry.credentialPoolId ?? null,
        accountId: entry.accountId ?? null,
      }
    : {
        source: 'static-fallback',
        freshness: 'fallback',
        fetchedAt: null,
        expiresAt: null,
        refreshAllowedAt: iso(entry.refreshAllowedAtMs),
        error: entry.error,
        credentialPoolId: entry.credentialPoolId ?? null,
        accountId: entry.accountId ?? null,
      }
  return {
    models: entry.models.map((model) => ({ ...model })),
    discovery,
    supportsCustomModels: false,
  }
}

function staticFallback(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext,
  options: {
    error?: string | null
    refreshAllowedAtMs?: number | null
  } = {},
): ResolvedProviderModels {
  const providerWide = provider.modelDiscovery?.catalogScope === 'provider'
  return {
    models: visibleCompatibleModels(provider.availableModels),
    discovery: {
      source: 'static-fallback',
      freshness: 'fallback',
      fetchedAt: null,
      expiresAt: null,
      refreshAllowedAt: iso(options.refreshAllowedAtMs ?? null),
      error: options.error ?? null,
      credentialPoolId: providerWide ? null : trimmed(context.credentialPoolId) ?? null,
      accountId: providerWide ? null : trimmed(context.accountId) ?? null,
    },
    supportsCustomModels: provider.modelDiscovery?.allowCustomModels === true,
  }
}

function sanitizeDiscoveryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutSecrets = raw.replace(/\b[A-Z0-9_]*(?:TOKEN|KEY|SECRET)[A-Z0-9_]*=\S+/giu, '[redacted]')
  const withoutPaths = withoutSecrets.replace(/(?:^|\s)(?:~|\/[\w.@+-]+)(?:\/[\w.@+-]+)+/gu, ' [path]')
  return (withoutPaths.trim() || 'Provider model discovery failed').slice(0, 300)
}

function cachedEntryFor(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext,
): { key: string; entry: ProviderModelCacheEntry | undefined } {
  const baseKey = providerCacheKey(provider, context)
  const attemptKey = providerDiscoveryAttemptKey(provider, context)
  return {
    key: attemptKey,
    entry: modelCache.get(attemptKey) ?? modelCache.get(baseKey),
  }
}

export function getCachedProviderModels(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext = {},
  nowMs = Date.now(),
): ResolvedProviderModels {
  const { entry } = cachedEntryFor(provider, context)
  if (!entry) {
    return staticFallback(provider, context)
  }
  const projected = projectCacheEntry(entry, nowMs)
  projected.supportsCustomModels = provider.modelDiscovery?.allowCustomModels === true
  return projected
}

export function getCachedProviderModelsForValidation(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext = {},
  nowMs = Date.now(),
): ResolvedProviderModels {
  const exact = cachedEntryFor(provider, context).entry
  if (context.accountId && !exact) {
    return staticFallback(provider, context)
  }
  const latestKey = latestCacheKeyByCredentialScope.get(
    providerCredentialScopeKey(provider, context),
  )
  const entry = exact ?? (latestKey ? modelCache.get(latestKey) : undefined)
  if (!entry) {
    return staticFallback(provider, context)
  }
  const projected = projectCacheEntry(entry, nowMs)
  projected.supportsCustomModels = provider.modelDiscovery?.allowCustomModels === true
  return projected
}

export async function resolveProviderModels(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext = {},
  options: ResolveProviderModelsOptions = {},
): Promise<ResolvedProviderModels> {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_PROVIDER_MODEL_CACHE_TTL_MS
  const refreshRateLimitMs = options.refreshRateLimitMs
    ?? DEFAULT_PROVIDER_MODEL_REFRESH_RATE_LIMIT_MS
  const discoveryTimeoutMs = options.discoveryTimeoutMs
    ?? DEFAULT_PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS
  const adapter = provider.modelDiscovery
  if (!adapter || options.skipDiscovery) {
    return staticFallback(provider, context)
  }

  const baseKey = providerCacheKey(provider, context)
  const key = providerDiscoveryAttemptKey(provider, context)
  const cached = modelCache.get(key) ?? modelCache.get(baseKey)
  const inFlight = discoveryInFlight.get(key)
  if (inFlight) {
    return await inFlight
  }

  if (!options.forceRefresh && cached) {
    const cacheIsReusable = (
      cached.expiresAtMs === null
      || cached.expiresAtMs > nowMs
      || (cached.error !== null && (cached.refreshAllowedAtMs ?? 0) > nowMs)
    )
    if (cacheIsReusable) {
      const projected = projectCacheEntry(cached, nowMs)
      projected.supportsCustomModels = adapter.allowCustomModels === true
      return projected
    }
  }

  const previousAttempt = lastRefreshAttemptMs.get(key) ?? 0
  const retryAtMs = previousAttempt + refreshRateLimitMs
  if (options.forceRefresh && previousAttempt > 0 && retryAtMs > nowMs) {
    throw new ProviderModelRefreshRateLimitError(new Date(retryAtMs).toISOString())
  }
  if (!options.forceRefresh && !cached && previousAttempt > 0 && retryAtMs > nowMs) {
    return staticFallback(provider, context, {
      error: 'Model discovery is waiting for the retry window',
      refreshAllowedAtMs: retryAtMs,
    })
  }

  const refreshAllowedAtMs = nowMs + refreshRateLimitMs
  lastRefreshAttemptMs.set(key, nowMs)
  const discovery = (async (): Promise<ResolvedProviderModels> => {
    try {
      if (context.unavailableReason) {
        throw new Error(context.unavailableReason)
      }
      const abortController = new AbortController()
      const timeout = setTimeout(() => abortController.abort(), discoveryTimeoutMs)
      const discovered = await Promise.race([
        adapter.discover({ ...context, signal: abortController.signal }),
        new Promise<never>((_resolve, reject) => {
          abortController.signal.addEventListener('abort', () => {
            reject(new Error(`Provider model discovery timed out after ${discoveryTimeoutMs}ms`))
          }, { once: true })
        }),
      ]).finally(() => clearTimeout(timeout))
      const models = adapter.authoritativeDynamicModels === true
        ? visibleCompatibleModels(discovered.models)
        : applyProviderModelCuration(discovered.models, provider.availableModels, {
            includeUnmatchedCuratedModels: adapter.includeUnmatchedCuratedModels === true,
          })
      if (models.length === 0) {
        throw new Error('Provider model discovery returned no compatible models')
      }
      const providerWide = adapter.catalogScope === 'provider'
      const accountId = providerWide
        ? undefined
        : trimmed(context.accountId) ?? trimmed(discovered.accountId)
      const effectiveContext = providerWide
        ? {}
        : {
            credentialPoolId: trimmed(context.credentialPoolId),
            accountId,
          }
      const effectiveKey = providerCacheKey(provider, effectiveContext)
      const entry: ProviderModelCacheEntry = {
        source: 'dynamic',
        models,
        fetchedAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        refreshAllowedAtMs,
        ...(effectiveContext.credentialPoolId
          ? { credentialPoolId: effectiveContext.credentialPoolId }
          : {}),
        ...(accountId ? { accountId } : {}),
        error: null,
      }
      modelCache.set(effectiveKey, entry)
      if (providerWide) {
        clearProviderWideFailures(provider)
      }
      lastRefreshAttemptMs.set(key, nowMs)
      latestCacheKeyByCredentialScope.set(
        providerCredentialScopeKey(provider, effectiveContext),
        effectiveKey,
      )
      // Do not alias an account-less key to a discovered account. Native CLI
      // logins can change outside Herd, and reusing that broad alias would
      // leak the prior account's catalog until TTL expiry.
      if (effectiveKey === baseKey) {
        modelCache.set(baseKey, entry)
      }
      const projected = projectCacheEntry(entry, nowMs)
      projected.supportsCustomModels = adapter.allowCustomModels === true
      return projected
    } catch (error) {
      const message = sanitizeDiscoveryError(error)
      const concurrentlyPublished = adapter.catalogScope === 'provider'
        ? modelCache.get(baseKey)
        : undefined
      if (
        concurrentlyPublished?.source === 'dynamic'
        && concurrentlyPublished !== cached
        && concurrentlyPublished.error === null
      ) {
        const projected = projectCacheEntry(concurrentlyPublished, nowMs)
        projected.supportsCustomModels = adapter.allowCustomModels === true
        return projected
      }
      if (cached?.source === 'dynamic') {
        const failedEntry = adapter.catalogScope === 'provider'
          ? { ...cached, error: message, refreshAllowedAtMs }
          : cached
        failedEntry.error = message
        failedEntry.refreshAllowedAtMs = refreshAllowedAtMs
        if (adapter.catalogScope === 'provider') {
          modelCache.set(key, failedEntry)
          rememberProviderWideFailureKey(provider, key)
          latestCacheKeyByCredentialScope.set(providerCredentialScopeKey(provider, context), key)
        }
        const projected = projectCacheEntry(failedEntry, nowMs)
        projected.supportsCustomModels = adapter.allowCustomModels === true
        return projected
      }
      const fallbackEntry: ProviderModelCacheEntry = {
        source: 'static-fallback',
        models: visibleCompatibleModels(provider.availableModels),
        fetchedAtMs: null,
        expiresAtMs: refreshAllowedAtMs,
        refreshAllowedAtMs,
        ...(adapter.catalogScope !== 'provider' && trimmed(context.credentialPoolId)
          ? { credentialPoolId: trimmed(context.credentialPoolId) }
          : {}),
        ...(adapter.catalogScope !== 'provider' && trimmed(context.accountId)
          ? { accountId: trimmed(context.accountId) }
          : {}),
        error: message,
      }
      modelCache.set(key, fallbackEntry)
      if (adapter.catalogScope === 'provider') {
        rememberProviderWideFailureKey(provider, key)
      }
      latestCacheKeyByCredentialScope.set(
        providerCredentialScopeKey(provider, context),
        key,
      )
      const projected = projectCacheEntry(fallbackEntry, nowMs)
      projected.supportsCustomModels = adapter.allowCustomModels === true
      return projected
    } finally {
      discoveryInFlight.delete(key)
    }
  })()
  discoveryInFlight.set(key, discovery)
  return await discovery
}

export async function refreshProviderModels(
  provider: ProviderAdapter,
  context: ProviderModelDiscoveryContext = {},
  options: Omit<ResolveProviderModelsOptions, 'forceRefresh'> = {},
): Promise<ResolvedProviderModels> {
  return await resolveProviderModels(provider, context, { ...options, forceRefresh: true })
}

export function clearProviderModelDiscoveryCache(): void {
  modelCache.clear()
  latestCacheKeyByCredentialScope.clear()
  discoveryInFlight.clear()
  lastRefreshAttemptMs.clear()
  providerWideFailureKeys.clear()
}
