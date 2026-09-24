/*
 * No exports. Protect incremental placement edits without retransmitting unchanged history.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptSnapshotTables, type WorkbenchTranscriptSnapshot } from "../database/transcript/workbench-transcript-contract.ts";
import { projectWorkbenchTranscript } from "./workbench-transcript-projection.ts";
import { applyTranscriptLayoutPatch, applyTranscriptStructure, createTranscriptLayout, createTranscriptLayoutPatch, type TranscriptLayout } from "./thread-transcript-stream.ts";

test("layout edits preserve retained order through append, middle replacement and removal", () => {
  const initial: TranscriptLayout = {
    turns: ["a", "b"], history: ["a", "b"], segments: [],
    items: Array.from({ length: 100 }, (_, index) => ({ itemId: `item-${index}`, turnId: "a", itemIndex: index })),
  };
  const appended = { ...initial, items: [...initial.items, { itemId: "new", turnId: "b", itemIndex: 100 }] };
  const append = createTranscriptLayoutPatch(initial, appended);
  assert.equal(append.items?.values.length, 1);
  assert.equal(append.turns, undefined);
  assert.deepEqual(applyTranscriptLayoutPatch(initial, append), appended);
  const replaced = { ...appended, items: appended.items.map((item, index) => index === 50 ? { ...item, itemId: "replacement" } : item) };
  const replacement = createTranscriptLayoutPatch(appended, replaced);
  assert.equal(replacement.items?.values.length, 1);
  assert.deepEqual(applyTranscriptLayoutPatch(appended, replacement), replaced);
  const removed = { ...replaced, items: replaced.items.slice(0, -1) };
  assert.deepEqual(applyTranscriptLayoutPatch(replaced, createTranscriptLayoutPatch(replaced, removed)), removed);
});

test("a current-turn structural update leaves historical render inputs stable", () => {
  const rows = Object.fromEntries(Object.keys(transcriptSnapshotTables).map(name => [name, []])) as unknown as WorkbenchTranscriptSnapshot["rows"];
  const snapshot: WorkbenchTranscriptSnapshot = {
    hasPreviousTurns: false, loadedTurnIds: ["older", "current"], rows,
    thread: {
      activity_at: 2, archived: 0, created_at: 1, id: "thread", identity_origin: "legacy",
      next_turn_index: 2, pinned: 0, project_id: "project", project_root: "C:/project",
      snoozed: 0, title: "Thread", transcript_content_version: 1, updated_at: 2,
    },
    turns: ["older", "current"].map((id, turn_index) => ({
      id, identity_origin: "legacy" as const, thread_id: "thread", turn_index, harness_id: "codex",
      native_location: "C:/project", native_thread_id: "thread", native_turn_id: id,
      state: turn_index ? "inProgress" as const : "completed" as const,
      created_at: 1, started_at: 1, ended_at: turn_index ? null : 2, duration_ms: turn_index ? null : 1,
    })),
  };
  for (const [index, turnId] of ["older", "current"].entries()) {
    const id = `${index + 1}d29f440-0770-471a-8c55-b672c8181cf0`;
    rows.threadItems.push({
      id: index + 1, public_id: id, thread_id: "thread", turn_id: turnId,
      item_position: 0, type: "assistantMessage", created_at: 1, updated_at: 1,
    });
    rows.itemIdentities.push({ id, thread_id: "thread" });
    rows.threadItemAssistantMessages.push({
      item_id: index + 1, item_type: "assistantMessage", state: "completed",
      phase: "commentary", text: turnId,
    });
  }
  const baseline = projectWorkbenchTranscript(snapshot);
  assert.ok(baseline.success);
  const layout = createTranscriptLayout(baseline.data);
  const changedSnapshot: WorkbenchTranscriptSnapshot = {
    ...snapshot,
    loadedTurnIds: ["current"],
    turns: [{ ...snapshot.turns[1]!, state: "completed", ended_at: 3, duration_ms: 2 }],
    rows: {
      ...rows,
      threadItems: [{ ...rows.threadItems[1]!, updated_at: 3 }],
      itemIdentities: [rows.itemIdentities[1]!],
      threadItemAssistantMessages: [{ ...rows.threadItemAssistantMessages[1]!, text: "changed" }],
    },
  };
  const changed = applyTranscriptStructure(baseline.data, {
    kind: "structure", reset: false, snapshot: changedSnapshot,
    removedItemIds: [], layout: {}, hasPreviousTurns: false,
  }, layout);
  assert.equal(changed.turns[0], baseline.data.turns[0]);
  assert.equal(changed.display.segments[0], baseline.data.display.segments[0]);
  assert.notEqual(changed.turns[1], baseline.data.turns[1]);
  assert.notEqual(changed.display.segments[1], baseline.data.display.segments[1]);
  assert.equal(changed.turns[1]?.items[0]?.type, "agentMessage");
  if (changed.turns[1]?.items[0]?.type === "agentMessage") assert.equal(changed.turns[1].items[0].text, "changed");

  const removedId = rows.threadItems[1]!.public_id;
  const removalLayout = {
    ...layout,
    items: layout.items.filter(item => item.itemId !== removedId),
    segments: layout.segments.map(segment => segment.turnId === "current" ? { ...segment, count: 0 } : segment),
  };
  const removed = applyTranscriptStructure(changed, {
    kind: "structure", reset: false,
    snapshot: { ...changedSnapshot, rows: { ...changedSnapshot.rows, threadItems: [], itemIdentities: [], threadItemAssistantMessages: [] } },
    removedItemIds: [removedId], layout: createTranscriptLayoutPatch(layout, removalLayout), hasPreviousTurns: false,
  }, removalLayout);
  assert.equal(removed.turns[0], changed.turns[0]);
  assert.deepEqual(removed.turns[1]?.items, []);
  assert.equal(removed.display.segments[0], changed.display.segments[0]);
  assert.deepEqual(removed.display.segments[1]?.items, []);
});
