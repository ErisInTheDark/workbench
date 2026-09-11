/*
 * No exports. Tests exercise standalone paging, real SQL projection/text publication and socket lifetime fencing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CodexAppServerClient } from "workbench-shared/codex/app-server-client";
import { WORKBENCH_THREAD_PAGE_READ_METHOD, type WorkbenchThreadPageResponse } from "workbench-shared/workbench/thread/workbench-thread-page";
import {
  transcriptSnapshotTables, workbenchTranscriptNotifications, workbenchTranscriptOperations,
  type WorkbenchTranscriptSnapshot, type WorkbenchTranscriptSnapshotRows,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { createTranscriptLayout, createTranscriptLayoutPatch, type TranscriptStreamUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import StandaloneThreadController from "./StandaloneThreadController";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const threadId = randomUUID();
  const notifications = new Set<(notification: { method: string; params: unknown }) => void>();
  const disconnects = new Set<() => void>();
  let reconnect = () => {};
  let closed = false;
  let subscriptionId = "";
  let failSubscription = false;
  let readPage: (cursor: string | null) => Promise<WorkbenchThreadPageResponse> = async cursor => page(cursor ? "older" : "latest", cursor ? null : "latest");
  const requests: Array<{ method: string; params: { cursor?: string | null; turnIds?: string[]; subscriptionId?: string } }> = [];
  const notify = (method: string, params: unknown) => { for (const listener of notifications) listener({ method, params }); };
  const page = (id: string, nextCursor: string | null): WorkbenchThreadPageResponse => ({
    thread: {
      id: threadId, cwd: "C:/project", createdAt: 1, updatedAt: 2, status: { type: "active", activeFlags: [] },
      agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", ephemeral: false,
      extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", modelProvider: "openai",
      model: null, projectId: null, reasoningEffort: null, name: null, parentThreadId: null, path: null,
      preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session",
      source: "appServer", threadSource: null,
      turns: [{ id, status: "inProgress", items: [], itemsView: "full", startedAt: 1, completedAt: null, durationMs: null, error: null }],
      workbenchTurnHistory: ["older", "latest"].map(turnId => ({
        turnId, status: "inProgress", loadState: "loaded", itemIds: [], itemTimeline: [], itemCount: 0,
        startedAt: 1, completedAt: null, durationMs: null,
      })),
    } as WorkbenchThreadPageResponse["thread"],
    nextCursor, questionnaireEntries: [], steerEntries: [], browseResultEntries: [],
  });
  const client = {
    connectSocket: async () => notify(workbenchTranscriptNotifications.capabilities.method, { protocolVersion: 3 }),
    onWorkbenchNotification: (listener: (notification: { method: string; params: unknown }) => void) => {
      notifications.add(listener); return () => { notifications.delete(listener); };
    },
    onConnectionClose: (listener: () => void) => { disconnects.add(listener); return () => { disconnects.delete(listener); }; },
    onReconnect: (listener: () => void) => { reconnect = listener; return () => { reconnect = () => {}; }; },
    close: () => { closed = true; },
    sendRequest: async (request: (typeof requests)[number]) => {
      requests.push(request);
      if (request.method === WORKBENCH_THREAD_PAGE_READ_METHOD) return { id: 1, result: await readPage(request.params.cursor ?? null) };
      if (request.method === workbenchTranscriptOperations.subscribe.method && failSubscription) throw new Error("subscription unavailable");
      if (request.method === workbenchTranscriptOperations.subscribe.method) subscriptionId = request.params.subscriptionId!;
      return { id: 1, result: { subscribed: true, unsubscribed: true, reported: true } };
    },
  } as unknown as CodexAppServerClient;
  const owner = new StandaloneThreadController(threadId, { client });
  return {
    owner, threadId, requests, page,
    get closed() { return closed; },
    set read(operation: typeof readPage) { readPage = operation; },
    set failSubscription(value: boolean) { failSubscription = value; },
    disconnect() { for (const listener of disconnects) listener(); },
    reconnect() { reconnect(); },
    stream(update: TranscriptStreamUpdate) {
      notify(workbenchTranscriptNotifications.streamed.method, { subscriptionId, update });
    },
  };
}

test("standalone uses bounded pages and shared SQL text projection without provider polling", async () => {
  const f = fixture();
  try {
    await f.owner.refresh();
    await flush();
    const snapshot: WorkbenchTranscriptSnapshot = {
      thread: { id: f.threadId, identity_origin: "legacy", project_id: "project", project_root: "C:/project", title: "",
        archived: 0, pinned: 0, snoozed: 0, transcript_content_version: 1, next_turn_index: 1,
        created_at: 1, updated_at: 2, activity_at: 2 },
      turns: [{ id: "latest", identity_origin: "legacy", thread_id: f.threadId, turn_index: 0, harness_id: "codex",
        native_location: "C:/project", native_thread_id: f.threadId, native_turn_id: "latest", state: "inProgress",
        created_at: 1, started_at: 1, ended_at: null, duration_ms: null }],
      loadedTurnIds: ["latest"], hasPreviousTurns: true,
      rows: Object.fromEntries(Object.keys(transcriptSnapshotTables).map(name => [name, []])) as unknown as WorkbenchTranscriptSnapshotRows,
    };
    snapshot.rows.threadItems = [{ id: 1, public_id: null, source_id: "plan", thread_id: f.threadId, turn_id: "latest",
      item_position: 0, type: "plan", created_at: 1, updated_at: 1 }];
    snapshot.rows.threadItemPlans = [{ item_id: 1, item_type: "plan", text: "start" }];
    const projected = projectWorkbenchTranscript(snapshot);
    assert.ok(projected.success);
    f.stream({ kind: "structure", reset: true, snapshot, removedItemIds: [], hasPreviousTurns: true,
      layout: createTranscriptLayoutPatch(null, createTranscriptLayout(projected.data)) });
    assert.equal(f.owner.getSnapshot().source.status, "ready");
    f.stream({ kind: "text", threadId: f.threadId, turnId: "latest", itemId: "plan", field: "planText", index: null, append: true, text: " end" });
    assert.equal(f.owner.text.getSnapshot({
      source: { kind: "sqlite", sourceKey: `codex:${f.threadId}` }, threadId: f.threadId, turnId: "latest", itemId: "plan", field: "planText", index: null,
    }), "start end");
    await f.owner.loadPrevious();
    await flush();
    assert.deepEqual(f.owner.getSnapshot().thread?.turns.map(turn => turn.id), ["older", "latest"]);
    assert.deepEqual(f.requests.filter(request => request.method === WORKBENCH_THREAD_PAGE_READ_METHOD).map(request => request.params.cursor), [null, "latest"]);
    assert.ok(f.requests.every(request => request.method.startsWith("workbench/")));
  } finally {
    f.owner.dispose();
    assert.equal(f.closed, true);
  }
});

test("standalone discards disconnected pages and allows scoped failure retry", async () => {
  const f = fixture();
  let release!: (page: WorkbenchThreadPageResponse) => void;
  f.read = () => new Promise(resolve => { release = resolve; });
  try {
    const initial = f.owner.refresh();
    await flush();
    f.disconnect();
    release(f.page("stale", null));
    await initial;
    assert.equal(f.owner.getSnapshot().thread, null);
    f.read = async () => { throw new Error("page unavailable"); };
    f.reconnect();
    await flush();
    assert.equal(f.owner.getSnapshot().error, "page unavailable");
    f.read = async () => f.page("latest", null);
    await f.owner.refresh();
    assert.equal(f.owner.getSnapshot().error, null);
    assert.deepEqual(f.owner.getSnapshot().thread?.turns.map(turn => turn.id), ["latest"]);
  } finally { f.owner.dispose(); }
});

test("standalone refresh retries a failed SQL subscription without recreating its socket", async () => {
  const f = fixture();
  try {
    f.failSubscription = true;
    await f.owner.refresh();
    await flush();
    assert.equal(f.owner.getSnapshot().source.status, "failed");
    f.failSubscription = false;
    await f.owner.refresh();
    await flush();
    assert.equal(f.requests.filter(request => request.method === workbenchTranscriptOperations.subscribe.method).length, 2);
    assert.notEqual(f.owner.getSnapshot().source.status, "failed");
    assert.equal(f.closed, false);
  } finally { f.owner.dispose(); }
});
