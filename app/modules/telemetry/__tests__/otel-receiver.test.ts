import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { ApiKeyStoreLike } from '../../../server/api-keys/store'
import { TelemetryJsonlStore } from '../store'
import { TelemetryHub } from '../hub'
import { createOtelRouter } from '../otel-receiver'

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

interface RunningServer {
  baseUrl: string
  hub: TelemetryHub
  close: () => Promise<void>
}

const TEST_NOW = new Date('2026-02-18T10:00:00.000Z')

function createTestApiKeyStore(): ApiKeyStoreLike {
  return {
    hasAnyKeys: async () => true,
    verifyKey: async (rawKey) => {
      if (rawKey === 'test-key') {
        return {
          ok: true,
          record: {
            id: 'test-key-id',
            name: 'Test Key',
            keyHash: 'hash',
            prefix: 'hmrb_test',
            createdBy: 'test',
            createdAt: '2026-02-16T00:00:00.000Z',
            lastUsedAt: null,
            scopes: ['telemetry:write', 'telemetry:read'],
          },
        }
      }
      return { ok: false, reason: 'not_found' }
    },
  }
}

async function createServer(): Promise<RunningServer & { tmpDir: string }> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'hammurabi-otel-receiver-'))
  const storeFilePath = path.join(tmpDir, 'events.jsonl')
  const now = () => TEST_NOW

  const store = new TelemetryJsonlStore(storeFilePath)
  const hub = new TelemetryHub({ store, now })
  const otelRouter = createOtelRouter({
    hub,
    apiKeyStore: createTestApiKeyStore(),
    now,
  })

  const app = express()
  // Mount OTEL router before the global JSON parser (mirrors production ordering)
  app.use('/v1', otelRouter)
  app.use(express.json())

  // Also mount legacy routes so we can verify data flows through
  const { createTelemetryRouter } = await import('../routes')
  app.use(
    '/api/telemetry',
    createTelemetryRouter({
      apiKeyStore: createTestApiKeyStore(),
      store,
      now,
    }),
  )

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hub,
    tmpDir,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildOtelLogsPayload(
  eventName: string,
  attributes: Record<string, string | number> = {},
  resource: Record<string, string> = {},
): object {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: resource['service.name'] ?? 'claude-code' } },
            { key: 'session.id', value: { stringValue: resource['session.id'] ?? 'test-session' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: eventName },
                attributes: [
                  { key: 'event.name', value: { stringValue: eventName } },
                  ...Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value: typeof value === 'number'
                      ? { doubleValue: value }
                      : { stringValue: value },
                  })),
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

function buildOtelMetricsPayload(
  metricName: string,
  value: number,
  metricAttributes: Record<string, string> = {},
  resource: Record<string, string> = {},
): object {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: resource['service.name'] ?? 'claude-code' } },
            { key: 'session.id', value: { stringValue: resource['session.id'] ?? 'test-session' } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                sum: {
                  dataPoints: [
                    {
                      asDouble: value,
                      timeUnixNano: String(Date.now() * 1_000_000),
                      attributes: Object.entries(metricAttributes).map(([key, val]) => ({
                        key,
                        value: { stringValue: val },
                      })),
                    },
                  ],
                  aggregationTemporality: 2,
                  isMonotonic: true,
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Helpers for authenticated JSON requests
// ---------------------------------------------------------------------------

const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-hammurabi-api-key': 'test-key',
} as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OTEL receiver', () => {
  let server: RunningServer & { tmpDir: string }

  beforeEach(async () => {
    server = await createServer()
  })

  afterEach(async () => {
    await server.close()
    await rm(server.tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Happy-path: valid OTLP JSON payloads
  // -------------------------------------------------------------------------

  it('POST /v1/logs returns 200 with partialSuccess for valid OTLP JSON', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelLogsPayload('claude_code.api_request', {
          model: 'opus-4',
          cost_usd: 0.05,
          input_tokens: 1200,
          output_tokens: 800,
          duration_ms: 3400,
        }),
      ),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { partialSuccess: object }
    expect(body).toEqual({ partialSuccess: {} })
  })

  it('POST /v1/metrics returns 200 with partialSuccess for valid OTLP JSON', async () => {
    const response = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelMetricsPayload('claude_code.cost.usage', 0.05, { model: 'opus-4' }),
      ),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { partialSuccess: object }
    expect(body).toEqual({ partialSuccess: {} })
  })

  it('POST /v1/metrics accepts histogram-only OTLP payloads', async () => {
    const response = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: { attributes: [] },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'http.server.duration',
                    histogram: {
                      dataPoints: [
                        {
                          count: '1',
                          sum: 42,
                          bucketCounts: ['1'],
                          explicitBounds: [100],
                          timeUnixNano: String(Date.now() * 1_000_000),
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { partialSuccess: object }
    expect(body).toEqual({ partialSuccess: {} })
  })

  it('POST /v1/traces returns 200 with partialSuccess for valid OTLP JSON', async () => {
    const response = await fetch(`${server.baseUrl}/v1/traces`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'abc123',
                    spanId: 'def456',
                    name: 'test-span',
                    startTimeUnixNano: '1000000000',
                    endTimeUnixNano: '2000000000',
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { partialSuccess: object }
    expect(body).toEqual({ partialSuccess: {} })
  })

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('returns 401 when API key is missing', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOtelLogsPayload('test.event')),
    })

    expect(response.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Content-Encoding
  // -------------------------------------------------------------------------

  it('handles gzip Content-Encoding', async () => {
    const payload = JSON.stringify(
      buildOtelLogsPayload('claude_code.api_request', {
        model: 'opus-4',
        cost_usd: 0.01,
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 500,
      }),
    )
    const compressed = gzipSync(Buffer.from(payload, 'utf8'))

    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-hammurabi-api-key': 'test-key',
      },
      body: compressed,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { partialSuccess: object }
    expect(body).toEqual({ partialSuccess: {} })
  })

  // -------------------------------------------------------------------------
  // Integration: data flows into TelemetryHub
  // -------------------------------------------------------------------------

  it('OTEL log data creates sessions visible in /api/telemetry/sessions', async () => {
    const otelResponse = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelLogsPayload(
          'claude_code.api_request',
          {
            model: 'opus-4',
            cost_usd: 0.05,
            input_tokens: 1200,
            output_tokens: 800,
            duration_ms: 3400,
          },
          { 'service.name': 'claude-code', 'session.id': 'otel-session-1' },
        ),
      ),
    })
    expect(otelResponse.status).toBe(200)

    await server.hub.ensureReady()
    const sessions = server.hub.getSessions(TEST_NOW)
    expect(sessions.length).toBeGreaterThanOrEqual(1)

    const otelSession = sessions.find((s) => s.id === 'otel-session-1')
    expect(otelSession).toBeDefined()
    expect(otelSession?.agentName).toBe('claude-code')
    expect(otelSession?.totalCost).toBeCloseTo(0.05)
    expect(otelSession?.callCount).toBe(1)
  })

  it('aggregates bare Claude api_request and priced Codex response.completed calls in sessions and summary', async () => {
    const claudeResponse = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelLogsPayload(
          'api_request',
          {
            model: 'opus-4',
            cost_usd: 0.02,
            input_tokens: 300,
            output_tokens: 150,
            duration_ms: 1200,
          },
          { 'service.name': 'claude-code', 'session.id': 'claude-bare-session' },
        ),
      ),
    })
    expect(claudeResponse.status).toBe(200)

    const codexResponse = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelLogsPayload(
          'codex.sse_event',
          {
            event_type: 'response.completed',
            model: 'gpt-5.2',
            input_token_count: 1000,
            cached_input_token_count: 400,
            output_token_count: 500,
            duration_ms: 900,
          },
          { 'service.name': 'codex-cli', 'session.id': 'codex-priced-session' },
        ),
      ),
    })
    expect(codexResponse.status).toBe(200)

    await server.hub.ensureReady()
    const sessions = server.hub.getSessions(TEST_NOW) as Array<{
      id: string
      totalCost: number
      totalTokens: number
      callCount: number
    }>

    const claudeSession = sessions.find((session) => session.id === 'claude-bare-session')
    expect(claudeSession).toBeDefined()
    expect(claudeSession?.totalCost).toBeCloseTo(0.02)
    expect(claudeSession?.totalTokens).toBe(450)
    expect(claudeSession?.callCount).toBe(1)

    const codexSession = sessions.find((session) => session.id === 'codex-priced-session')
    expect(codexSession).toBeDefined()
    expect(codexSession?.totalCost).toBeCloseTo(0.00812)
    expect(codexSession?.totalTokens).toBe(1500)
    expect(codexSession?.callCount).toBe(1)

    const summary = (await server.hub.getSummary(TEST_NOW)) as {
      topModels: Array<{ model: string; cost: number; calls: number }>
    }

    const codexModel = summary.topModels.find((item) => item.model === 'gpt-5.2')
    expect(codexModel).toBeDefined()
    expect(codexModel?.cost).toBeCloseTo(0.00812)
    expect(codexModel?.calls).toBe(1)
  })

  it('OTEL metric data creates sessions for liveness but does not accumulate cost', async () => {
    const metricResponse = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelMetricsPayload(
          'claude_code.cost.usage',
          0.12,
          { model: 'opus-4' },
          { 'service.name': 'claude-code', 'session.id': 'metric-session-1' },
        ),
      ),
    })
    expect(metricResponse.status).toBe(200)

    await server.hub.ensureReady()
    const sessions = server.hub.getSessions(TEST_NOW)
    const metricSession = sessions.find((s) => s.id === 'metric-session-1')
    expect(metricSession).toBeDefined()
    // Cumulative metrics are liveness-only — cost tracking comes from log events
    expect(metricSession?.totalCost).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Payload validation – content-type & empty payloads
  // -------------------------------------------------------------------------

  it('returns 415 for protobuf content-type on /v1/logs', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'x-hammurabi-api-key': 'test-key',
      },
      body: new Uint8Array([0x0a, 0x02, 0x08, 0x01]),
    })

    expect(response.status).toBe(415)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Unsupported content type')
    expect(body.error).toContain('application/x-protobuf')
  })

  it('returns 415 for protobuf content-type on /v1/metrics', async () => {
    const response = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'x-hammurabi-api-key': 'test-key',
      },
      body: new Uint8Array([0x0a, 0x02, 0x08, 0x01]),
    })

    expect(response.status).toBe(415)
  })

  it('returns 415 for protobuf content-type on /v1/traces', async () => {
    const response = await fetch(`${server.baseUrl}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'x-hammurabi-api-key': 'test-key',
      },
      body: new Uint8Array([0x0a, 0x02, 0x08, 0x01]),
    })

    expect(response.status).toBe(415)
  })

  it('returns 415 for text/plain content-type on /v1/logs', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-hammurabi-api-key': 'test-key',
      },
      body: 'hello',
    })

    expect(response.status).toBe(415)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Unsupported content type')
  })

  it('returns 400 for empty JSON object on /v1/logs', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no log records')
  })

  it('returns 400 for empty resourceLogs array on /v1/logs', async () => {
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ resourceLogs: [] }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no log records')
  })

  it('returns 400 for empty JSON object on /v1/metrics', async () => {
    const response = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no metric data points')
  })

  it('returns 400 for metrics payload with no data points', async () => {
    const response = await fetch(`${server.baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'empty.histogram',
                    histogram: { dataPoints: [] },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no metric data points')
  })

  it('returns 400 for empty JSON object on /v1/traces', async () => {
    const response = await fetch(`${server.baseUrl}/v1/traces`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('no spans')
  })

  it('returns 401 (not 415) for protobuf content-type without API key', async () => {
    // Auth must run before content-type validation — unauthenticated probes
    // should not learn endpoint capabilities via a 415 diagnostic.
    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: new Uint8Array([0x0a, 0x02, 0x08, 0x01]),
    })

    expect(response.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Self-healing hub restore: re-normalizes historical data on restart
  // -------------------------------------------------------------------------

  it('hub restore re-normalizes otel_log entries from raw data (backfills cost)', async () => {
    // Step 1: Ingest a Codex sse_event that has cost computed correctly
    await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(
        buildOtelLogsPayload(
          'codex.sse_event',
          {
            'event.kind': 'response.completed',
            model: 'gpt-5.3-codex',
            input_token_count: 1000,
            cached_token_count: 400,
            output_token_count: 500,
            duration_ms: 900,
          },
          { 'service.name': 'codex-cli', 'session.id': 'restore-test-session' },
        ),
      ),
    })

    await server.hub.ensureReady()
    const sessions = server.hub.getSessions(TEST_NOW)
    const originalSession = sessions.find((s) => s.id === 'restore-test-session')
    expect(originalSession).toBeDefined()
    expect(originalSession!.totalCost).toBeGreaterThan(0)

    // Step 2: Create a NEW hub from the same store file — simulates server restart
    const { TelemetryJsonlStore: StoreClass } = await import('../store')
    const { TelemetryHub: HubClass } = await import('../hub')

    const store2 = new StoreClass(path.join(server.tmpDir, 'events.jsonl'))
    const hub2 = new HubClass({ store: store2, now: () => TEST_NOW })
    await hub2.ensureReady()

    const restoredSessions = hub2.getSessions(TEST_NOW)
    const restoredSession = restoredSessions.find((s) => s.id === 'restore-test-session')
    expect(restoredSession).toBeDefined()
    // The restored hub should have re-normalized the cost from raw attributes
    expect(restoredSession!.totalCost).toBeGreaterThan(0)
    expect(restoredSession!.totalCost).toBeCloseTo(originalSession!.totalCost)
  })

  it('hub restore recovers cost from old entries with normalized.cost=0', async () => {
    // Manually write a store entry that simulates real pre-fix Codex data:
    // - No session.id in resource (Codex Rust CLI uses conversation.id in attributes)
    // - raw attributes have response.completed + gpt-5.3-codex, but normalized.cost is 0
    const { TelemetryJsonlStore: StoreClass } = await import('../store')
    const { TelemetryHub: HubClass } = await import('../hub')

    const storeFile = path.join(server.tmpDir, 'backfill-test.jsonl')
    const store = new StoreClass(storeFile)

    const oldEntry = {
      type: 'otel_log' as const,
      recordedAt: '2026-02-18T09:00:00.000Z',
      payload: {
        signal: 'logs' as const,
        resource: {
          'telemetry.sdk.language': 'rust',
          'service.name': 'codex_cli_rs',
          'service.version': '0.104.0',
        },
        eventName: 'codex.sse_event',
        attributes: {
          'event.name': 'codex.sse_event',
          'event.kind': 'response.completed',
          'conversation.id': 'backfill-session',
          model: 'gpt-5.3-codex',
          input_token_count: 1000,
          cached_token_count: 400,
          output_token_count: 500,
          duration_ms: 900,
        },
        normalized: {
          id: 'old-uuid',
          sessionId: 'backfill-session',
          agentName: 'codex_cli_rs',
          model: 'gpt-5.3-codex',
          provider: 'openai',
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0, // <-- the bug: old normalizer didn't compute cost
          durationMs: 900,
          currentTask: 'Working',
          timestamp: '2026-02-18T09:00:00.000Z',
          eventName: 'codex.sse_event',
          signal: 'logs' as const,
        },
      },
    }

    await store.append(oldEntry)

    const hub = new HubClass({ store, now: () => TEST_NOW })
    await hub.ensureReady()

    const sessions = hub.getSessions(TEST_NOW)
    const session = sessions.find((s) => s.id === 'backfill-session')
    expect(session).toBeDefined()
    // Re-normalization should have computed cost from raw attributes
    // 600 uncached * 1.75/1M + 400 cached * 0.175/1M + 500 output * 14/1M = 0.00812
    expect(session!.totalCost).toBeCloseTo(0.00812, 4)
  })

  it('truncates excessively long content-type in error response', async () => {
    // A very long content-type should be truncated to avoid information leakage
    const longType = 'text/' + 'x'.repeat(200)

    const response = await fetch(`${server.baseUrl}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': longType,
        'x-hammurabi-api-key': 'test-key',
      },
      body: 'bad',
    })

    expect(response.status).toBe(415)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Unsupported content type')
    // The reflected content-type should be truncated (120 chars max)
    expect(body.error).not.toContain(longType)
    expect(body.error.length).toBeLessThan(longType.length + 100)
  })
})
