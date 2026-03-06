import { normalizeEndpoint } from './config.js'

export interface ValidateApiKeyInput {
  endpoint: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export type ApiKeyValidationResult =
  | {
      ok: true
      validationUrl: string
    }
  | {
      ok: false
      code:
        | 'invalid_endpoint'
        | 'invalid_key'
        | 'unauthorized'
        | 'forbidden'
        | 'network'
        | 'unexpected'
      message: string
      status?: number
      validationUrl?: string
    }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return 'Unknown network error'
}

async function readErrorMessage(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.toLowerCase().includes('application/json')

  if (isJson) {
    try {
      const parsed = (await response.json()) as unknown
      if (isObject(parsed) && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
        return parsed.error.trim()
      }
    } catch {
      return null
    }
    return null
  }

  try {
    const text = (await response.text()).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

function toOtelLogsUrl(endpoint: string): string | null {
  const normalized = normalizeEndpoint(endpoint)
  if (!normalized) {
    return null
  }

  try {
    return new URL('/v1/logs', `${normalized}/`).toString()
  } catch {
    return null
  }
}

/**
 * Build a minimal OTLP/HTTP JSON log payload used for validation.
 *
 * Sends a single log record with event name `hammurabi.onboard_validation`
 * so the server can distinguish validation pings from real telemetry.
 */
function buildValidationPayload(): object {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'hammurabi-cli' } },
            { key: 'session.id', value: { stringValue: 'onboard-validation' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                body: { stringValue: 'hammurabi.onboard_validation' },
                attributes: [
                  { key: 'event.name', value: { stringValue: 'hammurabi.onboard_validation' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * Validate a telemetry write API key by sending a minimal OTLP log payload
 * to `POST /v1/logs`. This verifies both connectivity and auth in one shot.
 */
export async function validateTelemetryWriteKey(
  input: ValidateApiKeyInput,
): Promise<ApiKeyValidationResult> {
  const apiKey = input.apiKey.trim()
  if (apiKey.length === 0) {
    return {
      ok: false,
      code: 'invalid_key',
      message: 'API key is required.',
    }
  }

  const validationUrl = toOtelLogsUrl(input.endpoint)
  if (!validationUrl) {
    return {
      ok: false,
      code: 'invalid_endpoint',
      message: 'Endpoint must be a valid absolute URL.',
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch

  try {
    const response = await fetchImpl(validationUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hammurabi-api-key': apiKey,
      },
      body: JSON.stringify(buildValidationPayload()),
    })

    if (response.ok) {
      return {
        ok: true,
        validationUrl,
      }
    }

    if (response.status === 401) {
      return {
        ok: false,
        code: 'unauthorized',
        status: response.status,
        validationUrl,
        message: 'API key was rejected (401 Unauthorized).',
      }
    }

    if (response.status === 403) {
      return {
        ok: false,
        code: 'forbidden',
        status: response.status,
        validationUrl,
        message: 'API key is missing required telemetry:write scope (403 Forbidden).',
      }
    }

    const detail = await readErrorMessage(response)
    return {
      ok: false,
      code: 'unexpected',
      status: response.status,
      validationUrl,
      message: detail
        ? `Validation failed (${response.status}): ${detail}`
        : `Validation failed with status ${response.status}.`,
    }
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      validationUrl,
      message: `Could not reach endpoint: ${toErrorMessage(error)}`,
    }
  }
}
