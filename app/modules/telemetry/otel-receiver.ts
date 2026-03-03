/**
 * OTEL-compliant OTLP/HTTP receiver.
 *
 * Provides `POST /v1/traces`, `POST /v1/metrics`, `POST /v1/logs` endpoints
 * that accept standard OTLP JSON payloads, parse them, normalize them into
 * the unified internal model, and feed them into the shared TelemetryHub.
 */

import express, { Router, type Request, type Response } from 'express'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import { TelemetryHub } from './hub.js'
import {
  parseLogs,
  parseMetrics,
  parseTraces,
  type ExportLogsServiceRequest,
  type ExportMetricsServiceRequest,
  type ExportTraceServiceRequest,
} from './otel-parser.js'
import {
  normalizeLogRecord,
  normalizeMetricDataPoint,
} from './normalizer.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OtelReceiverOptions {
  hub: TelemetryHub
  now?: () => Date
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * JSON body parser for OTEL routes.
 *
 * Node.js HTTP server transparently decompresses `Content-Encoding: gzip`
 * at the transport layer, so by the time Express receives the body it is
 * already raw JSON.  We mount our own `express.json()` so the OTEL router
 * does not depend on a global JSON body parser being present.
 */
const otelJsonParser = express.json({ limit: '5mb' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasAnyMetricDataPoints(payload: ExportMetricsServiceRequest): boolean {
  for (const resourceMetrics of payload.resourceMetrics ?? []) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        if ((metric.sum?.dataPoints?.length ?? 0) > 0) return true
        if ((metric.gauge?.dataPoints?.length ?? 0) > 0) return true
        if ((metric.histogram?.dataPoints?.length ?? 0) > 0) return true
      }
    }
  }

  return false
}

/**
 * Middleware that rejects requests with unsupported Content-Type.
 *
 * The OTEL receiver currently only supports JSON payloads.  Protobuf and
 * other encodings are silently ignored by `express.json()`, leaving
 * `req.body` as `undefined` and causing telemetry to be silently dropped.
 */
function requireJsonContentType(req: Request, res: Response, next: () => void): void {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.startsWith('application/json')) {
    // Sanitize the reflected content-type: strip control chars and truncate to
    // avoid header-injection / information-leakage in the error response.
    const sanitized = contentType.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120)
    res.status(415).json({
      error: `Unsupported content type '${sanitized}'. This endpoint accepts application/json only.`,
    })
    return
  }
  next()
}

const OTEL_SUCCESS = { partialSuccess: {} }

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOtelRouter(options: OtelReceiverOptions): Router {
  const router = Router()
  const hub = options.hub
  const now = options.now ?? (() => new Date())

  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['telemetry:write'],
    unconfiguredApiKeyMessage: 'Telemetry API key is not configured',
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    now,
  })

  // POST /v1/logs
  router.post('/logs', requireWriteAccess, requireJsonContentType, otelJsonParser, async (req: Request, res: Response) => {
    const body = req.body as unknown
    if (!isObject(body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' })
      return
    }

    try {
      const payload = body as ExportLogsServiceRequest
      const parsed = parseLogs(payload)

      if (parsed.length === 0) {
        res.status(400).json({
          error: "Payload contained no log records. Ensure 'resourceLogs' contains at least one logRecord.",
        })
        return
      }

      for (const record of parsed) {
        const normalized = normalizeLogRecord(record, now())
        if (normalized) {
          await hub.ingestOtelLog(
            {
              signal: 'logs',
              resource: record.resource,
              eventName: record.eventName,
              attributes: record.attributes,
            },
            normalized,
          )
        }
      }

      res.status(200).json(OTEL_SUCCESS)
    } catch {
      res.status(500).json({ error: 'Failed to process OTEL logs' })
    }
  })

  // POST /v1/metrics
  router.post('/metrics', requireWriteAccess, requireJsonContentType, otelJsonParser, async (req: Request, res: Response) => {
    const body = req.body as unknown
    if (!isObject(body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' })
      return
    }

    try {
      const payload = body as ExportMetricsServiceRequest

      // Do not classify non-empty unsupported metric types (e.g. histogram)
      // as empty payloads; only reject envelopes with no data points at all.
      if (!hasAnyMetricDataPoints(payload)) {
        res.status(400).json({
          error: "Payload contained no metric data points. Ensure 'resourceMetrics' contains at least one data point.",
        })
        return
      }

      const parsed = parseMetrics(payload)
      for (const dataPoint of parsed) {
        const normalized = normalizeMetricDataPoint(dataPoint, now())
        if (normalized) {
          await hub.ingestOtelMetric(
            {
              signal: 'metrics',
              resource: dataPoint.resource,
              metricName: dataPoint.metricName,
              attributes: dataPoint.attributes,
              value: dataPoint.value,
            },
            normalized,
          )
        }
      }

      res.status(200).json(OTEL_SUCCESS)
    } catch {
      res.status(500).json({ error: 'Failed to process OTEL metrics' })
    }
  })

  // POST /v1/traces
  router.post('/traces', requireWriteAccess, requireJsonContentType, otelJsonParser, async (req: Request, res: Response) => {
    const body = req.body as unknown
    if (!isObject(body)) {
      res.status(400).json({ error: 'Request body must be a JSON object' })
      return
    }

    try {
      // Traces are accepted but not deeply processed yet (future extensibility).
      // We validate the payload structure and store as-is.
      const payload = body as ExportTraceServiceRequest
      const parsed = parseTraces(payload)

      if (parsed.length === 0) {
        res.status(400).json({
          error: "Payload contained no spans. Ensure 'resourceSpans' contains at least one span.",
        })
        return
      }

      res.status(200).json(OTEL_SUCCESS)
    } catch {
      res.status(500).json({ error: 'Failed to process OTEL traces' })
    }
  })

  return router
}
