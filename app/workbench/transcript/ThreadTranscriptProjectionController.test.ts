/*
 * No production exports. Tests protect explicit SQLite source state, immediate live projection publication, serialized subscription replacement, and deferred deduplicated parity reporting. Keywords: transcript, projection, parity, lifecycle, subscription.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import {
  transcriptSnapshotTables,
  type WorkbenchTranscriptParityDiagnostic,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSnapshotRows,
  type WorkbenchTranscriptSubscribeParams,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import ThreadTranscriptProjectionController from "./ThreadTranscriptProjectionController";

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function flushComparison() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function thread(id: string, turnIds = ["turn"]): ThreadPayload {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/project",
    forkedFromId: null,
    harness: "codex",
    id,
    isDraft: false,
    model: null,
    name: "Thread",
    path: null,
    preview: "Thread",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: "completed",
    tokenUsage: null,
    turnHistory: turnIds.map((turnId) => ({
      completedAt: 2,
      durationMs: 1_000,
      itemCount: 1,
      itemIds: [`plan:${turnId}`],
      itemTimeline: [],
      loadState: "loaded" as const,
      startedAt: 1,
      status: "completed",
      turnId,
    })),
    turns: turnIds.map((turnId) => ({
      completedAt: 2,
      durationMs: 1_000,
      error: null,
      id: turnId,
      items: [{ id: `plan:${turnId}`, text: "planned", type: "plan" as const }],
      itemsView: "full" as const,
      startedAt: 1,
      status: "completed" as const,
    })),
    updatedAt: 2,
  };
}

function emptyRows(): WorkbenchTranscriptSnapshotRows {
  return Object.fromEntries(
    Object.keys(transcriptSnapshotTables).map((name) => [name, []]),
  ) as unknown as WorkbenchTranscriptSnapshotRows;
}

function emptySnapshot(threadId: string): WorkbenchTranscriptSnapshot {
  return {
    hasPreviousTurns: false,
    loadedTurnIds: [],
    rows: emptyRows(),
    thread: {
      activity_at: 2_000,
      archived: 0,
      created_at: 1_000,
      id: threadId,
      next_turn_index: 0,
      pinned: 0,
      project_id: "project",
      project_root: "C:/project",
      snoozed: 0,
      title: "Thread",
      transcript_content_version: 1,
      updated_at: 2_000,
    },
    turns: [],
  };
}

test("selection changes serialize unsubscribe before the replacement subscription", async () => {
  const events: string[] = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params) => { events.push(`subscribe:${params.threadId}`); },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("one") });
  await flush();
  controller.select({ browseResultEntries: [], thread: thread("two") });
  await flush();
  await flush();

  assert.equal(events[0], "subscribe:one");
  assert.match(events[1] ?? "", /^unsubscribe:thread-transcript-projection:1$/u);
  assert.equal(events[2], "subscribe:two");
  controller.dispose();
});

test("a failed subscription reports immediately without poisoning replacement work", async () => {
  const errors: Error[] = [];
  const events: string[] = [];
  const states: string[] = [];
  let subscriptions = 0;
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: (error) => { errors.push(error); },
    onStateChange: (state) => { states.push(state.status); },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params) => {
        subscriptions += 1;
        events.push(`subscribe:${params.threadId}`);
        if (subscriptions === 1) throw new Error("subscription failed");
      },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("one") });
  await flush();
  assert.deepEqual(errors.map(({ message }) => message), [
    "Workbench transcript projection lifecycle failed. stage=subscription threadId=one turnIds=turn: subscription failed",
  ]);
  assert.equal(states.at(-1), "failed");

  controller.select({ browseResultEntries: [], thread: thread("two") });
  await flush();
  await flush();
  assert.deepEqual(events, [
    "subscribe:one",
    "unsubscribe:thread-transcript-projection:1",
    "subscribe:two",
  ]);
  controller.dispose();
});

test("disposal owns an in-flight subscription failure without reporting it", async () => {
  const errors: Error[] = [];
  let rejectSubscription: ((error: Error) => void) | null = null;
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: (error) => { errors.push(error); },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async () => await new Promise<void>((_resolve, reject) => {
        rejectSubscription = reject;
      }),
      unsubscribe: async () => undefined,
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("one") });
  await flush();
  assert.ok(rejectSubscription);
  controller.dispose();
  (rejectSubscription as (error: Error) => void)(new Error("socket closed during disposal"));
  await flush();

  assert.deepEqual(errors, []);
});

test("repeated comparison emits one bounded report and later absence clears comparison state", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const reports: WorkbenchTranscriptParityDiagnostic[] = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      reportParity: async (diagnostic) => { reports.push(diagnostic); },
      subscribe: async (params: WorkbenchTranscriptSubscribeParams, listener) => {
        listeners.set(params.subscriptionId, listener);
      },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });
  const selected = thread("thread");
  controller.select({ browseResultEntries: [], thread: selected });
  await flush();
  const listener = [...listeners.values()][0];
  assert.ok(listener);
  listener(emptySnapshot("thread"));
  listener(emptySnapshot("thread"));
  await flushComparison();
  await flush();
  listener(null);
  controller.select({ browseResultEntries: [], thread: { ...selected } });
  await flush();

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.scope, "turn");
  controller.dispose();
});

test("reconciled projections publish and real invalidations clear the browser read model", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const publications: Array<{ status: string; threadId: string | null }> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: () => undefined,
    onStateChange: (state) => {
      publications.push({
        status: state.status,
        threadId: "threadId" in state ? state.threadId : null,
      });
    },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("one") });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("one"));
  await flushComparison();
  assert.deepEqual(publications.at(-1), { status: "ready", threadId: "one" });

  [...listeners.values()][0]?.(null);
  assert.deepEqual(publications.at(-1), { status: "absent", threadId: "one" });

  controller.select({ browseResultEntries: [], thread: thread("two") });
  assert.deepEqual(publications.at(-1), { status: "loading", threadId: "two" });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("two"));
  await flushComparison();
  assert.deepEqual(publications.at(-1), { status: "ready", threadId: "two" });

  controller.setAvailable(false);
  assert.deepEqual(publications.at(-1), { status: "unavailable", threadId: "two" });
  controller.setAvailable(true);
  assert.deepEqual(publications.at(-1), { status: "loading", threadId: "two" });
  await flush();
  controller.dispose();
  assert.deepEqual(publications.at(-1), { status: "idle", threadId: null });
});

test("projection reconciliation failure becomes a terminal source failure", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const states: Array<{ message?: string; status: string }> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onError: () => undefined,
    onStateChange: (state) => {
      states.push({
        ...("message" in state ? { message: state.message } : {}),
        status: state.status,
      });
    },
    reconcileProjection: () => {
      throw new Error("reconciliation exploded");
    },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("thread") });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("thread"));

  assert.deepEqual(states.at(-1), {
    message: "SQLite transcript projection failed: reconciliation exploded",
    status: "failed",
  });
  controller.dispose();
});

test("same-thread loaded-turn changes retain and reconcile the previous projection", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const publications: Array<string | null> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    onStateChange: (state) => {
      publications.push("projection" in state ? state.projection?.thread.title ?? null : null);
    },
    reconcileProjection: (projection, selection) => ({
      ...projection,
      thread: {
        ...projection.thread,
        title: selection.thread.turns.map(({ id }) => id).join(","),
      },
    }),
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("thread", ["turn-1"]) });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("thread"));
  await flushComparison();
  assert.equal(publications.at(-1), "turn-1");

  controller.select({ browseResultEntries: [], thread: thread("thread", ["turn-1", "turn-2"]) });
  assert.equal(publications.at(-1), "turn-1,turn-2");
  controller.dispose();
});

test("successive live text snapshots publish immediately without scheduling parity work", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const publications: string[] = [];
  const scheduled: Array<() => void> = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    cancelComparison: () => undefined,
    onStateChange: (state) => {
      if ("projection" in state && state.projection) publications.push(state.projection.thread.title);
    },
    reconcileProjection: (projection, selection) => {
      const item = selection.thread.turns[0]?.items[0];
      return {
        ...projection,
        thread: {
          ...projection.thread,
          title: item?.type === "plan" ? item.text : "",
        },
      };
    },
    scheduleComparison: (callback) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });
  const selected = thread("thread");
  controller.select({ browseResultEntries: [], thread: selected });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("thread"));
  assert.deepEqual(publications, ["planned"]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();

  const withText = (text: string): ThreadPayload => ({
    ...selected,
    turns: selected.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) => item.type === "plan" ? { ...item, text } : item),
    })),
  });
  controller.select({ browseResultEntries: [], thread: withText("partial") });
  controller.select({ browseResultEntries: [], thread: withText("partial and complete") });

  assert.deepEqual(publications.slice(-2), ["partial", "partial and complete"]);
  assert.equal(scheduled.length, 0);
  controller.dispose();
});

test("rapid selected-thread updates defer and coalesce comparison work", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const reports: WorkbenchTranscriptParityDiagnostic[] = [];
  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    cancelComparison: (timer) => { scheduled.delete(timer as unknown as number); },
    scheduleComparison: (callback) => {
      const timer = ++nextTimer;
      scheduled.set(timer, callback);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    transcripts: {
      reportParity: async (diagnostic) => { reports.push(diagnostic); },
      subscribe: async (params, listener) => { listeners.set(params.subscriptionId, listener); },
      unsubscribe: async (params) => { listeners.delete(params.subscriptionId); },
    },
    turnLimit: 4,
  });
  const selected = thread("thread");
  controller.select({ browseResultEntries: [], thread: selected });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("thread"));
  for (let index = 0; index < 100; index += 1) {
    controller.select({
      browseResultEntries: [],
      thread: { ...selected, updatedAt: selected.updatedAt + index },
    });
  }

  assert.equal(scheduled.size, 1);
  [...scheduled.values()][0]?.();
  await flush();
  assert.equal(reports.length, 1);
  controller.dispose();
});

test("the subscription follows the exact loaded turns and replaces itself when that set changes", async () => {
  const events: Array<
    | { kind: "subscribe"; params: WorkbenchTranscriptSubscribeParams }
    | { kind: "unsubscribe"; subscriptionId: string }
  > = [];
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params) => { events.push({ kind: "subscribe", params }); },
      unsubscribe: async ({ subscriptionId }) => { events.push({ kind: "unsubscribe", subscriptionId }); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("thread", ["turn-2"]) });
  await flush();
  controller.select({ browseResultEntries: [], thread: thread("thread", ["turn-1", "turn-2"]) });
  await flush();
  await flush();

  assert.deepEqual(events, [
    {
      kind: "subscribe",
      params: {
        subscriptionId: "thread-transcript-projection:1",
        threadId: "thread",
        turnIds: ["turn-2"],
        turnLimit: 4,
      },
    },
    { kind: "unsubscribe", subscriptionId: "thread-transcript-projection:1" },
    {
      kind: "subscribe",
      params: {
        subscriptionId: "thread-transcript-projection:2",
        threadId: "thread",
        turnIds: ["turn-1", "turn-2"],
        turnLimit: 4,
      },
    },
  ]);
  controller.dispose();
});

test("selection stays inert until capability and reconnect capability creates a fresh subscription", async () => {
  const events: string[] = [];
  const states: string[] = [];
  const controller = new ThreadTranscriptProjectionController({
    onStateChange: (state) => { states.push(state.status); },
    transcripts: {
      reportParity: async () => undefined,
      subscribe: async (params) => { events.push(`subscribe:${params.subscriptionId}`); },
      unsubscribe: async (params) => { events.push(`unsubscribe:${params.subscriptionId}`); },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("thread") });
  await flush();
  assert.deepEqual(events, []);
  assert.equal(states.at(-1), "loading");

  controller.setAvailable(true);
  await flush();
  assert.deepEqual(events, ["subscribe:thread-transcript-projection:2"]);

  controller.setAvailable(false);
  assert.equal(states.at(-1), "unavailable");
  controller.setAvailable(true);
  await flush();
  await flush();
  assert.deepEqual(events, [
    "subscribe:thread-transcript-projection:2",
    "subscribe:thread-transcript-projection:4",
  ]);
  controller.dispose();
});

test("a queued parity report cannot cross a disconnect generation", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const reports: string[] = [];
  let releaseFirstReport: (() => void) | null = null;
  const controller = new ThreadTranscriptProjectionController({
    available: true,
    transcripts: {
      reportParity: async (diagnostic) => {
        reports.push(diagnostic.threadId);
        if (reports.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstReport = resolve;
          });
        }
      },
      subscribe: async (params, listener) => {
        listeners.set(params.subscriptionId, listener);
      },
      unsubscribe: async (params) => {
        listeners.delete(params.subscriptionId);
      },
    },
    turnLimit: 4,
  });

  controller.select({ browseResultEntries: [], thread: thread("one") });
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("one"));
  await flushComparison();
  await flush();

  controller.select({ browseResultEntries: [], thread: thread("two") });
  await flush();
  await flush();
  [...listeners.values()][0]?.(emptySnapshot("two"));
  controller.setAvailable(false);
  (releaseFirstReport as (() => void) | null)?.();
  await flush();
  await flush();

  assert.deepEqual(reports, ["one"]);
  controller.dispose();
});
