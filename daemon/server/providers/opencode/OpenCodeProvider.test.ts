/*
 * Exports:
 * - tests: provider registration is exercised through graph tests rather than source-shape assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import providerRegistrations from "workbench-shared/workbench/provider/provider-registrations";
import { openCodeAccountLimits, openCodeModelOption } from "./OpenCodeProvider";

test("installs OpenCode under its graph provider registration", () => {
  assert.equal(providerRegistrations.opencode, "openCodeProvider");
});

test("maps all three OpenCode Go windows into one account limit", () => {
  const limits = openCodeAccountLimits({
    observedAt: 1,
    windows: {
      rolling: { percent: 12, resetsAt: 1_000, status: "ok" },
      weekly: { percent: 34, resetsAt: 2_000, status: "ok" },
      monthly: { percent: 56, resetsAt: 3_000, status: "limited" },
    },
  });
  assert.equal(limits.rateLimits.primary?.windowDurationMins, 300);
  assert.equal(limits.rateLimits.secondary?.windowDurationMins, 10_080);
  assert.equal(limits.rateLimits.tertiary?.windowDurationMins, 43_200);
  assert.equal(limits.rateLimits.rateLimitReachedType, null);
});

test("keeps fixed OpenCode context as model metadata instead of configurable profile state", () => {
  const option = openCodeModelOption({
    id: "opencode-go/model",
    providerID: "opencode-go",
    modelID: "model",
    name: "Model",
    family: "family",
    enabled: true,
    status: "active",
    variants: [],
    capabilities: { input: ["text"], output: ["text"], tools: true },
    limit: { context: 200_000, output: 32_000 },
  }, "opencode-go/model");

  assert.equal(option.maxContextWindowTokens, 200_000);
  assert.equal(option.contextWindow, null);
  assert.equal(option.isDefault, true);
});
