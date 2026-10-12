/*
 * No exports. Protect lossless item-envelope partitioning and byte-bounded reservoir packing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptSnapshot,
} from "../database/transcript/workbench-transcript-contract.ts";
import { projectWorkbenchTranscript } from "./workbench-transcript-projection.ts";
import {
  composeWorkbenchTranscriptWindow,
  packWorkbenchTranscriptEnvelopes,
  prependWorkbenchTranscriptWindow,
  splitWorkbenchTranscriptSnapshot,
} from "./workbench-transcript-envelope.ts";

function snapshot(): WorkbenchTranscriptSnapshot {
  const rows = emptyTranscriptSnapshotRows();
  const turns = ["older", "current"].map((id, turnIndex) => ({
    id,
    identity_origin: "legacy" as const,
    thread_id: "thread",
    turn_index: turnIndex,
    harness_id: "codex",
    native_location: "C:/project",
    native_thread_id: "thread",
    native_turn_id: id,
    state: "completed" as const,
    created_at: 1,
    started_at: 1,
    ended_at: 2,
    duration_ms: 1,
  }));
  for (const [index, turn] of turns.entries()) {
    const publicId = `${index + 1}d29f440-0770-471a-8c55-b672c8181cf0`;
    rows.threadItems.push({
      id: index + 1,
      public_id: publicId,
      thread_id: "thread",
      turn_id: turn.id,
      item_position: 0,
      type: "assistantMessage",
      created_at: 1,
      updated_at: 1,
    });
    rows.itemIdentities.push({ id: publicId, thread_id: "thread" });
    rows.itemSourceAliases.push({
      component_index: 0,
      component_kind: "item",
      id: index + 1,
      item_identity_id: publicId,
      reference: `native-${index}`,
      source_kind: "stable",
      thread_id: "thread",
      turn_id: turn.id,
    });
    rows.threadItemAssistantMessages.push({
      item_id: index + 1,
      item_type: "assistantMessage",
      state: "completed",
      phase: "commentary",
      text: turn.id,
    });
  }
  return {
    approvalOutcomes: [{
      itemId: rows.threadItems[1]!.public_id,
      outcome: "approved",
      resolvedAt: 2,
      threadId: "thread",
      turnId: "current",
    }],
    expiredItemPayloads: [{ expiredAt: 3, itemId: rows.threadItems[0]!.id }],
    hasPreviousTurns: false,
    loadedTurnIds: turns.map(turn => turn.id),
    rows,
    thread: {
      activity_at: 2,
      archived: 0,
      created_at: 1,
      id: "thread",
      identity_origin: "legacy",
      next_turn_index: 2,
      pinned: 0,
      project_id: "project",
      project_root: "C:/project",
      snoozed: 0,
      title: "Thread",
      transcript_content_version: 1,
      updated_at: 2,
    },
    turns,
  };
}

test("arbitrary envelope cuts recompose to the same projected transcript", () => {
  const source = snapshot();
  const partition = splitWorkbenchTranscriptSnapshot(source);
  assert.equal(partition.envelopes.length, 2);
  assert.deepEqual(partition.envelopes.map(envelope => envelope.itemId), [
    source.rows.threadItems[0]!.public_id,
    source.rows.threadItems[1]!.public_id,
  ]);
  assert.deepEqual(partition.envelopes[0]!.snapshot.rows.itemSourceAliases, [
    source.rows.itemSourceAliases[0],
  ]);
  assert.deepEqual(partition.envelopes[1]!.snapshot.approvalOutcomes, source.approvalOutcomes);
  assert.deepEqual(partition.envelopes[0]!.snapshot.expiredItemPayloads, source.expiredItemPayloads);

  const recomposed = composeWorkbenchTranscriptWindow(
    partition.catalog,
    [...partition.envelopes].reverse(),
    { hasPreviousItems: false },
  );
  assert.deepEqual(projectWorkbenchTranscript(recomposed), projectWorkbenchTranscript(source));
});

test("byte packing never splits an envelope and admits one oversize envelope", () => {
  const partition = splitWorkbenchTranscriptSnapshot(snapshot());
  const firstBytes = partition.envelopes[0]!.retainedBytes;
  const packed = packWorkbenchTranscriptEnvelopes(partition.envelopes, firstBytes);
  assert.equal(packed.envelopes.length, 1);
  assert.equal(packed.retainedBytes, firstBytes);
  assert.equal(packed.hasMore, true);

  const oversize = packWorkbenchTranscriptEnvelopes(partition.envelopes, 1);
  assert.equal(oversize.envelopes.length, 1);
  assert.ok(oversize.retainedBytes > 1);
  assert.equal(oversize.hasMore, true);
});

test("an older credited window prepends without losing the newer window", () => {
  const source = snapshot();
  const partition = splitWorkbenchTranscriptSnapshot(source);
  const newer = composeWorkbenchTranscriptWindow(partition.catalog, [partition.envelopes[1]!], {
    hasPreviousItems: true,
  });
  const older = composeWorkbenchTranscriptWindow(partition.catalog, [partition.envelopes[0]!], {
    hasPreviousItems: false,
  });
  const merged = prependWorkbenchTranscriptWindow(newer, older, { hasPreviousItems: false });
  assert.deepEqual(projectWorkbenchTranscript(merged), projectWorkbenchTranscript(source));
  assert.equal(merged.hasPreviousTurns, false);
});
