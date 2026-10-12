/*
 * No production exports. Protect that limit use is inferred only from climbs within one window (stale and older-window
 * readings never count), spreads over the time it accrued, nests fine buckets inside days, scales to a week of allowance, and
 * names accounts privately per provider.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { currentLimitWindow, limitAccountNames, limitResolution, limitUsageByBucket, providerWeeklyUsage } from "./stats-limit-usage";

const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * 24 * 60;
const hours = { startedAt: 0, bucketMs: hour, count: 6 };
const sample = (observedAt: number, usedPercent: number, resetsAt: number | null = 10 * day, durationMinutes = week) => ({
  observedAt, primary: { durationMinutes, resetsAt, usedPercent }, secondary: null, tertiary: null,
});
const round = (values: readonly (number | null)[]) => values.map((value) => value === null ? null : Math.round(value * 100) / 100);

test("an old window still reported after an early reset never counts as use", () => {
  const samples = [
    sample(0.5 * hour, 95), sample(1.2 * hour, 96),
    // The week reset early; one source keeps reporting the old window beside the new one.
    sample(2.5 * hour, 0, 17 * day), sample(2.6 * hour, 96), sample(3.5 * hour, 0, 17 * day), sample(4.5 * hour, 96),
  ];
  // Only the 95% -> 96% climb counts, spread back across the 0.7h it accrued over.
  assert.deepEqual(round(limitUsageByBucket(samples, "primary", hours)), [0.71, 0.29, 0, 0, 0, 0]);
  assert.equal(currentLimitWindow(samples, "primary")?.usedPercent, 0);
});

test("lagging lower readings within a window neither count nor let their recovery count again", () => {
  const samples = [sample(0.5 * hour, 40), sample(0.6 * hour, 41), sample(0.7 * hour, 39), sample(0.8 * hour, 41), sample(0.9 * hour, 40)];
  assert.deepEqual(round(limitUsageByBucket(samples, "primary", hours)), [1, 0, 0, 0, 0, 0]);
  assert.equal(currentLimitWindow(samples, "primary")?.usedPercent, 41);
});

test("a climb spreads back to the previous climb, never more than three hours", () => {
  // Steady work reported in whole steps: 1% at 2h after the last step at 0h spreads over both hours.
  assert.deepEqual(round(limitUsageByBucket([sample(0, 10), sample(hour, 10), sample(2 * hour, 11)], "primary", hours)), [0.5, 0.5, 0, 0, 0, 0]);
  // A step five hours after the last only reaches back three.
  assert.deepEqual(
    round(limitUsageByBucket([sample(0, 10), sample(4 * hour, 10), sample(5 * hour, 13)], "primary", hours)),
    [0, 0, 1, 1, 1, 0],
  );
});

test("a new window counts what was used since its reset", () => {
  const samples = [sample(0.5 * hour, 80, 3 * hour), sample(3.5 * hour, 6, 3 * hour + 7 * day)];
  assert.deepEqual(round(limitUsageByBucket(samples, "primary", hours)), [0, 0, 0, 6, 0, 0]);
});

test("buckets before the first reading are unknown, and readings from a replaced window do not compare", () => {
  const values = limitUsageByBucket([sample(1.2 * hour, 10), sample(2.2 * hour, 30, 10 * day, 300)], "primary", hours);
  assert.deepEqual(values, [null, 0, 0, 0, 0, 0]);
});

test("fine buckets stay as fine as the budget allows and nest inside days", () => {
  assert.equal(limitResolution(0, 7 * day).bucketMs, hour);
  for (const span of [7, 30, 90, 371].map((days) => days * day)) {
    const { bucketMs, count } = limitResolution(0, span);
    assert.ok(count <= 720);
    assert.equal(day % bucketMs, 0);
  }
});

test("accounts are named only beside their provider's other accounts, masked to the shortest start that tells them apart", () => {
  const account = (key: string, label: string | null) => ({
    account: { key, label }, harness: "codex", limitId: "codex", limitName: null, samples: [sample(0.1 * hour, 1), sample(0.5 * hour, 4)],
  });
  const limits = [
    account("a1b2c3", "chiri@example.com"), account("d4e5f6", "claude@example.com"), account("9f9f9f", null),
    { ...account("solo", "solo@example.com"), harness: "claude" },
  ];
  assert.deepEqual(limitAccountNames(limits), [
    { short: "ch***", full: "chiri@example.com" },
    { short: "cl***", full: "claude@example.com" },
    { short: "account 9f9f", full: "account 9f9f" },
    null,
  ]);
  const usage = providerWeeklyUsage(limits, hours);
  assert.equal(new Set(usage.map(({ key }) => key)).size, 4);
  assert.deepEqual(usage.find(({ name }) => name?.full === "chiri@example.com")?.values.map((value) => value === null ? null : Math.round(value)), [3, 0, 0, 0, 0, 0]);
});

test("each provider follows its longest window, scaled to a week of that allowance", () => {
  const monthly = 30 * 24 * 60;
  const usage = providerWeeklyUsage([
    {
      harness: "codex", limitId: "codex", limitName: null,
      samples: [
        { observedAt: 0.1 * hour, primary: { durationMinutes: 300, resetsAt: null, usedPercent: 0 }, secondary: { durationMinutes: monthly, resetsAt: null, usedPercent: 0 }, tertiary: null },
        { observedAt: 0.5 * hour, primary: { durationMinutes: 300, resetsAt: null, usedPercent: 50 }, secondary: { durationMinutes: monthly, resetsAt: null, usedPercent: 7 }, tertiary: null },
      ],
    },
    { harness: "claude", limitId: "claude", limitName: null, samples: [sample(0.1 * hour, 0), sample(0.5 * hour, 3)] },
  ], hours);
  assert.deepEqual(usage.map(({ harness }) => harness), ["claude", "codex"]);
  assert.deepEqual(round(usage[0]!.values), [3, 0, 0, 0, 0, 0]);
  assert.deepEqual(round(usage[1]!.values).map((value) => value === null ? null : Math.round(value * 10) / 10), [30, 0, 0, 0, 0, 0]);
});
