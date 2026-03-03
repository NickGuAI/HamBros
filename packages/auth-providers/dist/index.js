function toBase64(input) {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const paddingNeeded = (4 - (normalized.length % 4)) % 4;
    return normalized + "=".repeat(paddingNeeded);
}
export function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length < 2) {
        throw new Error("Invalid JWT format");
    }
    const payload = parts[1];
    const json = atob(toBase64(payload));
    return JSON.parse(json);
}
export function verifyJwtPayload(token, options = {}) {
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
export function bearerTokenFromHeader(headerValue) {
    if (!headerValue) {
        return null;
    }
    const [scheme, token] = headerValue.split(" ");
    if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
        return null;
    }
    return token;
}
export class SupabaseAuthProvider {
    constructor(client) {
        this.client = client;
        this.provider = "supabase";
    }
    async verifyToken(token) {
        return this.client.verifyAccessToken(token);
    }
    async refreshToken(refreshToken) {
        return this.client.refreshSession(refreshToken);
    }
    async getUser(userId) {
        return this.client.getUserById(userId);
    }
}
export class Auth0Provider {
    constructor(client) {
        this.client = client;
        this.provider = "auth0";
    }
    async verifyToken(token) {
        return this.client.verifyJwt(token);
    }
    async refreshToken(refreshToken) {
        return this.client.refresh(refreshToken);
    }
    async getUser(userId) {
        return this.client.getUserProfile(userId);
    }
}
export function createAuthMiddleware(provider) {
    return async (request, next) => {
        const token = bearerTokenFromHeader(request.headers.authorization ?? request.headers.Authorization);
        if (!token) {
            throw new Error("Missing bearer token");
        }
        request.authUser = await provider.verifyToken(token);
        await next();
    };
}
//# sourceMappingURL=index.js.map