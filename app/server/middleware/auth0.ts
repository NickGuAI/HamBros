import type { Request, RequestHandler } from 'express'
import {
  Auth0Provider,
  bearerTokenFromHeader,
  type Auth0ClientLike,
  type AuthUser,
} from '@hambros/auth-providers'
import { createRemoteJWKSet, jwtVerify } from 'jose'

interface ResolvedAuth0Config {
  domain: string
  audience: string
  clientId: string
  issuer: string
}

export interface Auth0Options {
  domain?: string
  audience?: string
  clientId?: string
  verifyToken?: (token: string) => Promise<AuthUser>
}

export type Auth0TokenVerifier = (token: string) => Promise<AuthUser>

interface Auth0AuthorizationSuccess {
  ok: true
  user: AuthUser
}

interface Auth0AuthorizationFailure {
  ok: false
  status: number
  error: string
}

export type Auth0AuthorizationResult =
  | Auth0AuthorizationSuccess
  | Auth0AuthorizationFailure

function asNonEmptyString(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

function normalizeDomain(value: string | undefined): string | null {
  const input = asNonEmptyString(value)
  if (!input) {
    return null
  }

  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`

  try {
    const parsed = new URL(withProtocol)
    return parsed.host
  } catch {
    return null
  }
}

function resolveAuth0Config(options: Auth0Options): ResolvedAuth0Config | null {
  const domain = normalizeDomain(options.domain ?? process.env.AUTH0_DOMAIN)
  const audience = asNonEmptyString(options.audience ?? process.env.AUTH0_AUDIENCE)
  const clientId = asNonEmptyString(options.clientId ?? process.env.AUTH0_CLIENT_ID)

  if (!domain || !audience || !clientId) {
    return null
  }

  return {
    domain,
    audience,
    clientId,
    issuer: `https://${domain}/`,
  }
}

class Auth0JwksClient implements Auth0ClientLike {
  private readonly jwks

  constructor(private readonly config: ResolvedAuth0Config) {
    this.jwks = createRemoteJWKSet(
      new URL(`https://${config.domain}/.well-known/jwks.json`),
    )
  }

  async verifyJwt(token: string): Promise<AuthUser> {
    const verification = await jwtVerify(token, this.jwks, {
      algorithms: ['RS256'],
      issuer: this.config.issuer,
      audience: this.config.audience,
    })

    const authorizedParty =
      typeof verification.payload.azp === 'string'
        ? verification.payload.azp
        : typeof verification.payload.client_id === 'string'
          ? verification.payload.client_id
          : null
    if (authorizedParty && authorizedParty !== this.config.clientId) {
      throw new Error('JWT client mismatch')
    }

    const subject =
      typeof verification.payload.sub === 'string' ? verification.payload.sub : null
    if (!subject) {
      throw new Error('JWT missing sub')
    }

    const email =
      typeof verification.payload.email === 'string'
        ? verification.payload.email
        : `${subject}@auth0.local`

    return {
      id: subject,
      email,
      metadata: {
        provider: 'auth0',
        aud: verification.payload.aud,
      },
    }
  }

  async refresh(_refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    throw new Error('Auth0 token refresh is not implemented in Hammurabi')
  }

  async getUserProfile(userId: string): Promise<AuthUser> {
    return {
      id: userId,
      email: `${userId}@auth0.local`,
    }
  }
}

function createVerifier(options: Auth0Options): Auth0TokenVerifier | null {
  if (options.verifyToken) {
    return options.verifyToken
  }

  const config = resolveAuth0Config(options)
  if (!config) {
    return null
  }

  const provider = new Auth0Provider(new Auth0JwksClient(config))
  return (token: string) => provider.verifyToken(token)
}

export function createAuth0Verifier(options: Auth0Options = {}): Auth0TokenVerifier | null {
  return createVerifier(options)
}

function toMissingTokenError(): Auth0AuthorizationFailure {
  return {
    ok: false,
    status: 401,
    error: 'Missing authorization token',
  }
}

export async function authorizeAuth0Request(
  request: Request,
  options: Auth0Options = {},
  verifyTokenOverride?: Auth0TokenVerifier | null,
): Promise<Auth0AuthorizationResult> {
  const verifyToken =
    verifyTokenOverride === undefined
      ? createAuth0Verifier(options)
      : verifyTokenOverride
  if (!verifyToken) {
    return {
      ok: false,
      status: 503,
      error: 'Auth0 is not configured',
    }
  }

  const token = bearerTokenFromHeader(request.header('authorization'))
  if (!token) {
    return toMissingTokenError()
  }

  try {
    const user = await verifyToken(token)
    return {
      ok: true,
      user,
    }
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
    }
  }
}

export function auth0Middleware(
  options: Auth0Options & {
    optional?: boolean
  } = {},
): RequestHandler {
  const verifyToken = createAuth0Verifier(options)

  return async (req, res, next) => {
    if (!verifyToken) {
      if (options.optional) {
        next()
        return
      }

      res.status(503).json({ error: 'Auth0 is not configured' })
      return
    }

    const token = bearerTokenFromHeader(req.header('authorization'))
    if (!token) {
      if (options.optional) {
        next()
        return
      }

      const missingTokenError = toMissingTokenError()
      res.status(missingTokenError.status).json({ error: missingTokenError.error })
      return
    }

    try {
      req.user = await verifyToken(token)
      req.authMode = 'auth0'
      next()
    } catch {
      if (options.optional) {
        next()
        return
      }

      res.status(401).json({ error: 'Unauthorized' })
    }
  }
}
