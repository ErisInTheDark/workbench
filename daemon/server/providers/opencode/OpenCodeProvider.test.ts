/*
 * Exports:
 * - tests: provider registration is exercised through graph tests rather than source-shape assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import providerRegistrations from "workbench-shared/workbench/provider/provider-registrations";
import { openCodeAccountLimits } from "./OpenCodeProvider";

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
