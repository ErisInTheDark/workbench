/*
 * No production exports. Regression wards for what counts as an account's usage cap and when it lifts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkbenchAccountLimits, type WorkbenchRateLimitSnapshot, type WorkbenchRateLimitWindow } from "./provider-account.ts";

function snapshot(windows: Partial<Pick<WorkbenchRateLimitSnapshot, "primary" | "secondary" | "tertiary" | "rateLimitReachedType">>): WorkbenchRateLimitSnapshot {
  return {
    limitId: null, limitName: null, primary: null, secondary: null, credits: null, individualLimit: null,
    spendControlReached: null, planType: null, rateLimitReachedType: null, ...windows,
  };
}
const window = (usedPercent: number, resetsAt: number | null): WorkbenchRateLimitWindow => ({ usedPercent, windowDurationMins: 300, resetsAt });

test("below every window is no cap", () => {
  assert.equal(WorkbenchAccountLimits.usageCap({ rateLimits: snapshot({ primary: window(99, 10), secondary: window(10, 20) }) }), null);
});

test("quota returns only once the latest exhausted window resets", () => {
  const rateLimits = snapshot({ primary: window(100, 10), secondary: window(100, 20), tertiary: window(50, 30) });
  assert.deepEqual(WorkbenchAccountLimits.usageCap({ rateLimits }), { resumeAt: 20_000 });
});

test("a cap reported without any reset time is still a cap", () => {
  assert.deepEqual(WorkbenchAccountLimits.usageCap({ rateLimits: snapshot({ primary: window(100, null) }) }), { resumeAt: null });
  assert.deepEqual(WorkbenchAccountLimits.usageCap({ rateLimits: snapshot({ rateLimitReachedType: "rate_limit_reached" }) }), { resumeAt: null });
});
