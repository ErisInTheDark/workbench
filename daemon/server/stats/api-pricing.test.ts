/*
 * No production exports. Node tests protect known-model API estimates, cache accounting, long-context multipliers, fast tier, and unknown coverage. Keywords: stats, pricing, cost, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { estimateApiTokenCost } from "./api-pricing.ts";

test("API pricing separates cached input and output", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 0,
    cachedInputTokens: 100_000,
    inputTokens: 200_000,
    model: "gpt-5.4",
    outputTokens: 100_000,
    serviceTier: null,
  });
  assert.deepEqual(estimate, {
    byTokenType: { input: 0.25, cache: 0.025, output: 1.5 },
    model: "gpt-5.4",
    pricedTokens: 300_000,
    source: "exact",
    totalUsd: 1.775,
    unpricedTokens: 0,
  });
});

test("API pricing applies long-context and fast multipliers", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 10,
    cachedInputTokens: 20,
    inputTokens: 300_000,
    model: "gpt-5.6-terra",
    outputTokens: 100,
    serviceTier: "fast",
  });
  assert.equal(estimate.totalUsd, 2.403476);
});

test("pricing exposes independently billable categories using the same full-context rates", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 10_000,
    cachedInputTokens: 20_000,
    inputTokens: 300_000,
    model: "gpt-5.6-sol",
    outputTokens: 10_000,
    serviceTier: "fast",
  });
  assert.ok("byTokenType" in estimate);
  assert.deepEqual(estimate.byTokenType, { input: 4.32, cache: 0.232, output: 0.6 });
  assert.equal(estimate.totalUsd, 5.152);
});

test("API pricing uses current Sol fast rates and bills cache writes", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 10_000,
    cachedInputTokens: 20_000,
    inputTokens: 100_000,
    model: "gpt-5.6-sol",
    outputTokens: 10_000,
    serviceTier: "fast",
  });
  assert.equal(estimate.totalUsd, 1.076);
});

test("unknown models use a best-knowledge default estimate", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 3,
    cachedInputTokens: 2,
    inputTokens: 10,
    model: "mystery",
    outputTokens: 4,
    serviceTier: null,
  });
  assert.equal(estimate.pricedTokens, 14);
  assert.equal(estimate.unpricedTokens, 0);
  assert.ok(estimate.totalUsd > 0);
  assert.equal(estimate.model, "gpt-5.6-sol");
  assert.equal(estimate.source, "default");
});
