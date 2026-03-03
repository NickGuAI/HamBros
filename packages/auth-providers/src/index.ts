export interface AuthUser {
  id: string;
  email: string;
  metadata?: Record<string, unknown>;
}

export interface AuthProvider {
  provider: string;
  verifyToken(token: string): Promise<AuthUser>;
  refreshToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string }>;
  getUser(userId: string): Promise<AuthUser>;
}

export interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

export interface JwtVerifyOptions {
  issuer?: string;
  audience?: string;
  nowSeconds?: number;
}

function toBase64(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  return normalized + "=".repeat(paddingNeeded);
}

export function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid JWT format");
  }

  const payload = parts[1];
  const json = atob(toBase64(payload));
  return JSON.parse(json) as JwtPayload;
}

export function verifyJwtPayload(token: string, options: JwtVerifyOptions = {}): JwtPayload {
  const payload = decodeJwtPayload(token);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (payload.exp !== undefined && payload.exp <= now) {
    throw new Error("JWT expired");
  }

  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error("JWT issuer mismatch");
  }

  if (options.audience) {
    const audience = payload.aud;
    const isMatch = Array.isArray(audience)
      ? audience.includes(options.audience)
      : audience === options.audience;

    if (!isMatch) {
      throw new Error("JWT audience mismatch");
    }
  }

  return payload;
}

export function bearerTokenFromHeader(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

export interface SupabaseAuthClientLike {
  verifyAccessToken(token: string): Promise<AuthUser>;
  refreshSession(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>;
  getUserById(userId: string): Promise<AuthUser>;
}

export class SupabaseAuthProvider implements AuthProvider {
  readonly provider = "supabase";

  constructor(private readonly client: SupabaseAuthClientLike) {}

  async verifyToken(token: string): Promise<AuthUser> {
    return this.client.verifyAccessToken(token);
  }

  async refreshToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.client.refreshSession(refreshToken);
  }

  async getUser(userId: string): Promise<AuthUser> {
    return this.client.getUserById(userId);
  }
}

export interface Auth0ClientLike {
  verifyJwt(token: string): Promise<AuthUser>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>;
  getUserProfile(userId: string): Promise<AuthUser>;
}

export class Auth0Provider implements AuthProvider {
  readonly provider = "auth0";

  constructor(private readonly client: Auth0ClientLike) {}

  async verifyToken(token: string): Promise<AuthUser> {
    return this.client.verifyJwt(token);
  }

  async refreshToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.client.refresh(refreshToken);
  }

  async getUser(userId: string): Promise<AuthUser> {
    return this.client.getUserProfile(userId);
  }
}

export interface AuthRequest {
  headers: Record<string, string | undefined>;
  authUser?: AuthUser;
}

export type NextHandler = () => Promise<void> | void;

export type AuthMiddleware = (
  request: AuthRequest,
  next: NextHandler
) => Promise<void>;

export function createAuthMiddleware(provider: AuthProvider): AuthMiddleware {
  return async (request: AuthRequest, next: NextHandler): Promise<void> => {
    const token = bearerTokenFromHeader(
      request.headers.authorization ?? request.headers.Authorization
    );

    if (!token) {
      throw new Error("Missing bearer token");
    }

    request.authUser = await provider.verifyToken(token);
    await next();
  };
}
