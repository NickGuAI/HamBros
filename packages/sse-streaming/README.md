# @gehirn/sse-streaming

Phase 1 scaffold package for SSE client/server helpers.

## Status

This package is currently a **structure-only scaffold** for issue `#106`.
Only `sseResponse()` has a minimal implementation; client streaming and React hook APIs are placeholders.

## Planned API

- `streamSSE<T>(url, body, options)`
- `useSSE<T>(url, body, options)`
- `sseResponse(res)`

## Usage Example (Client)

```ts
import { streamSSE } from "@gehirn/sse-streaming";

for await (const event of streamSSE<{ token: string }>("/api/stream", { q: "hi" })) {
  console.log(event.token);
}
```

## Usage Example (Server / Express-like Response)

```ts
import { sseResponse } from "@gehirn/sse-streaming";

const stream = sseResponse(res);
stream.send({ type: "connected" });
stream.send({ token: "hello" });
stream.close();
```

## Next Implementation Steps

1. Implement fetch + `ReadableStream` SSE parser
2. Implement buffer management for partial events
3. Implement AbortController handling and error differentiation
4. Implement React `useSSE` hook and tests
