/*
 * Exports:
 * - No production exports; Node tests protect age, surface, scheduling, and inactive thread-history retention.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { createWorkbenchUnfinishedTurnInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { withWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import ThreadHistoryRetentionController, {
  getThreadHistoryRetentionCandidates,
  getThreadTurnLastUpdateMs,
  THREAD_HISTORY_RETENTION_AGE_MS,
} from "./ThreadHistoryRetentionController.ts";

function history(turnId: string, completedAt: number | null): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt, durationMs: null, itemCount: 0, loadState: "loaded",
    startedAt: completedAt === null ? null : completedAt - 1, status: "completed", turnId,
  };
}

function thread(completedAtSeconds: readonly number[]): ThreadPayload {
  const turnHistory = completedAtSeconds.map((completedAt, index) => history(`turn-${index}`, completedAt));
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    harness: "codex", id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"), isDraft: false,
    model: null, name: null, path: null, preview: "", reasoningEffort: null, serviceTier: null, source: "codex",
    status: "idle", tokenUsage: null, turnHistory,
    turns: turnHistory.map((entry) => ({
      completedAt: entry.completedAt, durationMs: null, error: null, id: entry.turnId,
      items: [], itemsView: "full", startedAt: entry.startedAt, status: "completed",
    })),
    updatedAt: completedAtSeconds.at(-1) ?? 1,
  };
}

test("turn last update uses the latest canonical turn or item-timeline timestamp", () => {
  const source = thread([10]);
  const turn = source.turns[0]!;
  const entry = {
    ...source.turnHistory[0]!,
    itemTimeline: [{
      completedAt: 14_000, firstSeenAt: 11_000, itemId: "item",
      lastSeenAt: 15_000, startedAt: 12_000,
    }],
  };
  assert.equal(getThreadTurnLastUpdateMs(turn, entry), 15_000);
  assert.equal(getThreadTurnLastUpdateMs(
    { ...turn, completedAt: null, startedAt: null },
    { ...entry, completedAt: null, itemTimeline: [], startedAt: null },
  ), null);
});

test("mounted retention is strict after one hour and always protects current plus predecessor", () => {
  const now = 10 * THREAD_HISTORY_RETENTION_AGE_MS;
  const source = thread([
    (now - THREAD_HISTORY_RETENTION_AGE_MS - 1) / 1_000,
    (now - THREAD_HISTORY_RETENTION_AGE_MS) / 1_000,
    (now - 2 * THREAD_HISTORY_RETENTION_AGE_MS) / 1_000,
    (now - 2 * THREAD_HISTORY_RETENTION_AGE_MS) / 1_000,
  ]);
  assert.deepEqual(getThreadHistoryRetentionCandidates(source, now), {
    nextReviewAtMs: now + 1,
    turnIds: ["turn-0"],
  });
  source.turnHistory[0] = { ...source.turnHistory[0]!, completedAt: null, startedAt: null };
  source.turns[0] = { ...source.turns[0]!, completedAt: null, startedAt: null };
  assert.deepEqual(getThreadHistoryRetentionCandidates(source, now).turnIds, []);
});

test("mounted retention protects every physical turn in the previous logical continuation", () => {
  const now = 10 * THREAD_HISTORY_RETENTION_AGE_MS;
  const source = thread([1, 2, 3, 4]);
  source.turns[2] = {
    ...source.turns[2]!,
    items: [{
      clientId: null,
      content: createWorkbenchUnfinishedTurnInput(),
      id: "hidden-continuation",
      type: "userMessage",
    }],
  };

  assert.deepEqual(getThreadHistoryRetentionCandidates(source, now).turnIds, ["turn-0"]);
});

test("mounted retention waits for transient provider admission to settle", () => {
  const now = 10 * THREAD_HISTORY_RETENTION_AGE_MS;
  const source = thread([1, 2, 3]);
  source.turns[1] = withWorkbenchTurnAdmission(source.turns[1]!, "providerPending");

  assert.deepEqual(getThreadHistoryRetentionCandidates(source, now), {
    nextReviewAtMs: null,
    turnIds: [],
  });
});

test("all mounted surfaces must be at latest before one scheduled retention pass can trim", () => {
  let now = 10_000;
  const scheduled = new Set<{ at: number; callback: () => void }>();
  const releases: string[][] = [];
  let source = thread([1, 2, 3, 4]);
  const controller = new ThreadHistoryRetentionController({
    now: () => now,
    releaseTurns: (turnIds) => {
      releases.push([...turnIds]);
      const removed = new Set(turnIds);
      source = { ...source, turns: source.turns.filter((turn) => !removed.has(turn.id)) };
      return source;
    },
    schedule: (callback, delayMs) => {
      const task = { at: now + delayMs, callback };
      scheduled.add(task);
      return () => { scheduled.delete(task); };
    },
  });
  controller.select(source);
  const first = controller.acquireSurface();
  const second = controller.acquireSurface();
  first.setAtEnd(true);
  second.setAtEnd(false);
  now += 2 * THREAD_HISTORY_RETENTION_AGE_MS;
  for (const task of [...scheduled]) if (task.at <= now && scheduled.delete(task)) task.callback();
  assert.deepEqual(releases, []);

  second.setAtEnd(true);
  assert.deepEqual(releases, [["turn-0", "turn-1"]]);
  assert.equal(scheduled.size, 0);
  first.release();
  second.release();
  controller.dispose();
});

test("scroll-away cancels the next exact age review and disposal leaves no scheduled work", () => {
  let now = 4_000_000;
  const scheduled = new Set<{ at: number; callback: () => void }>();
  const source = thread([
    (now - THREAD_HISTORY_RETENTION_AGE_MS + 100) / 1_000,
    now / 1_000,
    now / 1_000,
  ]);
  const controller = new ThreadHistoryRetentionController({
    now: () => now,
    releaseTurns: () => source,
    schedule: (callback, delayMs) => {
      const task = { at: now + delayMs, callback };
      scheduled.add(task);
      return () => { scheduled.delete(task); };
    },
  });
  controller.select(source);
  const surface = controller.acquireSurface();
  surface.setAtEnd(true);
  assert.deepEqual([...scheduled].map(({ at }) => at), [now + 101]);
  surface.setAtEnd(false);
  assert.equal(scheduled.size, 0);
  surface.setAtEnd(true);
  assert.equal(scheduled.size, 1);
  controller.dispose();
  assert.equal(scheduled.size, 0);
  now += 1_000;
});
