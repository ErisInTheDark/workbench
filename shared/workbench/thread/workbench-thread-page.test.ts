/*
 * No production exports. Tests protect stable thread-page continuation and strict browser request admission. Keywords: thread, page, cursor, contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../../codex/generated/app-server/v2/Thread.ts";
import type { WorkbenchThreadTurnHistoryEntry } from "../../types.ts";
import {
  readWorkbenchThreadPageNextCursor,
  WorkbenchThreadPageReadParamsSchema,
} from "./workbench-thread-page.ts";

function thread(turnIds: string[], historyIds: string[]): Thread & {
  workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[];
} {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/repo",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: "thread",
    modelProvider: "openai",
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: turnIds.map((id) => ({
      completedAt: 2,
      durationMs: 1,
      error: null,
      id,
      items: [],
      itemsView: "full",
      startedAt: 1,
      status: "completed",
    })),
    updatedAt: 2,
    workbenchTurnHistory: historyIds.map((turnId) => ({
      completedAt: 2,
      durationMs: 1,
      itemCount: 0,
      itemIds: [],
      loadState: turnIds.includes(turnId) ? "loaded" as const : "unloaded" as const,
      startedAt: 1,
      status: "completed" as const,
      turnId,
    })),
  };
}

test("thread page continuation stays anchored to the earliest loaded turn", () => {
  assert.equal(readWorkbenchThreadPageNextCursor(thread(["newest"], ["oldest", "middle", "newest"])), "newest");
  assert.equal(readWorkbenchThreadPageNextCursor(thread(["middle"], ["oldest", "middle", "newest"])), "middle");
  assert.equal(readWorkbenchThreadPageNextCursor(thread(["oldest", "middle", "newest"], ["oldest", "middle", "newest"])), null);
});

test("thread page requests require either the first-page null cursor or one non-empty continuation", () => {
  assert.equal(WorkbenchThreadPageReadParamsSchema.safeParse({ cursor: null, threadId: "thread" }).success, true);
  assert.equal(WorkbenchThreadPageReadParamsSchema.safeParse({ cursor: "turn", threadId: "thread" }).success, true);
  assert.equal(WorkbenchThreadPageReadParamsSchema.safeParse({ cursor: "", threadId: "thread" }).success, false);
  assert.equal(WorkbenchThreadPageReadParamsSchema.safeParse({ threadId: "thread" }).success, false);
});
