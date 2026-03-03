import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultTelemetryTracker,
  InMemoryTelemetryStore,
  extractOpenRouterCost
} from "../dist/index.js";

test("extractOpenRouterCost parses numeric and currency-like values", () => {
  assert.equal(extractOpenRouterCost({ "x-openrouter-cost": "0.0045" }), 0.0045);
  assert.equal(extractOpenRouterCost({ "x-openrouter-cost": "$0.0132" }), 0.0132);
  assert.equal(extractOpenRouterCost({}), null);
});

test("tracker aggregates usage and enforces quota", async () => {
  const tracker = new DefaultTelemetryTracker({
    store: new InMemoryTelemetryStore(),
    defaultTierLimitUsd: 0.01
  });

  await tracker.trackAICall({
    userId: "u1",
    model: "gpt-4o-mini",
    inputTokens: 100,
    outputTokens: 30,
    costUsd: 0.004,
    provider: "openai",
    sessionId: "s1"
  });

  await tracker.trackAICall({
    userId: "u1",
    model: "gpt-4o-mini",
    inputTokens: 50,
    outputTokens: 12,
    costUsd: 0.005,
    provider: "openai",
    sessionId: "s1"
  });

  const usage = await tracker.getUsage("u1", "month");
  assert.equal(usage.requestCount, 2);
  assert.equal(usage.sessionCount, 1);
  assert.equal(usage.totalCostUsd, 0.009);
  assert.equal(usage.breakdown[0].model, "gpt-4o-mini");

  assert.equal(await tracker.enforceQuota("u1"), true);

  await tracker.trackAICall({
    userId: "u1",
    model: "gpt-4o-mini",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.003,
    provider: "openai",
    sessionId: "s2"
  });

  assert.equal(await tracker.enforceQuota("u1"), false);
});
