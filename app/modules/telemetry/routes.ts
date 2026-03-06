import { Router } from 'express'
import type { AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'
import {
  TelemetryJsonlStore,
  defaultTelemetryStorePath,
} from './store.js'
import { TelemetryHub, type IngestInput, type HeartbeatInput } from './hub.js'
import {
  LocalTelemetryScanner,
  type LocalScannerLike,
} from './local-scanner.js'

export { TelemetryHub }

export interface LocalScanOptions {
  enabled?: boolean
  claudeProjectsDir?: string
  codexSessionsDir?: string
  stateFilePath?: string
  summaryCachePath?: string
  intervalMs?: number
}

export interface TelemetryRouterOptions {
  dataFilePath?: string
  now?: () => Date
  store?: TelemetryJsonlStore
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
  verifyAuth0Token?: (token: string) => Promise<AuthUser>
  localScan?: LocalScanOptions
  localScanner?: LocalScannerLike
  /** Days to retain JSONL entries (passed to TelemetryHub). Default: 14. */
  retentionDays?: number
}

// ---------------------------------------------------------------------------
// Parsing helpers — serve the legacy REST endpoints
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'completed'
  }
  if (typeof value === 'number') {
    return value === 1
  }
  return false
}

function asDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed
    }
  }
  return fallback
}

function parseIngestInput(raw: unknown, now: Date): { ok: true; value: IngestInput } | { ok: false; error: string } {
  const body = asObject(raw)
  if (!body) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }

  const sessionId = asNonEmptyString(body.sessionId ?? body.session_id)
  const agentName = asNonEmptyString(body.agentName ?? body.agent ?? body.userId)
  const model = asNonEmptyString(body.model)
  const provider = asNonEmptyString(body.provider) ?? 'unknown'
  const currentTask = asNonEmptyString(body.currentTask ?? body.task) ?? 'Working'
  const inputTokens = asNumber(body.inputTokens ?? body.input_tokens)
  const outputTokens = asNumber(body.outputTokens ?? body.output_tokens)
  const cost = asNumber(body.cost ?? body.costUsd ?? body.cost_usd)
  const durationMs = asNumber(body.durationMs ?? body.duration_ms) ?? 0

  if (!sessionId) {
    return { ok: false, error: 'sessionId is required' }
  }
  if (!agentName) {
    return { ok: false, error: 'agentName is required' }
  }
  if (!model) {
    return { ok: false, error: 'model is required' }
  }
  if (inputTokens === null || inputTokens < 0) {
    return { ok: false, error: 'inputTokens must be a non-negative number' }
  }
  if (outputTokens === null || outputTokens < 0) {
    return { ok: false, error: 'outputTokens must be a non-negative number' }
  }
  if (cost === null || cost < 0) {
    return { ok: false, error: 'cost must be a non-negative number' }
  }

  return {
    ok: true,
    value: {
      sessionId,
      agentName,
      model,
      provider,
      inputTokens: Math.round(inputTokens),
      outputTokens: Math.round(outputTokens),
      cost,
      durationMs: Math.max(0, Math.round(durationMs)),
      currentTask,
      timestamp: asDate(body.timestamp ?? body.createdAt, now),
    },
  }
}

function parseHeartbeatInput(raw: unknown, now: Date): { ok: true; value: HeartbeatInput } | { ok: false; error: string } {
  const body = asObject(raw)
  if (!body) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }

  const sessionId = asNonEmptyString(body.sessionId ?? body.session_id)
  const agentName = asNonEmptyString(body.agentName ?? body.agent)
  const model = asNonEmptyString(body.model)
  const currentTask = asNonEmptyString(body.currentTask ?? body.task) ?? undefined
  const completed = asBoolean(body.completed ?? body.status)

  if (!sessionId) {
    return { ok: false, error: 'sessionId is required' }
  }

  return {
    ok: true,
    value: {
      sessionId,
      agentName: agentName ?? undefined,
      model: model ?? undefined,
      currentTask,
      completed,
      timestamp: asDate(body.timestamp ?? body.createdAt, now),
    },
  }
}

// ---------------------------------------------------------------------------
// Router factories
// ---------------------------------------------------------------------------

export interface TelemetryRouterResult {
  router: Router
  hub: TelemetryHub
  store: TelemetryJsonlStore
}

function parseIntervalMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.round(value) : 0
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return 0
}

export function createTelemetryRouterWithHub(
  options: TelemetryRouterOptions = {},
): TelemetryRouterResult {
  const now = options.now ?? (() => new Date())
  const store =
    options.store ??
    new TelemetryJsonlStore(options.dataFilePath ?? defaultTelemetryStorePath())
  const hub = new TelemetryHub({ store, now, retentionDays: options.retentionDays })
  const localScanEnabled = options.localScan?.enabled ?? true
  const localScanner =
    options.localScanner ??
    (localScanEnabled
      ? new LocalTelemetryScanner({
          hub,
          now,
          claudeProjectsDir: options.localScan?.claudeProjectsDir,
          codexSessionsDir: options.localScan?.codexSessionsDir,
          stateFilePath: options.localScan?.stateFilePath,
          summaryCachePath: options.localScan?.summaryCachePath,
        })
      : null)

  if (localScanner) {
    // Run an initial scan on startup so local sessions appear immediately
    void localScanner.scan().catch((error) => {
      console.warn('[telemetry] initial local scan failed', error)
    })
  }

  const configuredIntervalMs =
    parseIntervalMs(options.localScan?.intervalMs) ||
    parseIntervalMs(process.env.HAMBROS_TELEMETRY_SCAN_INTERVAL_MS)
  if (localScanner && configuredIntervalMs > 0) {
    setInterval(() => {
      void localScanner.scan().catch((error) => {
        console.warn('[telemetry] local scan interval failed', error)
      })
    }, configuredIntervalMs)
  }

  const router = Router()
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
  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['telemetry:read'],
    unconfiguredApiKeyMessage: 'Telemetry API key is not configured',
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
    verifyToken: options.verifyAuth0Token,
    now,
  })

  router.post('/ingest', requireWriteAccess, async (req, res) => {
    const parsed = parseIngestInput(req.body, now())
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    try {
      const record = await hub.ingest(parsed.value)
      res.status(202).json({ ok: true, callId: record.id })
    } catch {
      res.status(500).json({ error: 'Failed to ingest telemetry event' })
    }
  })

  router.post('/heartbeat', requireWriteAccess, async (req, res) => {
    const parsed = parseHeartbeatInput(req.body, now())
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    try {
      await hub.heartbeat(parsed.value)
      const detail = hub.getSessionDetail(parsed.value.sessionId)
      res.json({ ok: true, session: detail?.session ?? null })
    } catch {
      res.status(500).json({ error: 'Failed to process heartbeat' })
    }
  })

  router.post('/scan', requireWriteAccess, async (_req, res) => {
    if (!localScanner) {
      res.status(503).json({ error: 'Local telemetry scanner is disabled' })
      return
    }

    try {
      const result = await localScanner.scan()
      res.json({
        ok: true,
        scanned: result.scanned,
        ingested: result.ingested,
        skipped: result.skipped,
        durationMs: result.durationMs,
      })
    } catch {
      res.status(500).json({ error: 'Failed to scan local telemetry sessions' })
    }
  })

  router.get('/sessions', requireReadAccess, async (_req, res) => {
    try {
      await hub.ensureReady()
      res.json(hub.getSessions())
    } catch {
      res.status(500).json({ error: 'Failed to read telemetry sessions' })
    }
  })

  router.get('/sessions/:id', requireReadAccess, async (req, res) => {
    const sessionId = Array.isArray(req.params.id)
      ? req.params.id[0]?.trim()
      : req.params.id?.trim()
    if (!sessionId) {
      res.status(400).json({ error: 'Invalid session id' })
      return
    }

    try {
      await hub.ensureReady()
      const detail = hub.getSessionDetail(sessionId)
      if (!detail) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      res.json(detail)
    } catch {
      res.status(500).json({ error: 'Failed to read telemetry session' })
    }
  })

  router.get('/summary', requireReadAccess, async (_req, res) => {
    try {
      res.json(await hub.getSummary())
    } catch {
      res.status(500).json({ error: 'Failed to build telemetry summary' })
    }
  })

  router.post('/compact', requireWriteAccess, async (req, res) => {
    const body = asObject(req.body)
    const retentionDays =
      typeof body?.retentionDays === 'number' && Number.isFinite(body.retentionDays) && body.retentionDays > 0
        ? body.retentionDays
        : (options.retentionDays ?? 14)
    try {
      await hub.ensureReady()
      await store.compact(retentionDays)
      res.json({ ok: true, retentionDays })
    } catch {
      res.status(500).json({ error: 'Compaction failed' })
    }
  })

  return { router, hub, store }
}

/**
 * Backward-compatible factory — returns just the Router (used by existing code
 * and tests that call `createTelemetryRouter`).
 */
export function createTelemetryRouter(options: TelemetryRouterOptions = {}): Router {
  return createTelemetryRouterWithHub(options).router
}
