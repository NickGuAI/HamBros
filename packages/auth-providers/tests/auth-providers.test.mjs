import assert from "node:assert/strict";
import test from "node:test";

import {
  bearerTokenFromHeader,
  createAuthMiddleware,
  decodeJwtPayload
} from "../dist/index.js";

function encodeBase64Url(input) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

test("bearerTokenFromHeader extracts token", () => {
  assert.equal(bearerTokenFromHeader("Bearer abc123"), "abc123");
  assert.equal(bearerTokenFromHeader("Basic abc123"), null);
  assert.equal(bearerTokenFromHeader(undefined), null);
});

test("decodeJwtPayload decodes base64url payload", () => {
  const token = `${encodeBase64Url('{"alg":"none"}')}.${encodeBase64Url(
    '{"sub":"u1","email":"u1@example.com"}'
  )}.`;

  const payload = decodeJwtPayload(token);
  assert.equal(payload.sub, "u1");
  assert.equal(payload.email, "u1@example.com");
});

test("createAuthMiddleware attaches user from provider", async () => {
  const middleware = createAuthMiddleware({
    provider: "supabase",
    async verifyToken(token) {
      return {
        id: `id-${token}`,
        email: "test@example.com"
      };
    },
    async refreshToken() {
      return { accessToken: "a", refreshToken: "r" };
    },
    async getUser(userId) {
      return { id: userId, email: "test@example.com" };
    }
  });

  const request = {
    headers: {
      authorization: "Bearer token-1"
    }
  };

  let called = false;
  await middleware(request, async () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(request.authUser.id, "id-token-1");
});
