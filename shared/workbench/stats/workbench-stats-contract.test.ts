/*
 * No production exports. Tests protect request scope and filter defaults and the largest graph geometry.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { statsRangeShape, WorkbenchStatsReadRequestSchema } from "./workbench-stats-contract.ts";

test("stats requests keep explicit project scope and install filter defaults", () => {
  const section = "usage" as const;
  assert.deepEqual(WorkbenchStatsReadRequestSchema.parse({ projectIds: ["a", "b"], range: "7d", section }), {
    model: null, period: null, projectIds: ["a", "b"], provider: null, range: "7d", section, tokenTypes: ["input", "cacheRead", "cacheWrite", "output"],
  });
  assert.deepEqual(
    WorkbenchStatsReadRequestSchema.parse({ projectIds: null, range: "7d", section, tokenTypes: ["cache", "cacheRead"] }).tokenTypes,
    ["cacheRead", "cacheWrite"],
    "an older browser's combined cache category reads both halves once",
  );
  assert.equal(WorkbenchStatsReadRequestSchema.safeParse({ projectIds: null, range: "7d", section, period: { from: 2, to: 1 } }).success, false);
  assert.deepEqual(WorkbenchStatsReadRequestSchema.parse({ projectIds: [], range: "7d", section, tokenTypes: [] }).projectIds, []);
  assert.equal(WorkbenchStatsReadRequestSchema.safeParse({ projectIds: null, range: "forever", section }).success, false);
  assert.equal(WorkbenchStatsReadRequestSchema.safeParse({ projectIds: null, range: "7d", section, tokenTypes: ["all"] }).success, false);
  assert.equal(WorkbenchStatsReadRequestSchema.safeParse({ projectId: null, range: "7d", section }).success, false);});

test("every range fits the bounded graph bucket count", () => {
  const now = Date.UTC(2026, 9, 1, 12);
  for (const range of ["7d", "14d", "30d", "90d", "365d"] as const) {
    const shape = statsRangeShape(range, now);
    assert.ok(shape.count <= 90, range);
    assert.ok(shape.startedAt + shape.count * shape.bucketMs > now, `${range} must include today`);
  }
});
