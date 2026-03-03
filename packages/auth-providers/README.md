# @gehirn/auth-providers

Provider-agnostic auth interfaces with Supabase and Auth0 adapters, JWT helpers, and middleware factory.

## Features

- `AuthProvider` interface
- Supabase adapter (`SupabaseAuthProvider`)
- Auth0 adapter (`Auth0Provider`)
- JWT helper utilities (`decodeJwtPayload`, `verifyJwtPayload`)
- Middleware factory (`createAuthMiddleware`)

## Providers

- Supabase (implemented)
- Auth0 (implemented)

## Usage

```ts
import {
  SupabaseAuthProvider,
  createAuthMiddleware
} from "@gehirn/auth-providers";

const provider = new SupabaseAuthProvider(supabaseAuthClient);
const authMiddleware = createAuthMiddleware(provider);

await authMiddleware(
  {
    headers: {
      authorization: "Bearer <jwt>"
    }
  },
  async () => {
    console.log("authorized");
  }
);
```
