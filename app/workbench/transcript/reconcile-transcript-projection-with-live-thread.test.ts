/*
 * No production exports. Tests protect temporary SQLite shadow liveness without masking durable history gaps. Keywords: transcript, SQLite, projection, live, overlay, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { ThreadPayload } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import reconcileTranscriptProjectionWithLiveThread from "./reconcile-transcript-projection-with-live-thread";

function message(id: string, text: string): ThreadItem {
  return { id, memoryCitation: null, delivery: null, questions: null, phase: "commentary", text, type: "agentMessage" };
}

function turn(id: string, status: Turn["status"], items: ThreadItem[]): Turn {
  return {
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
    error: null,
    id,
    items,
    itemsView: "full",
    startedAt: 1,
    status,
  };
}

function thread(turns: Turn[]): ThreadPayload {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/project",
    forkedFromId: null,
    harness: "codex",
    id: "thread",
    isDraft: false,
    model: null,
    name: "Thread",
    nextPageCursor: null,
    path: null,
    preview: "Thread",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: turns.some(({ status }) => status === "inProgress") ? "active" : "completed",
    tokenUsage: null,
    turnHistory: turns.map((entry) => ({
      completedAt: entry.completedAt,
      durationMs: entry.durationMs,
      itemCount: entry.items.length,
      itemIds: entry.items.map(({ id }) => id),
      itemTimeline: [],
      loadState: "loaded",
      startedAt: entry.startedAt,
      status: entry.status,
      turnId: entry.id,
    })),
    turns,
    updatedAt: 2,
  };
}

function projection(turns: Turn[]): WorkbenchTranscriptProjection {
  const projectedTurns = turns.map<WorkbenchProjectedTranscriptTurn>((entry, turnIndex) => ({
    ...entry,
    itemTimeline: [],
    turnIndex,
  }));
  const canonicalItems = projectedTurns.flatMap((entry) => entry.items.map((payload) => ({
    itemId: payload.id,
    itemIndex: 0,
    payload,
    turnId: entry.id,
  }))).map((entry, itemIndex) => ({ ...entry, itemIndex }));
  return {
    browseResultEntries: [],
    display: planCanonicalTranscriptDisplay({
      items: canonicalItems,
      turns: projectedTurns.map(({ id, turnIndex }) => ({ turnId: id, turnIndex })),
    }),
    hasPreviousTurns: false,
    thread: {
      activityAt: 2,
      createdAt: 1,
      id: "thread",
      projectId: "project",
      projectRoot: "C:/project",
      title: "Thread",
      updatedAt: 2,
    },
    turnHistory: thread(turns).turnHistory,
    turns: projectedTurns,
  };
}

function mergeLiveTurn(incomingTurn: Turn, liveTurn: Turn | undefined): Turn {
  return liveTurn ? { ...incomingTurn, ...liveTurn, items: liveTurn.items } : incomingTurn;
}

test("a missing active tail stays live without filling completed history gaps", () => {
  const durableTurn = turn("durable", "completed", [message("durable-item", "durable")]);
  const activeTurn = turn("active", "inProgress", [message("live-item", "streaming")]);
  const result = reconcileTranscriptProjectionWithLiveThread({
    mergeLiveTurn,
    projection: projection([durableTurn]),
    thread: thread([durableTurn, activeTurn]),
  });

  assert.deepEqual(result.turns.map(({ id }) => id), ["durable", "active"]);
  assert.equal(result.turns[1]?.turnIndex, 1);
  assert.deepEqual(result.display.segments.flatMap(({ items }) => items.map(({ id }) => id)), [
    "durable-item",
    "live-item",
  ]);
  assert.equal(result.turnHistory.at(-1)?.turnId, "active");
  assert.equal(result.turnHistory.at(-1)?.loadState, "loaded");

  const completedGap = turn("missing-completed", "completed", [message("missing-item", "missing")]);
  const completedResult = reconcileTranscriptProjectionWithLiveThread({
    mergeLiveTurn,
    projection: projection([durableTurn]),
    thread: thread([durableTurn, completedGap]),
  });
  assert.deepEqual(completedResult.turns.map(({ id }) => id), ["durable"]);
});

test("canonical active turns replace the virtual tail by identity without duplicates", () => {
  const canonicalTurn = turn("active", "inProgress", [message("live-item", "old")]);
  const liveTurn = turn("active", "inProgress", [message("live-item", "new")]);
  const result = reconcileTranscriptProjectionWithLiveThread({
    mergeLiveTurn,
    projection: projection([canonicalTurn]),
    thread: thread([liveTurn]),
  });

  assert.deepEqual(result.turns.map(({ id }) => id), ["active"]);
  assert.equal(result.turns[0]?.items.length, 1);
  assert.equal(result.turns[0]?.items[0]?.type, "agentMessage");
  assert.equal(
    result.turns[0]?.items[0]?.type === "agentMessage"
      ? result.turns[0].items[0].text
      : null,
    "new",
  );
  assert.deepEqual(result.display.segments.flatMap(({ items }) => items.map(({ id }) => id)), ["live-item"]);
});
