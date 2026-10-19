/*
 * No production exports. Regression wards protect pasted thread fixtures rendering through the canonical projection unchanged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { threadPayloadToProjection } from "./thread-render-lab-projection";

function message(id: string, text: string): Turn["items"][number] {
  return { delivery: null, id, memoryCitation: null, phase: "commentary", questions: null, text, type: "agentMessage" };
}

function turn(id: string, items: Turn["items"]): Turn {
  return { completedAt: 2, durationMs: 1_000, error: null, id, items, itemsView: "full", startedAt: 1, status: "completed" };
}

test("thread fixtures keep their turn and item order and carry item timelines", () => {
  const turns = [turn("t1", [message("a", "one"), message("b", "two")]), turn("t2", []), turn("t3", [message("c", "three")])];
  const timeline = [{ completedAt: 2_000, firstSeenAt: 1_000, itemId: "a", lastSeenAt: 2_000, startedAt: 1_000 }];
  const projection = threadPayloadToProjection({
    createdAt: 1, cwd: "/repo", id: "thread", name: "fixture", preview: "", turns, updatedAt: 3,
    turnHistory: [{ completedAt: 2, durationMs: 1_000, itemCount: 2, itemIds: ["a", "b"], itemTimeline: timeline, startedAt: 1, status: "completed", turnId: "t1" }],
  } as unknown as ThreadPayload);

  assert.deepEqual(projection.display.segments.map(segment => [segment.turnId, segment.items.map(item => item.id)]), [
    ["t1", ["a", "b"]], ["t2", []], ["t3", ["c"]],
  ]);
  assert.deepEqual(projection.turns[0]!.itemTimeline, timeline);
  assert.deepEqual(projection.turns[2]!.itemTimeline, []);
});
