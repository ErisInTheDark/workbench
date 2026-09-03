/*
 * No production exports. Tests protect runner silence thresholds, retry admission, successful reset, and stale probe fencing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import OrchestratorHealthWatchdog from "./OrchestratorHealthWatchdog.ts";

test("reschedules the first probe from the latest child output", () => {
  const watchdog = new OrchestratorHealthWatchdog(120_000, 0);
  watchdog.observeOutput(30_000);

  assert.deepEqual(watchdog.nextAction(89_999), { delayMs: 1, kind: "wait" });
  assert.deepEqual(watchdog.nextAction(90_000), {
    kind: "probe",
    token: { attempt: 1, generation: 1 },
  });
});

test("successful first probe begins a fresh quiet window", () => {
  const watchdog = new OrchestratorHealthWatchdog(120_000, 0);
  const action = watchdog.nextAction(60_000);
  assert.equal(action.kind, "probe");
  if (action.kind !== "probe") return;

  assert.equal(watchdog.completeProbe(action.token, true, 61_000), true);
  assert.deepEqual(watchdog.nextAction(120_999), { delayMs: 1, kind: "wait" });
});

test("failed probes retry at ninety seconds and restart at one hundred twenty", () => {
  const watchdog = new OrchestratorHealthWatchdog(120_000, 0);
  const first = watchdog.nextAction(60_000);
  assert.equal(first.kind, "probe");
  if (first.kind !== "probe") return;
  watchdog.completeProbe(first.token, false, 70_000);

  assert.deepEqual(watchdog.nextAction(89_999), { delayMs: 1, kind: "wait" });
  const second = watchdog.nextAction(90_000);
  assert.equal(second.kind, "probe");
  if (second.kind !== "probe") return;
  watchdog.completeProbe(second.token, false, 100_000);

  assert.deepEqual(watchdog.nextAction(119_999), { delayMs: 1, kind: "wait" });
  assert.deepEqual(watchdog.nextAction(120_000), { kind: "restart" });
});

test("child output fences a late failed probe from the new cycle", () => {
  const watchdog = new OrchestratorHealthWatchdog(120_000, 0);
  const first = watchdog.nextAction(60_000);
  assert.equal(first.kind, "probe");
  if (first.kind !== "probe") return;

  watchdog.observeOutput(65_000);
  assert.equal(watchdog.completeProbe(first.token, false, 70_000), false);
  assert.deepEqual(watchdog.nextAction(124_999), { delayMs: 1, kind: "wait" });
});
