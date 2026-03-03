import { describe, expect, it } from 'vitest'
import { normalizeLogRecord, normalizeMetricDataPoint } from '../normalizer'
import type { ParsedLogRecord, ParsedMetricDataPoint } from '../otel-parser'

const now = new Date('2026-02-18T10:00:00.000Z')

describe('normalizeLogRecord', () => {
  it('normalizes a claude_code.api_request log record', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
        'os.type': 'linux',
      },
      eventName: 'claude_code.api_request',
      attributes: {
        'event.name': 'claude_code.api_request',
        model: 'opus-4',
        cost_usd: 0.05,
        input_tokens: 1200,
        output_tokens: 800,
        duration_ms: 3400,
      },
      timestampNano: '1739872800000000000', // 2025-02-18T10:00:00Z
      severityText: 'INFO',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'session-1',
      agentName: 'claude-code',
      model: 'opus-4',
      provider: 'anthropic',
      inputTokens: 1200,
      outputTokens: 800,
      cost: 0.05,
      durationMs: 3400,
      eventName: 'claude_code.api_request',
      signal: 'logs',
    })
    expect(result!.id).toBeTruthy()
    expect(result!.timestamp).toBeTruthy()
  })

  it('normalizes bare Claude Code api_request names into claude_code.api_request', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-bare',
      },
      eventName: 'api_request',
      attributes: {
        'event.name': 'api_request',
        model: 'opus-4',
        cost_usd: 0.012,
        input_tokens: 321,
        output_tokens: 123,
        duration_ms: 250,
      },
      timestampNano: '1739872800000000000',
      severityText: 'INFO',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'session-bare',
      eventName: 'claude_code.api_request',
      inputTokens: 321,
      outputTokens: 123,
      cost: 0.012,
    })
  })

  it('normalizes a codex.sse_event log record', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex-cli',
        'session.id': 'codex-session-1',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        input_token_count: 500,
        output_token_count: 200,
        duration_ms: 1200,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'codex-session-1',
      agentName: 'codex-cli',
      provider: 'openai',
      inputTokens: 500,
      outputTokens: 200,
      cost: 0,
      durationMs: 1200,
      eventName: 'codex.sse_event',
      signal: 'logs',
    })
  })

  it('computes codex.sse_event cost for gpt-5.2 response.completed using cached input tokens', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex-cli',
        'session.id': 'codex-session-cost',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        event_type: 'response.completed',
        model: 'gpt-5.2',
        input_token_count: 1000,
        cached_input_token_count: 400,
        output_token_count: 500,
        duration_ms: 900,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'codex-session-cost',
      model: 'gpt-5.2',
      inputTokens: 1000,
      outputTokens: 500,
      eventName: 'codex.sse_event',
    })
    expect(result?.cost).toBeCloseTo(0.00812, 10)
  })

  it('computes codex.sse_event cost when event.kind is response.completed (real Codex key)', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex-cli',
        'session.id': 'codex-event-kind',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        'event.kind': 'response.completed',
        model: 'gpt-5.2',
        input_token_count: 1000,
        cached_input_token_count: 400,
        output_token_count: 500,
        duration_ms: 900,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result?.cost).toBeCloseTo(0.00812, 10)
  })

  it('computes codex.sse_event cost for gpt-5.3-codex model', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex-cli',
        'session.id': 'codex-gpt53',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        event_type: 'response.completed',
        model: 'gpt-5.3-codex',
        input_token_count: 1000,
        output_token_count: 500,
        duration_ms: 800,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gpt-5.3-codex')
    // No cached tokens: 1000 * 1.75/1M + 500 * 14/1M = 0.00175 + 0.007 = 0.00875
    expect(result?.cost).toBeCloseTo(0.00875, 10)
  })

  it('reads cached_token_count key for Codex cached input tokens', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex-cli',
        'session.id': 'codex-cached-key',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        'event.kind': 'response.completed',
        model: 'gpt-5.2',
        input_token_count: 1000,
        cached_token_count: 400,
        output_token_count: 500,
        duration_ms: 700,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    // Same calculation as the existing test: 600 uncached + 400 cached + 500 output
    // (600 * 1.75 + 400 * 0.175 + 500 * 14) / 1_000_000 = 0.00812
    expect(result?.cost).toBeCloseTo(0.00812, 10)
  })

  it('falls back to conversation.id from attributes when resource has no session.id', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'codex_cli_rs',
      },
      eventName: 'codex.sse_event',
      attributes: {
        'event.name': 'codex.sse_event',
        'event.kind': 'response.completed',
        'conversation.id': 'conv-123',
        model: 'gpt-5.3-codex',
        input_token_count: 1000,
        output_token_count: 500,
        cached_token_count: 400,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('conv-123')
    expect(result!.cost).toBeCloseTo(0.00812, 10)
  })

  it('returns null for records without session.id or conversation.id', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'claude-code',
      },
      eventName: 'claude_code.api_request',
      attributes: { model: 'opus-4' },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    expect(normalizeLogRecord(record, now)).toBeNull()
  })

  it('normalizes non-call events with zero cost/tokens', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
      },
      eventName: 'claude_code.tool_result',
      attributes: {
        'event.name': 'claude_code.tool_result',
        tool_name: 'Read',
        success: true,
        duration_ms: 50,
      },
      timestampNano: '1739872800000000000',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'session-1',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      eventName: 'claude_code.tool_result',
    })
  })

  it('handles timestamp parsing with fallback to now', () => {
    const record: ParsedLogRecord = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
      },
      eventName: 'claude_code.api_request',
      attributes: {
        model: 'opus-4',
        cost_usd: 0.01,
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 500,
      },
      timestampNano: '0',
      severityText: '',
    }

    const result = normalizeLogRecord(record, now)
    expect(result).not.toBeNull()
    expect(result!.timestamp).toBe(now.toISOString())
  })
})

describe('normalizeMetricDataPoint', () => {
  it('normalizes claude_code.cost.usage metric with zero cost (cumulative metrics are liveness-only)', () => {
    const dataPoint: ParsedMetricDataPoint = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
      },
      metricName: 'claude_code.cost.usage',
      attributes: { model: 'opus-4' },
      value: 0.12,
      timestampNano: '1739872800000000000',
    }

    const result = normalizeMetricDataPoint(dataPoint, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sessionId: 'session-1',
      agentName: 'claude-code',
      model: 'opus-4',
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      eventName: 'claude_code.cost.usage',
      signal: 'metrics',
    })
  })

  it('normalizes claude_code.token.usage metric with zero tokens (cumulative metrics are liveness-only)', () => {
    const dataPoint: ParsedMetricDataPoint = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
      },
      metricName: 'claude_code.token.usage',
      attributes: { type: 'input', model: 'opus-4' },
      value: 5000,
      timestampNano: '1739872800000000000',
    }

    const result = normalizeMetricDataPoint(dataPoint, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      eventName: 'claude_code.token.usage',
      signal: 'metrics',
    })
  })

  it('returns null for metrics without session.id', () => {
    const dataPoint: ParsedMetricDataPoint = {
      resource: { 'service.name': 'claude-code' },
      metricName: 'claude_code.cost.usage',
      attributes: { model: 'opus-4' },
      value: 0.01,
      timestampNano: '1739872800000000000',
    }

    expect(normalizeMetricDataPoint(dataPoint, now)).toBeNull()
  })

  it('normalizes unknown metrics with zero cost/tokens', () => {
    const dataPoint: ParsedMetricDataPoint = {
      resource: {
        'service.name': 'claude-code',
        'session.id': 'session-1',
      },
      metricName: 'claude_code.session.count',
      attributes: {},
      value: 1,
      timestampNano: '1739872800000000000',
    }

    const result = normalizeMetricDataPoint(dataPoint, now)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      eventName: 'claude_code.session.count',
    })
  })
})
