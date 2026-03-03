import type { AuthUser } from '@hambros/auth-providers'

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
      authMode?: 'auth0' | 'api-key'
    }
  }
}

export {}
