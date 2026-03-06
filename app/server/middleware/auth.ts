import type { Request, RequestHandler } from 'express'
import { bearerTokenFromHeader, type AuthUser } from '@hambros/auth-providers'
import type { ApiKeyStoreLike } from '../api-keys/store.js'

interface ApiKeyAuthSuccess {
  ok: true
  user: AuthUser
}

interface ApiKeyAuthFailure {
  ok: false
  status: number
  error: string
}

export type ApiKeyAuthorizationResult = ApiKeyAuthSuccess | ApiKeyAuthFailure

export interface ApiKeyAuthOptions {
  apiKeyStore?: ApiKeyStoreLike
  requiredScopes?: readonly string[]
  unconfiguredMessage?: string
  now?: () => Date
}

function normalizeApiKey(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export function extractApiKey(request: Request): string | null {
  const headerApiKey =
    request.header('x-hammurabi-api-key') ?? request.header('x-api-key')
  const normalizedHeaderApiKey = normalizeApiKey(headerApiKey)
  if (normalizedHeaderApiKey) {
    return normalizedHeaderApiKey
  }

  const bearerToken = bearerTokenFromHeader(request.header('authorization'))
  return normalizeApiKey(bearerToken ?? undefined)
}

function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes) {
    return []
  }

  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))]
}

function toUnauthorized(): ApiKeyAuthFailure {
  return {
    ok: false,
    status: 401,
    error: 'Unauthorized',
  }
}

export async function authorizeApiKeyRequest(
  request: Request,
  options: ApiKeyAuthOptions = {},
): Promise<ApiKeyAuthorizationResult> {
  const requiredScopes = normalizeScopes(options.requiredScopes)
  const providedApiKey = extractApiKey(request)

  if (!options.apiKeyStore) {
    if (providedApiKey) {
      return toUnauthorized()
    }

    return {
      ok: false,
      status: 503,
      error: options.unconfiguredMessage ?? 'API key is not configured',
    }
  }

  const hasKeys = await options.apiKeyStore.hasAnyKeys()
  if (!hasKeys) {
    if (providedApiKey) {
      return toUnauthorized()
    }

    return {
      ok: false,
      status: 503,
      error: options.unconfiguredMessage ?? 'API key is not configured',
    }
  }

  if (!providedApiKey) {
    return toUnauthorized()
  }

  const verification = await options.apiKeyStore.verifyKey(providedApiKey, {
    requiredScopes,
    now: options.now?.(),
  })
  if (verification.ok) {
    return {
      ok: true,
      user: {
        id: 'api-key',
        email: 'system',
        metadata: {
          source: 'managed-store',
          keyId: verification.record.id,
          keyPrefix: verification.record.prefix,
          scopes: verification.record.scopes,
        },
      },
    }
  }

  if (verification.reason === 'insufficient_scope') {
    return {
      ok: false,
      status: 403,
      error: 'Insufficient API key scope',
    }
  }

  return toUnauthorized()
}

export function apiKeyAuth(options: ApiKeyAuthOptions = {}): RequestHandler {
  return async (req, res, next) => {
    const authorization = await authorizeApiKeyRequest(req, options)
    if (!authorization.ok) {
      res.status(authorization.status).json({ error: authorization.error })
      return
    }

    req.user = authorization.user
    req.authMode = 'api-key'
    next()
  }
}
