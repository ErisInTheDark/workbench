/* No production exports. Protect stats sections surviving cross-version drift instead of being rejected whole. */
import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceObservationSchema } from "../workspace/workspace-observation.ts";
import { EMPTY_WORKBENCH_STATS_SECTIONS, WorkbenchStatsObservedResponseSchema } from "./workbench-stats-conformance.ts";

const thread = {
  cacheHitPercent: 40, cachedInputTokens: 400_000, harness: "codex", inputTokens: 1_000_000,
  projectId: "project", threadId: "thread", title: "Busy thread",
};
const usage = EMPTY_WORKBENCH_STATS_SECTIONS.usage;
const revision = {
  ...usage,
  cacheEfficiency: { ...usage.cacheEfficiency, worstThreads: [thread, { ...thread, threadId: "other" }] },
  generatedAt: 7,
};

test("a newer owner's extra fields are dropped while the rest of the section is kept", () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => { errors.push(message); };
  try {
    const drifted = {
      ...revision,
      cacheEfficiency: { ...revision.cacheEfficiency, worstThreads: revision.cacheEfficiency.worstThreads.map((row) => ({ ...row, futureField: 1 })) },
    };
    const first = WorkbenchStatsObservedResponseSchema.parse(drifted);
    assert.ok(first.section === "usage");
    assert.deepEqual(first.cacheEfficiency.worstThreads.map(({ threadId }) => threadId), ["thread", "other"]);
    assert.equal(first.generatedAt, 7);
    assert.equal(Object.hasOwn(first.cacheEfficiency.worstThreads[0]!, "futureField"), false);
    WorkbenchStatsObservedResponseSchema.parse(drifted);
    assert.equal(errors.length, 1, "repeated revisions with the same drift report once");
  } finally { console.error = original; }
});

test("a broken section resets only its broken node, towards its own section's empty value", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const repaired = WorkbenchStatsObservedResponseSchema.parse({
      ...EMPTY_WORKBENCH_STATS_SECTIONS.claims, generatedAt: 3, historyFailures: "not a list",
    });
    assert.deepEqual(repaired, { ...EMPTY_WORKBENCH_STATS_SECTIONS.claims, generatedAt: 3 });
  } finally { console.error = original; }
});

test("a drifted stats section still parses as a workspace observation", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const observation = WorkspaceObservationSchema.parse({
      kind: "stats", subscriptionId: "00000000-0000-4000-8000-000000000001", generation: 1, revision: 1,
      phase: "current", failure: null, refinement: "current",
      data: { ...revision, unexpectedTopLevel: true },
    });
    assert.ok(observation.kind === "stats" && observation.data?.generatedAt === 7);
  } finally { console.error = original; }
});
