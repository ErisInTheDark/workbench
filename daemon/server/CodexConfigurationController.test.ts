/* Exports: none. Exercises provider model capabilities and account translation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "workbench-shared/codex/generated/app-server/v2/Model";
import CodexConfigurationController from "./CodexConfigurationController";

function model(id: string, overrides: Partial<Model> = {}): Model {
  return {
    id, model: id, displayName: id, description: "", hidden: false,
    upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null,
    supportedReasoningEfforts: [], defaultReasoningEffort: "none",
    inputModalities: ["text"], supportsPersonality: false, multiAgentVersion: null,
    additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null,
    isDefault: false, ...overrides,
  };
}

test("model pages retain capabilities and enrich matching local context", async () => {
  const cursors: unknown[] = [];
  const controller = new CodexConfigurationController({
    request: async (method, params) => {
      assert.equal(method, "model/list");
      assert.ok("cursor" in params);
      cursors.push(params.cursor);
      return params.cursor === null
        ? { data: [model("first", { inputModalities: ["text", "image"], additionalSpeedTiers: ["fast"] })], nextCursor: "second" }
        : { data: [model("second")], nextCursor: null };
    },
    warn: message => assert.fail(message),
  });
  const models = await controller.models(async () => [
    { model: "first", defaultTokens: 100, maximumTokens: 200 },
  ]);
  assert.deepEqual(cursors, [null, "second"]);
  assert.equal(models.length, 2);
  assert.equal(models[0].supportsVision, true);
  assert.equal(models[0].supportsFastMode, true);
  assert.deepEqual(models[0].contextWindow, { defaultTokens: 100, maximumTokens: 200 });
  assert.equal(models[1].maxContextWindowTokens, null);
});

test("local context failure preserves provider choices while provider failure propagates", async () => {
  const warnings: string[] = [];
  const controller = new CodexConfigurationController({
    request: async () => ({ data: [model("available")], nextCursor: null }),
    warn: message => warnings.push(message),
  });
  const models = await controller.models(async () => { throw new Error("unavailable local context"); });
  assert.equal(models[0].id, "available");
  assert.equal(warnings.length, 1);
  const failure = new Error("provider unavailable");
  const unavailable = new CodexConfigurationController({
    request: async () => { throw failure; },
    warn: message => assert.fail(message),
  });
  await assert.rejects(unavailable.models(async () => []), error => error === failure);
});

test("account translation preserves quota units and accepts newly named plan types", async () => {
  const controller = new CodexConfigurationController({
    request: async (method, _params, scheduling?: { background?: boolean }) => {
      assert.equal(scheduling?.background, true, "Quota refresh must retain background scheduling");
      if (method === "account/read") return { account: { type: "chatgpt", planType: "plus", email: "Me@Example.com" } };
      return {
        rateLimits: {
          limitId: "primary", limitName: null,
          primary: { usedPercent: 37, windowDurationMins: 180, resetsAt: 12345 },
          secondary: null, credits: null, planType: "future-plan",
        },
        rateLimitsByLimitId: null,
      };
    },
    warn: message => assert.fail(message),
  });
  const result = await controller.accountLimits();
  assert.deepEqual(result.rateLimits.primary, { usedPercent: 37, windowDurationMins: 180, resetsAt: 12345 });
  assert.equal(result.rateLimits.planType, "future-plan");
  assert.equal(result.rateLimits.spendControlReached, null);
  // The signed-in email names the account privately; its fingerprint never contains it.
  assert.equal(result.identity?.label, "Me@Example.com");
  assert.doesNotMatch(result.identity?.fingerprint ?? "", /example/iu);
});

const expiredToken = new Error(
  "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={\"error\":{\"code\":\"token_expired\"}}",
);
const limitsResponse = {
  rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1 }, secondary: null, credits: null, planType: "pro" },
  rateLimitsByLimitId: null,
};

function limitsController(failures: Error[]) {
  const calls: string[] = [];
  const controller = new CodexConfigurationController({
    request: async (method, params) => {
      calls.push(`${method}${"refreshToken" in params ? ":refresh" : ""}`);
      if (method === "account/read") return { account: { type: "chatgpt", email: "me@example.com" } };
      const failure = failures.shift();
      if (failure) throw failure;
      return limitsResponse;
    },
    warn: message => assert.fail(message),
  });
  return { calls, controller };
}

test("an expired Codex token is refreshed once before limits are reread", async () => {
  const { calls, controller } = limitsController([expiredToken]);
  assert.equal((await controller.accountLimits()).rateLimits.primary?.usedPercent, 0);
  assert.deepEqual(calls.filter(call => call !== "account/read"),
    ["account/rateLimits/read", "account/read:refresh", "account/rateLimits/read"]);
});

test("limit failures other than one expired token propagate without further refreshes", async () => {
  const other = new Error("provider unavailable");
  const failing = limitsController([other]);
  await assert.rejects(failing.controller.accountLimits(), error => error === other);
  assert.ok(!failing.calls.includes("account/read:refresh"));
  const stillExpired = limitsController([expiredToken, expiredToken]);
  await assert.rejects(stillExpired.controller.accountLimits(), error => error === expiredToken);
  assert.equal(stillExpired.calls.filter(call => call === "account/read:refresh").length, 1);
});

test("an API-key Codex account reports limits without an identity", async () => {
  const controller = new CodexConfigurationController({
    request: async (method) => method === "account/read"
      ? { account: { type: "apiKey" } }
      : { rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null }, rateLimitsByLimitId: null },
    warn: message => assert.fail(message),
  });
  assert.equal((await controller.accountLimits()).identity, null);
});
