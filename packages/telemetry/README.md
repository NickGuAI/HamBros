# @gehirn/telemetry

AI usage telemetry package with cost tracking, OpenRouter header extraction, usage aggregation, quota enforcement, and pluggable storage adapters.

## Features

- Track AI usage with `userId`, `model`, `provider`, token counts, and cost
- Extract OpenRouter cost from `x-openrouter-cost`
- Aggregate usage by user/session/model
- Enforce per-user quota
- Storage adapters for Prisma, Supabase, and in-memory testing

## Storage Adapters

- `InMemoryTelemetryStore`
- `PrismaTelemetryStore`
- `SupabaseTelemetryStore`

## Usage

```ts
import {
  DefaultTelemetryTracker,
  InMemoryTelemetryStore,
  extractOpenRouterCost
} from "@gehirn/telemetry";

const tracker = new DefaultTelemetryTracker({
  store: new InMemoryTelemetryStore(),
  defaultTierLimitUsd: 50
});

const costUsd = extractOpenRouterCost({ "x-openrouter-cost": "0.0031" }) ?? 0;

await tracker.trackAICall({
  userId: "user-123",
  model: "openrouter/anthropic/claude-sonnet-4-5",
  inputTokens: 1200,
  outputTokens: 280,
  costUsd,
  provider: "openrouter",
  sessionId: "session-abc"
});

const usage = await tracker.getUsage("user-123", "month");
console.log(usage.totalCostUsd);
```
