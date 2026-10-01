/* No production exports. Tests protect native Claude model discovery, plan usage mapping, and query disposal. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import ClaudeConfigurationController, { claudeAccountLimits } from "./ClaudeConfigurationController";

function fixture(rows: ModelInfo[] | Error) {
  let closed = 0;
  const query = {
    supportedModels: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
    close: () => { closed++; },
  } as Query;
  const owner = new ClaudeConfigurationController(() => query, () => "fake-claude");
  return { owner, closed: () => closed };
}

test("Claude model choices use canonical versioned IDs and native capabilities", async () => {
  const { owner, closed } = fixture([
    {
      value: "sonnet", resolvedModel: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6", description: "balanced",
      supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true,
    },
    {
      value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6",
      description: "balanced", supportsEffort: true, supportedEffortLevels: ["low", "high"],
    },
    { value: "claude-opus-4-6", displayName: "Claude Opus 4.6", description: "deep" },
  ]);
  const models = await owner.models();
  assert.deepEqual(models.map(model => model.id), ["claude-sonnet-4-6", "claude-opus-4-6"]);
  assert.deepEqual(models[0]?.aliases, ["sonnet"]);
  assert.deepEqual(models[1]?.aliases, []);
  assert.deepEqual(models[0]?.supportedReasoningEfforts, ["low", "high"]);
  assert.equal(models[0]?.supportsFastMode, true);
  assert.equal(models[0]?.isDefault, true);
  assert.equal(closed(), 1);
});

test("Claude model discovery propagates native failure and closes its query", async () => {
  const { owner, closed } = fixture(new Error("native catalogue unavailable"));
  await assert.rejects(owner.models(), /native catalogue unavailable/u);
  assert.equal(closed(), 1);
});

test("Claude's native default alias selects its resolved version, not catalogue order", async () => {
  const { owner } = fixture([
    { value: "claude-opus-4-6", displayName: "Claude Opus 4.6", description: "deep" },
    { value: "default", resolvedModel: "claude-sonnet-4-6", displayName: "Default", description: "account default" },
    { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "balanced" },
  ]);
  const models = await owner.models();
  assert.deepEqual(models.map(model => [model.id, model.isDefault]), [
    ["claude-opus-4-6", false], ["claude-sonnet-4-6", true],
  ]);
  assert.deepEqual(models[1]?.aliases, ["default"]);
  assert.equal(models[1]?.displayName, "Claude Sonnet 4.6");
});

test("a named Claude alias labels the default model when no full-ID row exists", async () => {
  const { owner } = fixture([
    { value: "default", resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)", description: "account default" },
    { value: "opus", resolvedModel: "claude-opus-5-5",
      displayName: "Opus 5.5", description: "deep" },
  ]);
  const [model] = await owner.models();
  assert.equal(model?.id, "claude-opus-5-5");
  assert.equal(model?.displayName, "Opus 5.5");
  assert.deepEqual(model?.aliases, ["default", "opus"]);
  assert.equal(model?.isDefault, true);
});

test("a lone default alias shows its canonical ID instead of a placeholder name", async () => {
  const { owner } = fixture([
    { value: "default", resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)", description: "account default" },
  ]);
  const [model] = await owner.models();
  assert.equal(model?.displayName, "claude-opus-5-5");
  assert.deepEqual(model?.aliases, ["default"]);
});

test("Claude plan usage maps rolling, weekly, and monthly windows and reports the exhausted window", () => {
  const limits = claudeAccountLimits({
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: 100, resets_at: "2026-10-01T05:00:00.000Z" },
      seven_day: { utilization: 42.5, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 10, utilization: 20 },
    },
  });
  assert.deepEqual(limits.rateLimits.primary, {
    usedPercent: 100, windowDurationMins: 300, resetsAt: Date.parse("2026-10-01T05:00:00.000Z") / 1_000,
  });
  assert.deepEqual(limits.rateLimits.secondary, { usedPercent: 42.5, windowDurationMins: 10_080, resetsAt: null });
  assert.equal(limits.rateLimits.tertiary?.usedPercent, 20);
  assert.equal(limits.rateLimits.rateLimitReachedType, "five_hour");
  assert.equal(limits.rateLimits.planType, "max");
});

test("sessions without plan limits report empty windows instead of failing", () => {
  const limits = claudeAccountLimits({ subscription_type: null, rate_limits: null });
  assert.equal(limits.rateLimits.primary, null);
  assert.equal(limits.rateLimits.secondary, null);
  assert.equal(limits.rateLimits.tertiary, null);
  assert.equal(limits.rateLimits.rateLimitReachedType, null);
});

test("concurrent account-limit reads share one control process", async () => {
  const pending = Promise.withResolvers<{ rate_limits: null; subscription_type: null }>();
  let created = 0;
  const owner = new ClaudeConfigurationController(() => {
    created++;
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => pending.promise,
      close: () => undefined,
    } as unknown as Query;
  }, () => "fake-claude");
  const reads = [owner.accountLimits(), owner.accountLimits()];
  pending.resolve({ rate_limits: null, subscription_type: null });
  await Promise.all(reads);
  assert.equal(created, 1);
});

test("Claude provider disposal cancels an in-flight catalogue query", async () => {
  const pending = Promise.withResolvers<ModelInfo[]>();
  let closed = 0;
  let signal: AbortSignal | undefined;
  let prompt: AsyncIterable<unknown> | undefined;
  const owner = new ClaudeConfigurationController(({ options, prompt: input }) => {
    signal = options?.abortController?.signal;
    prompt = input as AsyncIterable<unknown>;
    return {
      supportedModels: () => pending.promise,
      close: () => { closed++; },
    } as Query;
  }, () => "fake-claude");
  const listing = owner.models();
  owner.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(closed, 1);
  assert.equal((await prompt![Symbol.asyncIterator]().next()).done, true);
  pending.reject(new Error("catalogue cancelled"));
  await assert.rejects(listing, /catalogue cancelled/u);
  assert.equal(closed, 1);
  await assert.rejects(owner.models(), /closing/u);
});
