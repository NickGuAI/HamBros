import { describe, expect, it, vi } from 'vitest'
import { validateTelemetryWriteKey } from '../validate.js'

describe('validateTelemetryWriteKey', () => {
  it('returns success for 200 OTEL logs response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ partialSuccess: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await validateTelemetryWriteKey({
      endpoint: 'https://hammurabi.gehirn.ai/',
      apiKey: 'hmrb_test_key',
      fetchImpl,
    })

    expect(result).toEqual({
      ok: true,
      validationUrl: 'https://hammurabi.gehirn.ai/v1/logs',
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hammurabi.gehirn.ai/v1/logs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-hammurabi-api-key': 'hmrb_test_key',
          'content-type': 'application/json',
        }),
      }),
    )

    // Verify the body is a valid OTLP logs payload
    const callArgs = fetchImpl.mock.calls[0]
    const body = JSON.parse(callArgs?.[1]?.body as string) as {
      resourceLogs: Array<{
        resource: { attributes: Array<{ key: string }> }
        scopeLogs: Array<{ logRecords: unknown[] }>
      }>
    }
    expect(body.resourceLogs).toHaveLength(1)
    expect(body.resourceLogs[0]?.scopeLogs).toHaveLength(1)
  })

  it('returns forbidden result for 403 response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Insufficient API key scope' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await validateTelemetryWriteKey({
      endpoint: 'https://hammurabi.gehirn.ai',
      apiKey: 'hmrb_test_key',
      fetchImpl,
    })

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      status: 403,
      validationUrl: 'https://hammurabi.gehirn.ai/v1/logs',
      message: 'API key is missing required telemetry:write scope (403 Forbidden).',
    })
  })

  it('returns network result when fetch throws', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1'))

    const result = await validateTelemetryWriteKey({
      endpoint: 'https://hammurabi.gehirn.ai',
      apiKey: 'hmrb_test_key',
      fetchImpl,
    })

    expect(result).toEqual({
      ok: false,
      code: 'network',
      validationUrl: 'https://hammurabi.gehirn.ai/v1/logs',
      message: 'Could not reach endpoint: connect ECONNREFUSED 127.0.0.1',
    })
  })

  it('returns invalid endpoint for malformed endpoint value', async () => {
    const result = await validateTelemetryWriteKey({
      endpoint: 'not-a-valid-url',
      apiKey: 'hmrb_test_key',
    })

    expect(result).toEqual({
      ok: false,
      code: 'invalid_endpoint',
      message: 'Endpoint must be a valid absolute URL.',
    })
  })
})
