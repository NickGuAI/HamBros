/**
 * OTLP/HTTP JSON payload parser.
 *
 * Handles the three OTEL signal types (logs, metrics, traces) and extracts
 * structured records from the nested OTLP JSON envelope.
 *
 * References:
 *  - https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *  - ExportLogsServiceRequest, ExportMetricsServiceRequest, ExportTraceServiceRequest
 */

// ---------------------------------------------------------------------------
// Shared OTEL JSON types (subset needed for parsing)
// ---------------------------------------------------------------------------

export interface OtelKeyValue {
  key: string
  value: OtelAnyValue
}

export interface OtelAnyValue {
  stringValue?: string
  intValue?: string // OTEL sends 64-bit ints as strings
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values: OtelAnyValue[] }
  kvlistValue?: { values: OtelKeyValue[] }
}

export interface OtelResource {
  attributes?: OtelKeyValue[]
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface OtelLogRecord {
  timeUnixNano?: string
  observedTimeUnixNano?: string
  severityNumber?: number
  severityText?: string
  body?: OtelAnyValue
  attributes?: OtelKeyValue[]
  traceId?: string
  spanId?: string
}

export interface OtelScopeLogs {
  scope?: { name?: string; version?: string }
  logRecords?: OtelLogRecord[]
}

export interface OtelResourceLogs {
  resource?: OtelResource
  scopeLogs?: OtelScopeLogs[]
}

export interface ExportLogsServiceRequest {
  resourceLogs?: OtelResourceLogs[]
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface OtelNumberDataPoint {
  attributes?: OtelKeyValue[]
  startTimeUnixNano?: string
  timeUnixNano?: string
  asInt?: string
  asDouble?: number
}

export interface OtelMetric {
  name?: string
  description?: string
  unit?: string
  sum?: {
    dataPoints?: OtelNumberDataPoint[]
    aggregationTemporality?: number
    isMonotonic?: boolean
  }
  gauge?: {
    dataPoints?: OtelNumberDataPoint[]
  }
  histogram?: {
    dataPoints?: unknown[]
  }
}

export interface OtelScopeMetrics {
  scope?: { name?: string; version?: string }
  metrics?: OtelMetric[]
}

export interface OtelResourceMetrics {
  resource?: OtelResource
  scopeMetrics?: OtelScopeMetrics[]
}

export interface ExportMetricsServiceRequest {
  resourceMetrics?: OtelResourceMetrics[]
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export interface OtelSpan {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  name?: string
  kind?: number
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes?: OtelKeyValue[]
  status?: { code?: number; message?: string }
}

export interface OtelScopeSpans {
  scope?: { name?: string; version?: string }
  spans?: OtelSpan[]
}

export interface OtelResourceSpans {
  resource?: OtelResource
  scopeSpans?: OtelScopeSpans[]
}

export interface ExportTraceServiceRequest {
  resourceSpans?: OtelResourceSpans[]
}

// ---------------------------------------------------------------------------
// Parsed output types
// ---------------------------------------------------------------------------

export interface ParsedLogRecord {
  resource: Record<string, string | number | boolean>
  eventName: string
  attributes: Record<string, string | number | boolean>
  timestampNano: string
  severityText: string
}

export interface ParsedMetricDataPoint {
  resource: Record<string, string | number | boolean>
  metricName: string
  attributes: Record<string, string | number | boolean>
  value: number
  timestampNano: string
}

export interface ParsedSpan {
  resource: Record<string, string | number | boolean>
  name: string
  attributes: Record<string, string | number | boolean>
  startTimeNano: string
  endTimeNano: string
  traceId: string
  spanId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAnyValue(value: OtelAnyValue | undefined): string | number | boolean | undefined {
  if (!value) return undefined
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return Number(value.intValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.boolValue !== undefined) return value.boolValue
  return undefined
}

export function attributesToRecord(
  attributes: OtelKeyValue[] | undefined,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  if (!attributes) return result
  for (const { key, value } of attributes) {
    const resolved = resolveAnyValue(value)
    if (resolved !== undefined) {
      result[key] = resolved
    }
  }
  return result
}

function extractEventName(record: OtelLogRecord): string {
  // OTEL log events put the event name in body.stringValue or in an
  // attribute called "event.name" (Claude Code convention).
  const attrs = attributesToRecord(record.attributes)
  if (typeof attrs['event.name'] === 'string' && attrs['event.name'].length > 0) {
    return attrs['event.name']
  }

  // Fall back to body string
  if (record.body?.stringValue && record.body.stringValue.length > 0) {
    return record.body.stringValue
  }

  return 'unknown'
}

function dataPointValue(dp: OtelNumberDataPoint): number {
  if (dp.asDouble !== undefined) return dp.asDouble
  if (dp.asInt !== undefined) return Number(dp.asInt)
  return 0
}

// ---------------------------------------------------------------------------
// Public parsing functions
// ---------------------------------------------------------------------------

export function parseLogs(payload: ExportLogsServiceRequest): ParsedLogRecord[] {
  const results: ParsedLogRecord[] = []

  for (const resourceLogs of payload.resourceLogs ?? []) {
    const resource = attributesToRecord(resourceLogs.resource?.attributes)

    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const logRecord of scopeLogs.logRecords ?? []) {
        results.push({
          resource,
          eventName: extractEventName(logRecord),
          attributes: attributesToRecord(logRecord.attributes),
          timestampNano:
            logRecord.timeUnixNano ??
            logRecord.observedTimeUnixNano ??
            '0',
          severityText: logRecord.severityText ?? '',
        })
      }
    }
  }

  return results
}

export function parseMetrics(
  payload: ExportMetricsServiceRequest,
): ParsedMetricDataPoint[] {
  const results: ParsedMetricDataPoint[] = []

  for (const resourceMetrics of payload.resourceMetrics ?? []) {
    const resource = attributesToRecord(resourceMetrics.resource?.attributes)

    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        const metricName = metric.name ?? 'unknown'

        // Handle sum and gauge types (the main ones emitted by AI tools)
        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []

        for (const dp of dataPoints) {
          results.push({
            resource,
            metricName,
            attributes: attributesToRecord(dp.attributes),
            value: dataPointValue(dp),
            timestampNano: dp.timeUnixNano ?? '0',
          })
        }
      }
    }
  }

  return results
}

export function parseTraces(payload: ExportTraceServiceRequest): ParsedSpan[] {
  const results: ParsedSpan[] = []

  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resource = attributesToRecord(resourceSpans.resource?.attributes)

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        results.push({
          resource,
          name: span.name ?? 'unknown',
          attributes: attributesToRecord(span.attributes),
          startTimeNano: span.startTimeUnixNano ?? '0',
          endTimeNano: span.endTimeUnixNano ?? '0',
          traceId: span.traceId ?? '',
          spanId: span.spanId ?? '',
        })
      }
    }
  }

  return results
}
