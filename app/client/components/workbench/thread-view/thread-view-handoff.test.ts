/*
 * No production exports. Protect continuous draft display until the matching canonical first message is renderable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DraftIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { EMPTY_THREAD_STORE_STATE, type ThreadTurnsSlice } from "../../../workbench/thread/ThreadStore";
import { resolveThreadViewHandoff, type ThreadViewDisplay } from "./thread-view-handoff";

const draft: ThreadViewDisplay = {
  projectId: "project", viewInstanceKey: "draft",
  target: { kind: "draft", draftId: DraftIdSchema.parse("draft") },
};
const accepted: ThreadViewDisplay = {
  ...draft, target: { kind: "provider", harness: "codex", threadId: ThreadReferenceSchema.parse("accepted") },
};

function turns(withInput: boolean, threadId = "accepted"): ThreadTurnsSlice {
  const projection: WorkbenchTranscriptProjection = {
    thread: { id: threadId, projectId: "project", projectRoot: "/project", cwd: "/project",
      title: "", createdAt: 1, updatedAt: 1, activityAt: 1 },
    turns: [{ id: "turn", status: "inProgress", itemsView: "full", error: null, startedAt: 1,
      completedAt: null, durationMs: null, turnIndex: 0, itemTimeline: [],
      items: withInput ? [{ type: "userMessage", id: "input", clientId: null, content: [] }] : [] }],
    turnHistory: [], approvalEntries: [], browseResultEntries: [], questionnaireEntries: [], steerEntries: [],
    display: { orderedItems: [], segments: [] }, hasPreviousTurns: false,
  };
  if (withInput) projection.display.segments.push({
    id: "turn", turnId: "turn", isFirstForTurn: true, isLastForTurn: true,
    kind: "canonical", ownsCanonicalTerminal: true, items: projection.turns[0]!.items,
  });
  return { ...EMPTY_THREAD_STORE_STATE.turns, transcript: { status: "ready", threadId, projection } };
}

test("the accepted identity cannot replace its preview until both head and initial input arrive", () => {
  for (const readiness of [
    { headReady: false, turns: EMPTY_THREAD_STORE_STATE.turns },
    { headReady: true, turns: EMPTY_THREAD_STORE_STATE.turns },
    { headReady: true, turns: turns(false) },
    { headReady: false, turns: turns(true) },
    { headReady: true, turns: turns(true, "unrelated") },
  ]) {
    assert.equal(resolveThreadViewHandoff(draft, accepted, { ...readiness, hasDraftInput: true }), draft);
  }
  assert.equal(resolveThreadViewHandoff(draft, accepted, {
    hasDraftInput: true, headReady: true, turns: turns(true),
  }), accepted);
});

test("failed canonical loading retains the preview, while unrelated navigation never does", () => {
  const readiness = {
    hasDraftInput: true, headReady: false,
    turns: { ...EMPTY_THREAD_STORE_STATE.turns,
      transcript: { status: "failed", threadId: "accepted", projection: null, message: "offline" } } satisfies ThreadTurnsSlice,
  };
  assert.equal(resolveThreadViewHandoff(draft, accepted, readiness), draft);
  for (const requested of [
    { ...accepted, viewInstanceKey: "different-view" },
    { ...accepted, projectId: "other-project" },
  ]) assert.equal(resolveThreadViewHandoff(draft, requested, readiness), requested);
  assert.equal(resolveThreadViewHandoff(draft, accepted, { ...readiness, hasDraftInput: false }), accepted);
  assert.equal(resolveThreadViewHandoff(accepted, accepted, readiness), accepted, "a completed handoff never restores its preview");
});
