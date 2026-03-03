/**
 * Normalization layer: maps parsed OTEL log records and metric data points
 * into the unified internal model that TelemetryHub understands.
 *
 * Only events that carry cost / token / model data are converted into
 * `IngestInput`; others are stored as raw OTEL records but don't create calls.
 */

import { randomUUID } from 'node:crypto'
import type { ParsedLogRecord, ParsedMetricDataPoint } from './otel-parser.js'

export interface NormalizedCall {
  id: string
  sessionId: string
  agentName: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cost: number
  durationMs: number
  currentTask: string
  timestamp: string
  eventName: string
  signal: 'logs' | 'metrics' | 'traces'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nanoToIso(nanos: string): string {
  const ms = Number(BigInt(nanos) / 1_000_000n)
  return new Date(ms).toISOString()
}

function safeNanoToIso(nanos: string, fallback: Date): string {
  try {
    if (!nanos || nanos === '0') return fallback.toISOString()
    return nanoToIso(nanos)
  } catch {
    return fallback.toISOString()
  }
}

function asNumber(value: string | number | boolean | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function asString(value: string | number | boolean | undefined): string {
  if (value === undefined) return ''
  return String(value)
}

function deriveProvider(serviceName: string): string {
  const normalized = serviceName.toLowerCase()
  if (normalized.includes('claude') || normalized.includes('anthropic')) return 'anthropic'
  if (normalized.includes('codex') || normalized.includes('openai')) return 'openai'
  if (normalized.includes('cursor')) return 'cursor'
  return 'unknown'
}

function asInteger(value: string | number | boolean | undefined): number {
  return Math.max(0, Math.round(asNumber(value)))
}

function readNumberAttribute(
  attributes: Record<string, string | number | boolean>,
  keys: string[],
): number {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attributes, key)) {
      return asNumber(attributes[key])
    }
  }
  return 0
}

function readStringAttribute(
  attributes: Record<string, string | number | boolean>,
  keys: string[],
): string {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attributes, key)) {
      return asString(attributes[key])
    }
  }
  return ''
}

function normalizeEventName(rawEventName: string, serviceName: string): string {
  const eventName = rawEventName.trim()
  if (eventName.length === 0 || eventName === 'unknown') return eventName || 'unknown'
  if (eventName.includes('.')) return eventName

  const normalizedServiceName = serviceName.toLowerCase()
  if (normalizedServiceName.includes('claude') || normalizedServiceName.includes('anthropic')) {
    return `claude_code.${eventName}`
  }

  return eventName
}

function isCodexResponseCompleted(
  attributes: Record<string, string | number | boolean>,
): boolean {
  const normalized = readStringAttribute(attributes, [
    'event.kind',
    'type',
    'event_type',
    'sse_type',
    'sse.event',
    'response.type',
    'response.event',
  ]).toLowerCase()

  return normalized === 'response.completed'
}

const TOKENS_PER_MILLION = 1_000_000
const GPT_PRICING = {
  inputPerMillion: 1.75,
  cachedInputPerMillion: 0.175,
  outputPerMillion: 14,
}

function isGptModel(model: string): boolean {
  return /^gpt-5\./i.test(model)
}

function codexSseCost(
  model: string,
  attributes: Record<string, string | number | boolean>,
  inputTokens: number,
  outputTokens: number,
): number {
  const explicitCost = asNumber(attributes.cost_usd)
  if (explicitCost > 0) return explicitCost
  if (!isCodexResponseCompleted(attributes)) return explicitCost
  if (!isGptModel(model)) return explicitCost

  const cachedInputTokens = asInteger(
    readNumberAttribute(attributes, [
      'cached_token_count',
      'cached_input_token_count',
      'cached_input_tokens',
      'input_cached_token_count',
      'input_cached_tokens',
    ]),
  )
  const uncachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0)

  return (
    (uncachedInputTokens * GPT_PRICING.inputPerMillion +
      cachedInputTokens * GPT_PRICING.cachedInputPerMillion +
      outputTokens * GPT_PRICING.outputPerMillion) /
    TOKENS_PER_MILLION
  )
}

// ---------------------------------------------------------------------------
// Log record normalization
// ---------------------------------------------------------------------------

/**
 * Events that carry cost/token/model data and should generate ingest calls.
 * Other events (tool_result, user_prompt, etc.) are stored but don't create calls.
 */
const CALL_EVENT_NAMES = new Set([
  'claude_code.api_request',
  'codex.api_request',
  'codex.sse_event',
])

export function normalizeLogRecord(
  record: ParsedLogRecord,
  now: Date,
): NormalizedCall | null {
  const sessionId =
    asString(record.resource['session.id']) ||
    asString(record.attributes['conversation.id'])
  const agentName = asString(record.resource['service.name']) || 'unknown'

  if (!sessionId) return null

  const eventName = normalizeEventName(record.eventName, agentName)

  if (!CALL_EVENT_NAMES.has(eventName)) {
    // Non-call events: still return a normalized record for storage but with
    // zero cost/token values so the hub can track session liveness.
    return {
      id: randomUUID(),
      sessionId,
      agentName,
      model: asString(record.attributes.model) || 'unknown',
      provider: deriveProvider(agentName),
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: asNumber(record.attributes.duration_ms),
      currentTask: asString(record.attributes.tool_name) || 'Working',
      timestamp: safeNanoToIso(record.timestampNano, now),
      eventName,
      signal: 'logs',
    }
  }

  // Claude Code: claude_code.api_request
  if (eventName === 'claude_code.api_request') {
    return {
      id: randomUUID(),
      sessionId,
      agentName,
      model: asString(record.attributes.model) || 'unknown',
      provider: deriveProvider(agentName),
      inputTokens: asInteger(record.attributes.input_tokens),
      outputTokens: asInteger(record.attributes.output_tokens),
      cost: asNumber(record.attributes.cost_usd),
      durationMs: asInteger(record.attributes.duration_ms),
      currentTask: 'Working',
      timestamp: safeNanoToIso(record.timestampNano, now),
      eventName,
      signal: 'logs',
    }
  }

  // Codex: codex.sse_event
  if (eventName === 'codex.sse_event') {
    const model = asString(record.attributes.model) || 'unknown'
    const inputTokens = asInteger(
      readNumberAttribute(record.attributes, [
        'input_token_count',
        'input_tokens',
      ]),
    )
    const outputTokens = asInteger(
      readNumberAttribute(record.attributes, [
        'output_token_count',
        'output_tokens',
      ]),
    )

    return {
      id: randomUUID(),
      sessionId,
      agentName,
      model,
      provider: deriveProvider(agentName),
      inputTokens,
      outputTokens,
      cost: codexSseCost(model, record.attributes, inputTokens, outputTokens),
      durationMs: asInteger(record.attributes.duration_ms),
      currentTask: 'Working',
      timestamp: safeNanoToIso(record.timestampNano, now),
      eventName,
      signal: 'logs',
    }
  }

  // Codex: codex.api_request
  if (eventName === 'codex.api_request') {
    return {
      id: randomUUID(),
      sessionId,
      agentName,
      model: asString(record.attributes.model) || 'unknown',
      provider: deriveProvider(agentName),
      inputTokens: asInteger(record.attributes.input_tokens),
      outputTokens: asInteger(record.attributes.output_tokens),
      cost: asNumber(record.attributes.cost_usd),
      durationMs: asInteger(record.attributes.duration_ms),
      currentTask: 'Working',
      timestamp: safeNanoToIso(record.timestampNano, now),
      eventName,
      signal: 'logs',
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Metric data point normalization
// ---------------------------------------------------------------------------

export function normalizeMetricDataPoint(
  dataPoint: ParsedMetricDataPoint,
  now: Date,
): NormalizedCall | null {
  const sessionId =
    asString(dataPoint.resource['session.id']) ||
    asString(dataPoint.attributes['conversation.id'])
  const agentName = asString(dataPoint.resource['service.name']) || 'unknown'

  if (!sessionId) return null

  const metricName = dataPoint.metricName
  const model = asString(dataPoint.attributes.model) || 'unknown'

  // claude_code.cost.usage and claude_code.token.usage use CUMULATIVE
  // aggregation temporality — each export reports a running total since process
  // start, not a delta.  Log events (claude_code.api_request) already carry
  // per-request cost/token deltas, so using metrics for aggregation would
  // double-count.  We treat these the same as other metrics: they keep the
  // session alive but contribute zero cost/tokens.

  // All metrics (cost, token, session.count, active_time.total, etc.) — track for session liveness
  return {
    id: randomUUID(),
    sessionId,
    agentName,
    model,
    provider: deriveProvider(agentName),
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0,
    currentTask: 'Working',
    timestamp: safeNanoToIso(dataPoint.timestampNano, now),
    eventName: metricName,
    signal: 'metrics',
  }
}
