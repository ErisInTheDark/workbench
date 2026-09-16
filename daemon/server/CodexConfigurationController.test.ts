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
    additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null,
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
    request: async (_method, _params, scheduling?: { background?: boolean }) => {
      assert.equal(scheduling?.background, true, "Quota refresh must retain background scheduling");
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
});
