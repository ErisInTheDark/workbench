/*
 * No production exports. Tests protect serialized selected-thread subscription replacement and deduplicated parity reporting. Keywords: transcript, parity, lifecycle, subscription.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadPayload } from "../../types";
import {
  transcriptSnapshotTables,
  type WorkbenchTranscriptParityDiagnostic,
  type WorkbenchTranscriptSnapshot,
  type WorkbenchTranscriptSnapshotRows,
  type WorkbenchTranscriptSubscribeParams,
} from "../database/transcript/workbench-transcript-contract";
import ThreadTranscriptParityController from "./ThreadTranscriptParityController";

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
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
  return Object.fromEntries(Object.keys(transcriptSnapshotTables).map((name) => [name, []])) as WorkbenchTranscriptSnapshotRows;
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
      next_item_index: 0,
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
  const controller = new ThreadTranscriptParityController({
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
  assert.match(events[1] ?? "", /^unsubscribe:thread-transcript-parity:1$/u);
  assert.equal(events[2], "subscribe:two");
  controller.dispose();
});

test("a failed subscription reports immediately without poisoning replacement work", async () => {
  const errors: Error[] = [];
  const events: string[] = [];
  let subscriptions = 0;
  const controller = new ThreadTranscriptParityController({
    available: true,
    onError: (error) => { errors.push(error); },
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
  assert.deepEqual(errors.map(({ message }) => message), ["subscription failed"]);

  controller.select({ browseResultEntries: [], thread: thread("two") });
  await flush();
  await flush();
  assert.deepEqual(events, [
    "subscribe:one",
    "unsubscribe:thread-transcript-parity:1",
    "subscribe:two",
  ]);
  controller.dispose();
});

test("disposal owns an in-flight subscription failure without reporting it", async () => {
  const errors: Error[] = [];
  let rejectSubscription: ((error: Error) => void) | null = null;
  const controller = new ThreadTranscriptParityController({
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
  const controller = new ThreadTranscriptParityController({
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
  listener(null);
  controller.select({ browseResultEntries: [], thread: { ...selected } });
  await flush();

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.scope, "turn");
  controller.dispose();
});

test("the subscription follows the exact loaded turns and replaces itself when that set changes", async () => {
  const events: Array<
    | { kind: "subscribe"; params: WorkbenchTranscriptSubscribeParams }
    | { kind: "unsubscribe"; subscriptionId: string }
  > = [];
  const controller = new ThreadTranscriptParityController({
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
        subscriptionId: "thread-transcript-parity:1",
        threadId: "thread",
        turnIds: ["turn-2"],
        turnLimit: 4,
      },
    },
    { kind: "unsubscribe", subscriptionId: "thread-transcript-parity:1" },
    {
      kind: "subscribe",
      params: {
        subscriptionId: "thread-transcript-parity:2",
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
  const controller = new ThreadTranscriptParityController({
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

  controller.setAvailable(true);
  await flush();
  assert.deepEqual(events, ["subscribe:thread-transcript-parity:2"]);

  controller.setAvailable(false);
  controller.setAvailable(true);
  await flush();
  await flush();
  assert.deepEqual(events, [
    "subscribe:thread-transcript-parity:2",
    "subscribe:thread-transcript-parity:4",
  ]);
  controller.dispose();
});

test("a queued parity report cannot cross a disconnect generation", async () => {
  const listeners = new Map<string, (snapshot: WorkbenchTranscriptSnapshot | null) => void>();
  const reports: string[] = [];
  let releaseFirstReport: (() => void) | null = null;
  const controller = new ThreadTranscriptParityController({
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
