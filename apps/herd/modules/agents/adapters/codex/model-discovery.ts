import type {
  ProviderModelDiscoveryContext,
  ProviderModelDiscoveryResult,
  ProviderModelOption,
} from '../../providers/provider-adapter.js'
import { CodexSessionRuntime } from './runtime.js'

interface CodexModelDiscoveryRuntime {
  ensureConnected(): Promise<void>
  sendRequest(method: string, params: unknown): Promise<unknown>
  teardown(options?: { reason?: string; timeoutMs?: number }): Promise<void>
}

export interface CodexModelDiscoveryDeps {
  runtimeFactory?: (context: ProviderModelDiscoveryContext) => CodexModelDiscoveryRuntime
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function reportedEffortLevels(item: Record<string, unknown>): string[] {
  const entries = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []
  const levels = entries
    .map((entry) => text(record(entry)?.reasoningEffort))
    .filter((level): level is string => Boolean(level))
  return [...new Set(levels)]
}

function modelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload
  }
  const value = record(payload)
  if (Array.isArray(value?.data)) {
    return value.data
  }
  return Array.isArray(value?.models) ? value.models : []
}

function codexAccountId(payload: unknown, fallback?: string): string | undefined {
  const contextAccountId = text(fallback)
  if (contextAccountId) {
    return contextAccountId
  }
  const account = record(record(payload)?.account)
  const type = text(account?.type)
  if (type === 'chatgpt') {
    const email = text(account?.email)
    const planType = text(account?.planType)
    return ['chatgpt', email, planType].filter(Boolean).join(':')
  }
  if (type === 'amazonBedrock') {
    return 'amazon-bedrock'
  }
  if (type === 'apiKey') {
    return 'api-key'
  }
  return undefined
}

export function parseCodexModelList(
  payload: unknown,
  accountId?: string,
): ProviderModelDiscoveryResult {
  const models = modelList(payload).flatMap((raw): ProviderModelOption[] => {
    const item = record(raw)
    if (!item) {
      return []
    }
    const runtimeModel = text(item.model) ?? text(item.id)
    if (!runtimeModel) {
      return []
    }
    const catalogId = text(item.id)
    const aliases = catalogId && catalogId !== runtimeModel ? [catalogId] : undefined
    const supportedEffortLevels = reportedEffortLevels(item)
    const reportedDefault = text(item.defaultReasoningEffort)
    const defaultEffort = reportedDefault && supportedEffortLevels.includes(reportedDefault)
      ? reportedDefault
      : undefined
    return [{
      id: runtimeModel,
      label: text(item.displayName) ?? runtimeModel,
      ...(text(item.description) ? { description: text(item.description) } : {}),
      ...(item.isDefault === true ? { default: true } : {}),
      ...(aliases ? { aliases } : {}),
      ...(item.hidden === true ? { hidden: true } : {}),
      resolvedModel: runtimeModel,
      supportsEffort: supportedEffortLevels.length > 0,
      supportedEffortLevels,
      ...(defaultEffort ? { defaultEffort } : {}),
      runtimeCompatible: true,
    }]
  })
  return {
    models,
    ...(text(accountId) ? { accountId: text(accountId) } : {}),
  }
}

function defaultRuntimeFactory(context: ProviderModelDiscoveryContext): CodexModelDiscoveryRuntime {
  return new CodexSessionRuntime(
    `provider-model-discovery-${Date.now()}`,
    undefined,
    () => [],
    30_000,
    () => {},
    undefined,
    undefined,
    context.providerAuth,
  )
}

export async function discoverCodexModels(
  context: ProviderModelDiscoveryContext,
  deps: CodexModelDiscoveryDeps = {},
): Promise<ProviderModelDiscoveryResult> {
  const runtime = (deps.runtimeFactory ?? defaultRuntimeFactory)(context)
  let teardownPromise: Promise<void> | null = null
  const teardown = () => {
    teardownPromise ??= runtime.teardown({
      reason: 'Codex model discovery complete',
      timeoutMs: 5_000,
    }).catch(() => undefined)
    return teardownPromise
  }
  const handleAbort = () => {
    void teardown()
  }
  context.signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    await runtime.ensureConnected()
    const data: unknown[] = []
    const seenCursors = new Set<string>()
    const [firstPage, account] = await Promise.all([
      runtime.sendRequest('model/list', {}),
      runtime.sendRequest('account/read', { refreshToken: false }),
    ])
    data.push(...modelList(firstPage))
    let cursor = text(record(firstPage)?.nextCursor)
    do {
      if (!cursor || seenCursors.has(cursor)) {
        break
      }
      seenCursors.add(cursor)
      const payload = await runtime.sendRequest('model/list', { cursor })
      data.push(...modelList(payload))
      cursor = text(record(payload)?.nextCursor)
    } while (cursor)
    return parseCodexModelList({ data }, codexAccountId(account, context.accountId))
  } finally {
    context.signal?.removeEventListener('abort', handleAbort)
    await teardown()
  }
}
