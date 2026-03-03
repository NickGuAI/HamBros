export interface AuthUser {
    id: string;
    email: string;
    metadata?: Record<string, unknown>;
}
export interface AuthProvider {
    provider: string;
    verifyToken(token: string): Promise<AuthUser>;
    refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
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
export declare function decodeJwtPayload(token: string): JwtPayload;
export declare function verifyJwtPayload(token: string, options?: JwtVerifyOptions): JwtPayload;
export declare function bearerTokenFromHeader(headerValue: string | undefined): string | null;
export interface SupabaseAuthClientLike {
    verifyAccessToken(token: string): Promise<AuthUser>;
    refreshSession(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    getUserById(userId: string): Promise<AuthUser>;
}
export declare class SupabaseAuthProvider implements AuthProvider {
    private readonly client;
    readonly provider = "supabase";
    constructor(client: SupabaseAuthClientLike);
    verifyToken(token: string): Promise<AuthUser>;
    refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    getUser(userId: string): Promise<AuthUser>;
}
export interface Auth0ClientLike {
    verifyJwt(token: string): Promise<AuthUser>;
    refresh(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    getUserProfile(userId: string): Promise<AuthUser>;
}
export declare class Auth0Provider implements AuthProvider {
    private readonly client;
    readonly provider = "auth0";
    constructor(client: Auth0ClientLike);
    verifyToken(token: string): Promise<AuthUser>;
    refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }>;
    getUser(userId: string): Promise<AuthUser>;
}
export interface AuthRequest {
    headers: Record<string, string | undefined>;
    authUser?: AuthUser;
}
export type NextHandler = () => Promise<void> | void;
export type AuthMiddleware = (request: AuthRequest, next: NextHandler) => Promise<void>;
export declare function createAuthMiddleware(provider: AuthProvider): AuthMiddleware;
//# sourceMappingURL=index.d.ts.map