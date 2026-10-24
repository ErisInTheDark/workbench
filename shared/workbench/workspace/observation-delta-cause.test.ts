/*
 * No exports. Protect which workspace deltas count as heartbeats (left out of logs) and which keep a named cause.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observationDeltaCause } from "./observation-delta-cause.ts";
import type { ObservationDelta } from "./observation-patch.ts";

const THREAD = "447d65f7-ee0b-4ce7-9f11-664931b0b55c";
const PROJECT = "5de07ba4-bf29-4cfb-bb77-1f2e3d4c5b6a";
const entry = (delta: ObservationDelta): ObservationDelta => ({
  objects: { data: { set: { revision: 17 }, collections: { entries: { update: [{ key: `claude:${THREAD}`, delta }] } } } },
});

test("one activity tick reads as a heartbeat in every view that shows the thread", () => {
  const tick = [
    { objects: { summaries: { objects: { [THREAD]: { objects: { summary: { objects: { row: { set: { activityAt: 1 } } } } } } } } } },
    { collections: { projects: { update: [{ key: PROJECT, delta: {
      set: { lastThreadUpdateAt: 1, revision: 4 },
      collections: { unsettledThreads: { update: [{ key: THREAD, delta: { set: { activityAt: 1 } } }] } },
    } }] } } },
    { collections: { projects: { update: [{ key: PROJECT, delta: { objects: { sidebar: {
      set: { revision: 9 }, collections: { entries: { update: [{ key: `claude:${THREAD}`, delta: { set: { activityAt: 1 } } }] } },
    } } } }] } } },
    entry({ set: { activityAt: 1 } }),
  ] satisfies ObservationDelta[];
  for (const delta of tick) assert.deepEqual(observationDeltaCause(delta), { cause: "activity", heartbeat: true });
});

test("token usage ticks, alone or with activity, are heartbeats too", () => {
  for (const delta of [
    { objects: { runtime: { objects: { [THREAD]: { set: { tokenUsage: {} } } } } } },
    entry({ set: { activityAt: 1, tokenUsage: {} } }),
  ] satisfies ObservationDelta[]) assert.deepEqual(observationDeltaCause(delta), { cause: "activity", heartbeat: true });
});

test("activity riding with real news, or a thread joining or leaving a list, is not a heartbeat", () => {
  assert.equal(observationDeltaCause(entry({ set: { activityAt: 1, title: "Renamed" } })), null);
  assert.equal(observationDeltaCause({ collections: { entries: { add: [{ key: `claude:${THREAD}`, item: { activityAt: 1 } }] } } }), null);
  assert.equal(observationDeltaCause({ collections: { entries: {
    update: [{ key: `claude:${THREAD}`, delta: { set: { activityAt: 1 } } }], move: [{ key: `claude:${THREAD}`, after: null }],
  } } }), null);
  assert.equal(observationDeltaCause({ set: { revision: 3 } }), null, "bookkeeping alone names no cause");
});

test("named causes keep their line", () => {
  assert.deepEqual(observationDeltaCause({ objects: { data: { set: { revision: 2 }, objects: { rows: { collections: {
    composerDrafts: { update: [{ key: PROJECT, delta: { set: { text: "hi", updatedAt: 2 } } }] },
    composerDraftReferences: { add: [{ key: "a", item: {} }] },
  } } } } } }), { cause: "draft saved", heartbeat: false });
  assert.deepEqual(observationDeltaCause({ objects: { data: { objects: { rows: { collections: {
    lastProjectSelections: { add: [{ key: "single", item: {} }] },
  } } } } } }), { cause: "selection saved", heartbeat: false });
});
