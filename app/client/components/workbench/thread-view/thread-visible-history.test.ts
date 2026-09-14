/*
 * Exports:
 * - No production exports; Node tests protect unlimited retained thread scrollback and its lazy-load trigger. Keywords: thread, history, pagination, scrollback, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import { getThreadVisibleHistoryEntries } from "./thread-visible-history";

function createTurn(turnId: string): Turn {
  return {
    completedAt: 2,
    durationMs: 1_000,
    error: null,
    id: turnId,
    items: [],
    itemsView: "full",
    startedAt: 1,
    status: "completed",
  };
}

function createHistoryEntry(
  turnId: string,
  loadState: WorkbenchThreadTurnHistoryEntry["loadState"],
): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: 2,
    durationMs: 1_000,
    itemCount: 0,
    loadState,
    startedAt: 1,
    status: "completed",
    turnId,
  };
}

function turnIds(entries: readonly WorkbenchThreadTurnHistoryEntry[]) {
  return entries.map((entry) => entry.turnId);
}

test("retains every loaded turn beyond the former eight-turn ceiling", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `turn-${index + 1}`);
  const entries = getThreadVisibleHistoryEntries({
    turnHistory: ids.map((turnId) => createHistoryEntry(turnId, "loaded")),
    turns: ids.map(createTurn),
  });

  assert.deepEqual(turnIds(entries), ids);
});

test("retains accumulated turns while exposing only the next unloaded predecessor", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `turn-${index + 1}`);
  const turnHistory = ids.map((turnId, index) => createHistoryEntry(turnId, index >= 7 ? "loaded" : "unloaded"));

  assert.deepEqual(
    turnIds(getThreadVisibleHistoryEntries({ turnHistory, turns: ids.slice(7).map(createTurn) })),
    ids.slice(6),
  );
  assert.deepEqual(
    turnIds(getThreadVisibleHistoryEntries({ turnHistory, turns: ids.slice(6).map(createTurn) })),
    ids.slice(5),
  );
});

test("retains every loaded turn when no turn-history index is available", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `turn-${index + 1}`);

  assert.deepEqual(
    turnIds(getThreadVisibleHistoryEntries({ turnHistory: [], turns: ids.map(createTurn) })),
    ids,
  );
});
