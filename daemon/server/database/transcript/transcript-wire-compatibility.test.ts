/* No production exports. Keywords: transcript, compatibility, identity, opaque fallback. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  conformWorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscriptItems } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import { transcriptSnapshotForProtocol } from "./transcript-wire-compatibility.ts";

function snapshot(): WorkbenchTranscriptSnapshot {
  const parsed = conformWorkbenchTranscriptSnapshot({
    thread: {
      id: "thread", project_id: "project", project_root: "/", title: "thread", archived: 0, pinned: 0, snoozed: 0,
      transcript_content_version: 3, next_turn_index: 1, created_at: 1, updated_at: 2, activity_at: 2,
    },
    turns: [], loadedTurnIds: [], hasPreviousTurns: false,
    rows: {
      itemIdentities: [{
        id: "d0d57186-ee99-4d64-ab09-c8fd7f75b5ea",
        thread_id: "thread",
      }],
      itemSourceAliases: [{
        id: 1,
        turn_id: "turn",
        source_kind: "provisional",
        reference: "item-1",
        component_kind: "item",
        component_index: 0,
        thread_id: "thread",
        item_identity_id: "d0d57186-ee99-4d64-ab09-c8fd7f75b5ea",
      }, {
        id: 2,
        turn_id: "turn",
        source_kind: "stable",
        reference: "fco_one",
        component_kind: "item",
        component_index: 0,
        thread_id: "thread",
        item_identity_id: "d0d57186-ee99-4d64-ab09-c8fd7f75b5ea",
      }, {
        id: 3,
        turn_id: "turn",
        source_kind: "client",
        reference: "client-one",
        component_kind: "item",
        component_index: 0,
        thread_id: "thread",
        item_identity_id: "d0d57186-ee99-4d64-ab09-c8fd7f75b5ea",
      }],
      threadItems: [{
        id: 1, public_id: "d0d57186-ee99-4d64-ab09-c8fd7f75b5ea",
        thread_id: "thread", turn_id: "turn", item_position: 0,
        type: "functionCallOutput", created_at: 1, updated_at: 2,
      }],
      threadItemToolOutputs: [{
        item_id: 1, item_type: "functionCallOutput", name: "context", namespace: "workbench",
        body_kind: "text", body_text: "retained content", injection_accepted_at: 2,
      }],
    },
  });
  assert.ok(parsed.success);
  return parsed.data;
}

test("old-client projection preserves the same item as opaque context without changing canonical rows", () => {
  const original = snapshot();
  const wire = transcriptSnapshotForProtocol(original, 1)!;
  assert.equal(wire.rows.threadItems[0]?.type, "unknown");
  assert.equal((wire.rows.threadItems[0] as { source_id?: string } | undefined)?.source_id, "fco_one");
  assert.equal(original.rows.threadItems[0]?.type, "functionCallOutput");
  const conformed = conformWorkbenchTranscriptSnapshot(wire);
  assert.ok(conformed.success);
  const projected = projectWorkbenchTranscriptItems(conformed.data.rows);
  assert.ok(projected.success);
  const item = projected.data[0]?.item;
  assert.equal(item?.type, "generic");
  if (item?.type === "generic") assert.deepEqual(item.safeValue, {
    id: "fco_one", type: "functionCallOutput", name: "context", namespace: "workbench",
    output: "retained content", workbenchInjectionAcceptedAt: 2,
  });
  assert.equal(transcriptSnapshotForProtocol(original, 4), original);
  assert.equal(transcriptSnapshotForProtocol(null), null);
});
