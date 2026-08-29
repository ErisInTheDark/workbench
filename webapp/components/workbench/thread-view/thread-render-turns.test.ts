/*
 * No production exports. Node tests protect logical rendering across hidden unfinished-turn continuations. Keywords: thread, rendering, continuation, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchThreadTurnHistoryEntry } from "../../../lib/types";
import { createWorkbenchThreadRecoveryInput, createWorkbenchUnfinishedTurnInput } from "../../../lib/workbench/thread/thread-recovery-message";
import projectThreadRenderTurns from "./thread-render-turns";

function textInput(text: string) {
  return { text, text_elements: [], type: "text" as const };
}

function turn(id: string, status: Turn["status"], startedAt: number, completedAt: number | null, items: Turn["items"]): Turn {
  return {
    completedAt,
    durationMs: completedAt === null ? null : (completedAt - startedAt) * 1_000,
    error: null,
    id,
    items,
    itemsView: "full",
    startedAt,
    status,
  };
}

function history(value: Turn): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: value.completedAt,
    durationMs: value.durationMs,
    itemCount: value.items.length,
    itemIds: value.items.map((item) => item.id),
    itemTimeline: value.items.map((item) => ({
      completedAt: value.completedAt === null ? null : value.completedAt * 1_000,
      firstSeenAt: value.startedAt === null ? null : value.startedAt * 1_000,
      itemId: item.id,
      lastSeenAt: value.completedAt === null ? null : value.completedAt * 1_000,
      startedAt: value.startedAt === null ? null : value.startedAt * 1_000,
    })),
    loadState: "loaded",
    startedAt: value.startedAt,
    status: value.status,
    turnId: value.id,
  };
}

function thread(turns: Turn[]): ThreadPayload {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    createdAt: 1,
    cwd: "C:/workspace",
    forkedFromId: null,
    harness: "codex",
    id: "thread",
    isDraft: false,
    model: null,
    name: null,
    path: null,
    preview: "",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: turns.at(-1)?.status ?? "completed",
    tokenUsage: null,
    turnHistory: turns.map(history),
    turns,
    updatedAt: 4,
  };
}

function browseEntry(turnId: string, entryKey: string): WorkbenchBrowseResultEntry {
  return {
    action: "open",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: null,
    durationMs: 10,
    entryKey,
    recordedAt: 1,
    session: null,
    state: "completed",
    threadId: "thread",
    turnId,
  };
}

test("unfinished continuation keeps prior output in one active logical turn", () => {
  const first = turn("first", "completed", 1, 2, [
    { clientId: null, content: [textInput("start")], id: "user", type: "userMessage" },
    { id: "final", memoryCitation: null, phase: "final_answer", text: "not actually done", type: "agentMessage" },
  ]);
  const second = turn("second", "inProgress", 2, null, [
    { clientId: null, content: createWorkbenchUnfinishedTurnInput(), id: "hidden", type: "userMessage" },
    { content: [], id: "reasoning", summary: ["continuing"], type: "reasoning" },
  ]);
  const projection = projectThreadRenderTurns(thread([first, second]), [
    browseEntry("first", "browse-first"),
    browseEntry("second", "browse-second"),
  ]);

  assert.equal(projection.thread.turns.length, 1);
  assert.deepEqual(projection.thread.turns[0], {
    ...second,
    durationMs: null,
    items: [...first.items, second.items[1]!],
    startedAt: 1,
  });
  assert.deepEqual(projection.thread.turnHistory.map((entry) => ({
    itemIds: entry.itemIds,
    timelineIds: entry.itemTimeline?.map((item) => item.itemId),
    turnId: entry.turnId,
  })), [{
    itemIds: ["user", "final", "reasoning"],
    timelineIds: ["user", "final", "hidden", "reasoning"],
    turnId: "second",
  }]);
  assert.deepEqual(projection.browseResultEntries.map((entry) => entry.turnId), ["second", "second"]);
});

test("repeated unfinished continuations stay one completed logical turn", () => {
  const first = turn("first", "completed", 1, 2, [{ id: "first-answer", memoryCitation: null, phase: "final_answer", text: "one", type: "agentMessage" }]);
  const second = turn("second", "completed", 2, 3, [
    { clientId: null, content: createWorkbenchUnfinishedTurnInput(), id: "hidden-two", type: "userMessage" },
    { id: "second-answer", memoryCitation: null, phase: "final_answer", text: "two", type: "agentMessage" },
  ]);
  const third = turn("third", "completed", 3, 4, [
    { clientId: null, content: createWorkbenchUnfinishedTurnInput(), id: "hidden-three", type: "userMessage" },
    { id: "third-answer", memoryCitation: null, phase: "final_answer", text: "three", type: "agentMessage" },
  ]);
  const projection = projectThreadRenderTurns(thread([first, second, third]));

  assert.equal(projection.thread.turns.length, 1);
  assert.equal(projection.thread.turns[0]?.id, "third");
  assert.equal(projection.thread.turns[0]?.durationMs, 3_000);
  assert.deepEqual(projection.thread.turns[0]?.items.map((item) => item.id), ["first-answer", "second-answer", "third-answer"]);
  assert.deepEqual(projection.thread.turnHistory.map((entry) => entry.turnId), ["third"]);
});

test("ordinary and interrupted-recovery turns keep their provider boundaries", () => {
  const interrupted = turn("interrupted", "interrupted", 1, 2, []);
  const recovery = turn("recovery", "completed", 2, 3, [
    { clientId: null, content: createWorkbenchThreadRecoveryInput(), id: "reload-resume", type: "userMessage" },
  ]);
  const ordinary = turn("ordinary", "completed", 3, 4, [
    { clientId: null, content: [textInput("next")], id: "ordinary-user", type: "userMessage" },
  ]);

  assert.deepEqual(
    projectThreadRenderTurns(thread([interrupted, recovery, ordinary])).thread.turns.map((value) => value.id),
    ["interrupted", "recovery", "ordinary"],
  );
});
