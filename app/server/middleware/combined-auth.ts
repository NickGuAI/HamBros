import type { RequestHandler } from 'express'
import { bearerTokenFromHeader } from '@hambros/auth-providers'
import { authorizeApiKeyRequest, type ApiKeyAuthOptions } from './auth.js'
import {
  authorizeAuth0Request,
  createAuth0Verifier,
  type Auth0AuthorizationResult,
  type Auth0Options,
} from './auth0.js'

export interface CombinedAuthOptions extends ApiKeyAuthOptions, Auth0Options {
  requiredApiKeyScopes?: readonly string[]
  unconfiguredApiKeyMessage?: string
  optional?: boolean
  /** Server-generated token accepted via `x-hammurabi-internal-token` header. */
  internalToken?: string
}

export function combinedAuth(options: CombinedAuthOptions = {}): RequestHandler {
  const verifyAuth0Token = createAuth0Verifier(options)

  return async (req, res, next) => {
    // Internal server-to-self calls bypass all external auth
    if (options.internalToken) {
      const provided = req.header('x-hammurabi-internal-token')
      if (provided && provided === options.internalToken) {
        req.user = { id: 'internal', email: 'system' }
        req.authMode = 'api-key'
        next()
        return
      }
    }

    // Support access_token query param for SSE (EventSource can't send headers)
    if (
      !req.headers.authorization &&
      typeof req.query.access_token === 'string' &&
      req.query.access_token.length > 0
    ) {
      req.headers.authorization = `Bearer ${req.query.access_token}`
    }

    const bearerToken = bearerTokenFromHeader(req.header('authorization'))
    let auth0AttemptResult: Auth0AuthorizationResult | null = null

    if (bearerToken) {
      auth0AttemptResult = await authorizeAuth0Request(req, options, verifyAuth0Token)
      if (auth0AttemptResult.ok) {
        req.user = auth0AttemptResult.user
        req.authMode = 'auth0'
        next()
        return
      }
    }

    const apiKeyAuthorization = await authorizeApiKeyRequest(req, {
      apiKeyStore: options.apiKeyStore,
      requiredScopes: options.requiredApiKeyScopes,
      unconfiguredMessage: options.unconfiguredApiKeyMessage,
      now: options.now,
    })
    if (apiKeyAuthorization.ok) {
      req.user = apiKeyAuthorization.user
      req.authMode = 'api-key'
      next()
      return
    }

    if (options.optional) {
      next()
      return
    }

    res
      .status(apiKeyAuthorization.status)
      .json({ error: apiKeyAuthorization.error })
  }
}

export function optionalCombinedAuth(
  options: Omit<CombinedAuthOptions, 'optional'> = {},
): RequestHandler {
  return combinedAuth({
    ...options,
    optional: true,
  })
}
