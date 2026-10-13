/*
 * No exports. Protect deferred body hydration: shared batched reads, per-item notification, retry, and fencing on rebind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTranscriptSnapshotRows, type WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import ThreadTranscriptBodies from "./ThreadTranscriptBodies";

function snapshot(itemIds: readonly string[]): WorkbenchTranscriptSnapshot {
  const rows = emptyTranscriptSnapshotRows();
  itemIds.forEach((publicId, index) => {
    rows.threadItems.push({
      created_at: 1, id: index + 1, item_position: index, public_id: publicId, thread_id: "thread", turn_id: "turn",
      type: "assistantMessage", updated_at: 1,
    });
    rows.itemIdentities.push({ id: publicId, thread_id: "thread" });
    rows.threadItemAssistantMessages.push({
      item_id: index + 1, item_type: "assistantMessage", phase: "commentary", state: "completed", text: publicId,
    });
  });
  return {
    hasPreviousTurns: false, loadedTurnIds: ["turn"], rows,
    thread: {
      activity_at: 1, archived: 0, created_at: 1, id: "thread", identity_origin: "workbench", next_turn_index: 1, pinned: 0,
      project_id: "project", project_root: "C:/project", snoozed: 0, title: "Thread", transcript_content_version: 1, updated_at: 1,
    },
    turns: [{
      created_at: 1, duration_ms: 1, ended_at: 2, harness_id: "codex", id: "turn", identity_origin: "workbench",
      native_location: "C:/project", native_thread_id: "thread", native_turn_id: "turn", started_at: 1, state: "completed",
      thread_id: "thread", turn_index: 0,
    }],
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("same-tick demands share one read and notify only their own items", async () => {
  const reads: string[][] = [];
  const bodies = new ThreadTranscriptBodies();
  bodies.bind(async itemIds => { reads.push(itemIds); return snapshot(itemIds); });
  let aChanges = 0;
  bodies.subscribe("a", () => { aChanges += 1; });
  bodies.load("a");
  bodies.load("b");
  bodies.load("a");
  await flush();
  assert.deepEqual(reads, [["a", "b"]]);
  assert.equal(bodies.get("a").status, "loaded");
  assert.equal(aChanges, 2, "loading, then loaded");
  bodies.load("a");
  await flush();
  assert.equal(reads.length, 1, "loaded bodies are not read again");
});

test("failures surface and retry reads again", async () => {
  let fail = true;
  const bodies = new ThreadTranscriptBodies();
  bodies.bind(async itemIds => {
    if (fail) throw new Error("gone");
    return snapshot(itemIds);
  });
  const error = console.error;
  console.error = () => {};
  try {
    bodies.load("a");
    await flush();
  } finally { console.error = error; }
  const failed = bodies.get("a");
  assert.equal(failed.status, "failed");
  fail = false;
  bodies.retry("a");
  await flush();
  assert.equal(bodies.get("a").status, "loaded");
});

test("rebinding discards bodies and fences reads of the previous transcript", async () => {
  let resolve!: (value: WorkbenchTranscriptSnapshot) => void;
  const bodies = new ThreadTranscriptBodies();
  bodies.bind(() => new Promise(settle => { resolve = settle; }));
  bodies.load("a");
  await flush();
  bodies.bind(null);
  resolve(snapshot(["a"]));
  await flush();
  assert.equal(bodies.get("a").status, "idle");
});
