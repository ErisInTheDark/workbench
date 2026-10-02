/*
 * No production exports. Node tests protect catalogue routing, cache accounting, context tiers, fast and peak rates, and unpriced models.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { estimateApiTokenCost } from "./api-pricing.ts";

const usage = { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: 1_000_000, outputTokens: 1_000_000, serviceTier: null };

test("API pricing separates cached input and output", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 0, cachedInputTokens: 100_000, inputTokens: 200_000, outputTokens: 100_000,
    model: "gpt-5.4", provider: "codex", serviceTier: null,
  });
  assert.deepEqual(estimate?.byTokenType, { input: 0.25, cacheRead: 0.025, cacheWrite: 0, output: 1.5 });
  assert.equal(estimate?.totalUsd, 1.775);
  assert.equal(estimate?.source, "exact");
});

test("API pricing applies long-context and fast multipliers to every billed category", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 10_000, cachedInputTokens: 20_000, inputTokens: 300_000, outputTokens: 10_000,
    model: "gpt-5.6-sol", provider: "codex", serviceTier: "fast",
  });
  assert.deepEqual(estimate?.byTokenType, { input: 4.32, cacheRead: 0.032, cacheWrite: 0.2, output: 0.6 });
  assert.equal(estimate?.totalUsd, 5.152);
});

test("API pricing keeps standard rates at the long-context boundary", () => {
  const estimate = estimateApiTokenCost({
    cacheWriteInputTokens: 10_000, cachedInputTokens: 20_000, inputTokens: 100_000, outputTokens: 10_000,
    model: "gpt-5.6-sol", provider: "codex", serviceTier: "fast",
  });
  assert.equal(estimate?.totalUsd, 1.076);
});

test("Claude models price through the Anthropic catalogue with snapshot and context suffixes", () => {
  const current = estimateApiTokenCost({ ...usage, model: "claude-opus-5-5", provider: "claude" });
  assert.equal(current?.totalUsd, 24);
  assert.equal(current?.catalogue, "Anthropic");
  assert.equal(estimateApiTokenCost({ ...usage, model: "claude-haiku-4-5-20251001", provider: "claude" })?.totalUsd, 6);
  assert.equal(estimateApiTokenCost({ ...usage, model: "claude-sonnet-4-6[1m]", provider: "claude" })?.totalUsd, 18);
});

test("OpenCode namespaces choose Zen or Go rates for the same model id", () => {
  const offPeakMonday = Date.UTC(2026, 8, 28, 12);
  const zen = estimateApiTokenCost({ ...usage, model: "opencode/deepseek-v4.1-flash", provider: "opencode", occurredAt: offPeakMonday });
  const go = estimateApiTokenCost({ ...usage, model: "opencode-go/deepseek-v4.1-flash", provider: "opencode", occurredAt: offPeakMonday });
  assert.equal(zen?.totalUsd, 1.5);
  assert.equal(go?.totalUsd, 0.75);
  assert.equal(go?.catalogue, "OpenCode Go");
});

test("OpenCode Go applies DeepSeek peak rates only inside weekday peak hours", () => {
  const model = "opencode-go/deepseek-v4-pro";
  const peak = estimateApiTokenCost({ ...usage, model, provider: "opencode", occurredAt: Date.UTC(2026, 8, 29, 7) });
  const weekend = estimateApiTokenCost({ ...usage, model, provider: "opencode", occurredAt: Date.UTC(2026, 8, 27, 7) });
  assert.equal(peak?.totalUsd, 5.28);
  assert.equal(weekend?.totalUsd, 2.64);
});

test("tiered OpenCode prices switch above their input threshold", () => {
  const model = "opencode/gemini-3.1-pro";
  const small = estimateApiTokenCost({ ...usage, inputTokens: 200_000, outputTokens: 0, model, provider: "opencode" });
  const large = estimateApiTokenCost({ ...usage, inputTokens: 200_001, outputTokens: 0, model, provider: "opencode" });
  assert.equal(small?.totalUsd, 0.4);
  assert.equal(large?.totalUsd, 0.800004);
});

test("free catalogue models are priced at zero rather than unpriced", () => {
  const estimate = estimateApiTokenCost({ ...usage, model: "opencode/big-pickle", provider: "opencode" });
  assert.equal(estimate?.totalUsd, 0);
});

test("models without a catalogue price are unpriced instead of borrowing another model's rates", () => {
  assert.equal(estimateApiTokenCost({ ...usage, model: "mystery", provider: "codex" }), null);
  assert.equal(estimateApiTokenCost({ ...usage, model: null, provider: "codex" }), null);
  assert.equal(estimateApiTokenCost({ ...usage, model: "gpt-oss-120b", provider: "codex" }), null);
  assert.equal(estimateApiTokenCost({ ...usage, model: "glm-5.3", provider: "opencode" }), null);
  assert.equal(estimateApiTokenCost({ ...usage, model: "someone/gpt-5.4", provider: "opencode" }), null);
});
