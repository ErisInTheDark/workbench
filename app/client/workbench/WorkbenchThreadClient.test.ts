/*
 * Exports:
 * - No production exports; Node tests cover reads, retention, lifecycle fencing, canonical placement, streaming, admission, and questionnaire answer intent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchSteerHistoryEntry, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import { workbenchTranscriptNotifications } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { getWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import { withWorkbenchThreadItemIdentity } from "workbench-shared/workbench/thread/thread-item-identity";
import WorkbenchThreadClient, { type WorkbenchAcceptedIntent } from "./WorkbenchThreadClient.ts";
import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { ThreadMessageNotSentError } from "./thread/thread-message-submission.ts";
import type {
  WorkbenchThreadSidebarEntry,
  WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-state";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "owner": fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "background": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("background"),
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "pinned": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("pinned"),
    "root": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

type Listener = (event: { data?: string }) => void;
type SocketRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  workbenchHarness?: string;
  workbenchPromptContext?: Record<string, unknown>;
  workbenchThreadContextEntries?: { mode: string };
  workbenchThreadHydration?: Record<string, unknown>;
};

function wireThread(
  id: string,
  turnId = `${id}-turn`,
  turnStatus: Thread["turns"][number]["status"] = "inProgress",
): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id, modelProvider: "openai", name: null, parentThreadId: null, path: null,
    model: null, projectId: null, reasoningEffort: null,
    preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: `${id}-session`, source: "appServer",
    status: turnStatus === "inProgress" ? { activeFlags: [], type: "active" } : { type: "idle" },
    threadSource: null, turns: [{
      completedAt: turnStatus === "inProgress" ? null : 2,
      durationMs: turnStatus === "inProgress" ? null : 1,
      error: null,
      id: turnId,
      items: [],
      itemsView: "full",
      startedAt: 1,
      status: turnStatus,
    }],
    updatedAt: 1,
  };
}

function idleThreadWithStaleTurn(id = "thread", turnId = "turn") {
  return {
    ...wireThread(id, turnId, "inProgress"),
    status: { type: "idle" as const },
  };
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static current: FakeWebSocket;
  static intercept: ((socket: FakeWebSocket, request: SocketRequest) => boolean) | null = null;
  readonly OPEN = 1;
  readyState = 1;
  readonly requests: SocketRequest[] = [];
  observationRevision = 1;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) {
    FakeWebSocket.current = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  send(payload: string) {
    const message = JSON.parse(payload) as Omit<SocketRequest, "id"> & { id?: number };
    if (message.id === undefined) {
      return;
    }
    const request = { ...message, id: message.id };
    this.requests.push(request);
    if (FakeWebSocket.intercept?.(this, request)) {
      return;
    }
    if (request.method === "initialize") {
      queueMicrotask(() => this.respond(request.id, {}));
    } else if (request.method === "account/limits/read") {
      queueMicrotask(() => this.fail(request.id, "rate limits unavailable in test"));
    } else if (request.method === "thread/metadata/read") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { thread: wireThread(threadId) }));
    } else if (request.method === "thread/page/read") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, {
        browseResultEntries: [],
        nextCursor: null,
        questionnaireEntries: [],
        steerEntries: [],
        thread: wireThread(threadId),
      }));
    } else if (request.method === "thread/resume") {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, { model: "model", reasoningEffort: null, serviceTier: null, thread: wireThread(threadId) }));
    } else if (request.method === "thread/list") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (request.method === "questionnaires/pending/read") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (request.method === "questionnaire/respond") {
      queueMicrotask(() => this.respond(request.id, { ok: true, route: "live" }));
    } else if (request.method === "thread/stop" || request.method === "thread/compact" || request.method === "thread/goal/remove") {
      queueMicrotask(() => this.respond(request.id, { ok: true }));
    } else if (request.method === "thread/browse/read" || request.method === "thread/questionnaires/read" || request.method === "thread/steers/read") {
      queueMicrotask(() => this.respond(request.id, { data: [] }));
    } else if (isSteerRequest(request)) {
      const turnId = String(request.params?.expectedTurnId ?? "turn");
      queueMicrotask(() => this.respond(request.id, { kind: "steered", turnId }));
    } else if (isAdmissionRequest(request)) {
      const threadId = String(request.params?.threadId ?? "thread");
      queueMicrotask(() => this.respond(request.id, {
        kind: "started",
        turn: wireThread(threadId, `${threadId}-started`).turns[0],
      }));
    } else if (request.method === "workbench/transcript/subscribe") {
      queueMicrotask(() => this.respond(request.id, { subscribed: true }));
    } else if (request.method === "workbench/transcript/unsubscribe") {
      queueMicrotask(() => this.respond(request.id, { unsubscribed: true }));
    } else if (request.method === "workbench/thread-state/observe") {
      const target = request.params?.target as { threadId: string; harness?: string };
      queueMicrotask(() => this.respond(request.id, { observation: {
        ...request.params, entries: [{
          activityAt: 1, title: "Thread", entryKind: "thread",
          identity: { threadId: target.threadId, harness: target.harness ?? "codex" },
          metadata: { archived: false, pinned: true, snoozed: false },
          lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        }], error: null, freshness: "fresh", revision: 1, updateKind: "threadObservation",
      } }));
    } else if (request.method === "workbench/thread-state/release") {
      queueMicrotask(() => this.respond(request.id, { accepted: true }));
    } else if (request.method === "workbench/thread-state/intent/accept" || request.method === "workbench/thread-state/questionnaire/dismiss" || request.method === "workbench/thread-state/questionnaire/resolve") {
      queueMicrotask(() => this.respond(request.id, { accepted: true, revision: 1 }));
    } else {
      queueMicrotask(() => this.fail(request.id, `unexpected ${request.method}`));
    }
  }

  notify(method: string, params: unknown, workbenchHarness = "codex") {
    this.emit("message", { data: JSON.stringify({ method, params, workbenchHarness }) });
  }

  fail(id: number, message: string) {
    this.emit("message", { data: JSON.stringify({ error: { code: -32000, message }, id }) });
  }

  respond(id: number, result: unknown) {
    const method = this.requests.find(request => request.id === id)?.method;
    if (method === "thread/create" || method === "thread/metadata/read") {
      const response = result as { thread: Thread };
      result = { ...toThreadPayload(response.thread, "codex"), isDraft: false };
    }
    if (this.requests.find(request => request.id === id)?.method === "thread/page/read") {
      const page = result as {
        thread: Thread; model?: string | null; reasoningEffort?: string | null; serviceTier?: string | null;
        tokenUsage?: ThreadPayload["tokenUsage"]; nextCursor: string | null;
      };
      result = { ...page, thread: {
        ...toThreadPayload(page.thread, "codex", page.model ?? null, page.reasoningEffort ?? null, page.serviceTier ?? null),
        isDraft: false, tokenUsage: page.tokenUsage ?? null, nextPageCursor: page.nextCursor,
      } };
    }
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }

  private emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function isSteerRequest(request: SocketRequest) {
  return request.method === "thread/message/submit" && request.params?.intent === "steer";
}

function isAdmissionRequest(request: SocketRequest) {
  return request.method === "thread/message/submit" && request.params?.intent !== "steer";
}

async function waitForRequest(socket: FakeWebSocket, method: string, offset = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const requests = socket.requests.filter((request) => method === "steer"
      ? isSteerRequest(request)
      : method === "admission" ? isAdmissionRequest(request) : request.method === method);
    if (requests[offset]) {
      return requests[offset];
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${method} request ${offset}.`);
}

async function waitForCondition(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function installObservedThreadState(
  client: ReturnType<typeof WorkbenchThreadClient>,
  source: { activeProjectSnapshot: WorkbenchThreadSidebarSnapshot | null; durableQuestionnaireEntries: readonly WorkbenchThreadSidebarEntry[] },
) {
  client.installThreadStateSources({ activeProjectSnapshot: source.activeProjectSnapshot });
  const projectId = source.activeProjectSnapshot?.projectId ?? "project";
  for (const entry of source.durableQuestionnaireEntries) {
    if (entry.entryKind === "draft") continue;
    client.threadObservations.acquire(projectId, {
      kind: "provider", harness: entry.identity.harness,
      threadId: entry.entryKind === "subagent" ? entry.parentThreadId : entry.identity.threadId,
    });
  }
  await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "fixture-barrier" });
  const socket = FakeWebSocket.current;
  const revision = ++socket.observationRevision;
  for (const request of socket.requests.filter(request => request.method === "workbench/thread-state/observe" && request.params?.projectId === projectId)) {
    const target = request.params?.target as { harness: string; threadId: string };
    const entries = source.durableQuestionnaireEntries.filter(entry => entry.entryKind !== "draft"
      && entry.identity.harness === target.harness
      && (entry.entryKind === "thread" ? entry.identity.threadId === target.threadId : entry.parentThreadId === target.threadId));
    socket.notify("workbench/thread-state/updated", {
      ...request.params, entries, revision, error: null, freshness: "fresh", updateKind: "threadObservation",
    });
  }
}

async function installProjectThreadState(
  client: ReturnType<typeof WorkbenchThreadClient>,
  snapshot: WorkbenchThreadSidebarSnapshot,
) {
  await installObservedThreadState(client, {
    activeProjectSnapshot: snapshot,
    durableQuestionnaireEntries: snapshot.entries,
  });
}

async function withClient(
  run: (client: ReturnType<typeof WorkbenchThreadClient>, socket: FakeWebSocket) => Promise<void>,
  clientOptions: Parameters<typeof WorkbenchThreadClient>[0] = {},
) {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;
  FakeWebSocket.intercept = null;
  globalThis.window = {
    cancelAnimationFrame: (handle: number) => globalThis.clearTimeout(handle),
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(
      () => callback(performance.now()),
      0,
    ) as unknown as number,
    setTimeout: globalThis.setTimeout,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  const client = WorkbenchThreadClient({
    getProjectById: projectId => projectId === "owner" ? {
      id: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"), kind: "git", lastCommitTimeMs: null, name: "owner", relativePath: "owner", rootPath: "C:/owner",
      roots: [{ id: "owner", isPrimary: true, name: "owner", relativePath: "owner", rootPath: "C:/owner" }],
    } : undefined,
    ...clientOptions,
  });
  try {
    client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), root: "repo", rootPath: "C:/repo" });
    await client.refreshRateLimits();
    assert.ok(socket);
    await run(client, socket);
  } finally {
    FakeWebSocket.intercept = null;
    client.dispose();
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
}

function activeThread(
  harness: ThreadPayload["harness"] = "codex",
  id = "thread",
  turnStatus: ThreadPayload["turns"][number]["status"] = "inProgress",
): Extract<ThreadPayload, { isDraft: false }> {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    harness, id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id), isDraft: false, model: "model", name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: harness, status: turnStatus === "inProgress" ? "active" : "idle", tokenUsage: null, turnHistory: [],
    turns: [{ completedAt: turnStatus === "inProgress" ? null : 2, durationMs: turnStatus === "inProgress" ? null : 1, error: null, id: `${id === "thread" ? "" : `${id}-`}turn`, items: [], itemsView: "full", startedAt: 1, status: turnStatus }], updatedAt: 1,
  };
}

function historyEntry(turnId: string, loadState: WorkbenchThreadTurnHistoryEntry["loadState"]): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: turnId === "turn" ? null : 2,
    durationMs: turnId === "turn" ? null : 1,
    itemCount: 0,
    itemIds: [],
    loadState,
    startedAt: 1,
    status: turnId === "turn" ? "inProgress" : "completed",
    turnId,
  };
}

function wireThreadWithHistory(turnIds: string[], history: WorkbenchThreadTurnHistoryEntry[]) {
  const base = wireThread("thread");
  return {
    ...base,
    turns: turnIds.map((turnId) => ({
      ...base.turns[0]!,
      completedAt: turnId === "turn" ? null : 2,
      durationMs: turnId === "turn" ? null : 1,
      id: turnId,
      startedAt: turnId === "turn" ? 2 : 1,
      status: turnId === "turn" ? "inProgress" as const : "completed" as const,
    })),
    workbenchTurnHistory: history,
  };
}

function browseEntry(entryKey: string, turnId: string): WorkbenchBrowseResultEntry {
  return {
    action: "snapshot",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: null,
    detailKind: "result",
    detailLabel: null,
    detailText: entryKey,
    durationMs: 1,
    entryKey,
    recordedAt: turnId === "older" ? 1 : 2,
    session: "research",
    state: "completed",
    threadId: "thread",
    turnId,
  };
}

function questionnaireEntry(
  turnId: string,
  itemId: string,
): NonNullable<Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["questionnaireHistory"]>[number] {
  return {
    insertAfterItemId: `anchor-${turnId}`,
    insertAfterItemIndex: 0,
    itemId,
    request: { id: itemId, questions: [
      { id: "details", header: "details", question: "Proceed?", options: [], allowOther: true, isSecret: false },
    ], submitLabel: "Submit", summary: "", title: itemId },
    requestKey: "reused",
    resolvedAt: turnId === "older" ? 1 : 2,
    response: { answers: {} },
    threadId: "thread",
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
  };
}

test("voice document events traverse the shared socket and mounted daemon adapter", async () => withClient(async (client, socket) => {
  const daemon = new WorkbenchDaemonClient({
    request: (method, params) => client.requestWorkbench(method, params),
    onNotification: listener => client.onWorkbenchNotification(listener),
  });
  const texts: string[] = [];
  const unsubscribe = daemon.onVoiceEvent(event => {
    if (event.type === "document") texts.push(event.text);
  });
  socket.notify("voice/event", { type: "document", sessionId: "9d59d847-6d43-4616-8df7-f516abc8e19d", revision: 1, text: "edited" });
  assert.deepEqual(texts, ["edited"]);
  unsubscribe();
}));

test("normal message admission stays independent until transcript capability is advertised", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(source);
  const release = client.getThreadController("project", { kind: "provider", harness: "codex", threadId: source.id }).acquire("view");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.requests.some((request) => request.method.startsWith("workbench/transcript/")), false);

  await client.sendThreadMessage(source, [{ text: "hello", text_elements: [], type: "text" }]);
  assert.equal(socket.requests.some(isAdmissionRequest), true);
  assert.equal(socket.requests.some((request) => request.method === "turn/start"), false);
  assert.equal(socket.requests.some((request) => request.method.startsWith("workbench/transcript/")), false);

  socket.notify(workbenchTranscriptNotifications.capabilities.method, { protocolVersion: 1 });
  await waitForRequest(socket, "workbench/transcript/subscribe");
  release();
}));

test("new-turn admission projects the submitted message before the provider responds", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(source);
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (!isAdmissionRequest(request)) return false;
    admissionRequest = request;
    return true;
  };

  const send = client.sendThreadMessage(source, [{ text: "show me now", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");

  const pendingTurn = client.getSnapshot().currentThread?.turns.at(-1);
  assert.ok(pendingTurn);
  assert.equal(getWorkbenchTurnAdmission(pendingTurn), "providerPending");
  assert.deepEqual(getWorkbenchInputState(pendingTurn.items[0]!), {
    kind: "optimistic",
    placement: "initial",
    status: "pending",
  });
  const pendingMessage = pendingTurn.items[0];
  assert.equal(pendingMessage?.type, "userMessage");
  assert.equal(pendingMessage?.type === "userMessage" && pendingMessage.content[0]?.type === "text"
    ? pendingMessage.content[0].text
    : null, "show me now");

  const admittedTurn = wireThread("thread", "new-turn").turns[0]!;
  socket.respond(admissionRequest!.id, { kind: "started", turn: admittedTurn });
  await send;
  assert.equal(client.getSnapshot().currentThread?.turns.some((turn) => getWorkbenchTurnAdmission(turn) === "providerPending"), false);
  assert.equal(client.getSnapshot().currentThread?.turns.at(-1)?.id, "new-turn");
  assert.deepEqual(getWorkbenchInputState(client.getSnapshot().currentThread!.turns.at(-1)!.items[0]!), {
    kind: "optimistic",
    placement: "initial",
    status: "sent",
  });
}));

test("failed new-turn admission removes only its pending projection", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(source);
  const visibleBeforeSend = client.getSnapshot().currentThread!;
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (!isAdmissionRequest(request)) return false;
    admissionRequest = request;
    return true;
  };

  const send = client.sendThreadMessage(source, [{ text: "temporary", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");
  assert.equal(getWorkbenchTurnAdmission(client.getSnapshot().currentThread!.turns.at(-1)!), "providerPending");
  socket.fail(admissionRequest!.id, "admission failed");
  await assert.rejects(send, /admission failed/u);

  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), visibleBeforeSend.turns.map((turn) => turn.id));
  assert.deepEqual(client.getSnapshot().currentThread?.turnHistory.map((turn) => turn.turnId), visibleBeforeSend.turnHistory.map((turn) => turn.turnId));
  assert.equal(client.getSnapshot().currentThread?.turns.flatMap((turn) => turn.items).some((item) => getWorkbenchInputState(item)?.kind === "optimistic"), false);
}));

test("daemon-side steer admission moves the pending message without publishing browser lifecycle", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread("codex", "idle", "completed");
    client.selectThreadPayload(source);
    let admissionRequest: SocketRequest | null = null;
    FakeWebSocket.intercept = (_target, request) => {
      if (!isAdmissionRequest(request)) return false;
      admissionRequest = request;
      return true;
    };

    const send = client.sendThreadMessage(source, [{ text: "became a steer", text_elements: [], type: "text" }]);
    await waitForRequest(socket, "admission");
    socket.respond(admissionRequest!.id, { kind: "steered", turnId: "active-turn" });
    await send;

    const current = client.getSnapshot().currentThread!;
    assert.equal(current.turns.some((turn) => getWorkbenchTurnAdmission(turn) === "providerPending"), false);
    const activeTurn = current.turns.find((turn) => turn.id === "active-turn");
    assert.ok(activeTurn);
    assert.deepEqual(getWorkbenchInputState(activeTurn.items[0]!), {
      kind: "optimistic",
      placement: "steer",
      status: "pending",
    });
    assert.deepEqual(acceptedIntents, []);
  }, {
    publishAcceptedIntent: async (event) => { acceptedIntents.push(event); },
  });
});

test("SQLite transcript source lifecycle publishes through the thread client and becomes unavailable on disconnect", async () => {
  const publications: Array<{ status: string; threadId: string | null }> = [];
  await withClient(async (client, socket) => {
    client.selectThreadPayload(activeThread("codex", "thread", "completed"));
    const owner = client.getThreadController("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] });
    const stop = owner.subscribe(() => {
      const state = owner.getSnapshot().transcript;
      publications.push({ status: state.status, threadId: "threadId" in state ? state.threadId : null });
    });
    const release = owner.acquire("view");
    socket.notify(workbenchTranscriptNotifications.capabilities.method, { protocolVersion: 1 });
    await waitForRequest(socket, "workbench/transcript/subscribe");
    assert.deepEqual(publications.at(-1), { status: "loading", threadId: "thread" });

    socket.close();
    await waitForCondition(
      () => publications.at(-1)?.status === "unavailable",
      "expected SQLite transcript source to become unavailable after disconnect",
    );
    assert.deepEqual(publications.at(-1), { status: "unavailable", threadId: "thread" });
    stop();
    release();
  });
});

test("accepted thread titles update only the matching canonical source name", async () => withClient(async (client) => {
  const original = activeThread("codex", "original");
  const progressed = { ...original, preview: "newer preview", updatedAt: 2 };
  const selected = activeThread("opencode", "selected");
  client.selectThreadPayload(progressed);
  client.selectThreadPayload(selected);

  assert.equal(client.applyAcceptedThreadTitle(original.id, original.harness, "Renamed original"), true);

  const snapshot = client.getSnapshot();
  const originalKey = snapshot.threadDocuments.keysByThreadId[original.id];
  const renamedOriginal = originalKey ? snapshot.threadDocuments.documentsByKey[originalKey] : null;
  assert.equal(renamedOriginal?.name, "Renamed original");
  assert.equal(renamedOriginal?.preview, "newer preview");
  assert.equal(renamedOriginal?.updatedAt, 2);
  assert.equal(snapshot.currentThread?.id, selected.id);
  assert.equal(snapshot.currentThread?.name, selected.name);
  assert.equal(client.applyAcceptedThreadTitle(selected.id, "codex", "Wrong harness"), false);
  assert.equal(client.getSnapshot().currentThread?.name, selected.name);
}));

test("selected active Codex steers settle at admission and canonical notification owns placement", async () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  let socket!: FakeWebSocket;
  globalThis.window = {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
    }
  } as unknown as typeof WebSocket;
  const client = WorkbenchThreadClient();
  try {
    const source = activeThread();
    client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), root: "repo", rootPath: "C:/repo" });
    client.selectThreadPayload(source);
    const firstAdmission = client.sendThreadMessage(source, [{ text: "same", text_elements: [], type: "text" }]);
    const secondAdmission = client.sendThreadMessage(source, [{ text: "same", text_elements: [], type: "text" }]);
    const [first, second] = await Promise.all([firstAdmission, secondAdmission]);
    assert.equal(first, null);
    assert.equal(second, null);
    const methods = socket?.requests.map((request) => request.method) ?? [];
    assert.equal(socket.requests.filter(isSteerRequest).length, 2);
    assert.equal(methods.some((method) => method === "thread/metadata/read" || method === "thread/steers/read" || method === "thread/list"), false);
    assert.equal(client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 2);

    const steerRequests = socket?.requests.filter(isSteerRequest) ?? [];
    const firstHandle = steerRequests[0]?.params?.clientMessageId;
    assert.equal(typeof firstHandle, "string");
    socket?.notify("item/started", {
      item: { clientId: firstHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-first", type: "userMessage" },
      threadId: "thread",
      turnId: "turn",
    });
    const userItems = client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage") ?? [];
    assert.equal(userItems.length, 2);
    assert.equal(userItems[0]?.id, "canonical-first");
    assert.deepEqual(getWorkbenchInputState(userItems[1]!), { kind: "optimistic", placement: "steer", status: "pending" });

    socket?.notify("item/completed", {
      item: { clientId: firstHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-first", type: "userMessage" },
      threadId: "thread",
      turnId: "turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 2);
    assert.ok((socket?.requests ?? []).some((request) => request.method === "thread/steers/read"));

    const secondHandle = steerRequests[1]?.params?.clientMessageId;
    assert.equal(typeof secondHandle, "string");
    socket?.notify("item/started", {
      item: { clientId: secondHandle, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-second", type: "userMessage" },
      threadId: "thread",
      turnId: "turn-created-by-item",
    });
    const createdTurn = client.getSnapshot().currentThread?.turns.find((turn) => turn.id === "turn-created-by-item");
    assert.deepEqual(createdTurn?.items.map((item) => item.id), ["canonical-second"]);

    const background = { ...activeThread(), id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("background"), turns: [{ ...activeThread().turns[0]!, id: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("background-turn") }] };
    const backgroundResult = await client.sendThreadMessage(
      background,
      [{ text: "background steer", text_elements: [], type: "text" }],
      { selectThread: false },
    );
    assert.equal(backgroundResult?.id, "background");
    const backgroundRequests = socket?.requests.filter((request) => request.params?.threadId === "background") ?? [];
    const backgroundSteerIndex = backgroundRequests.findIndex(isSteerRequest);
    const backgroundPreparationIndex = backgroundRequests.findIndex((request) => request.method === "thread/metadata/read");
    assert.ok(backgroundSteerIndex >= 0);
    assert.ok(backgroundPreparationIndex === -1 || backgroundSteerIndex < backgroundPreparationIndex);
    assert.equal(backgroundRequests[backgroundSteerIndex]?.params?.expectedTurnId, "background-turn");
  } finally {
    client.dispose();
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
});

test("cumulative file-change patches dedupe repeated snapshots and yield to canonical lifecycle items", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread());

  const initialDiff = `@@ -0,0 +1,240 @@\n${Array.from({ length: 240 }, (_, index) => `+initial line ${index}`).join("\n")}`;
  const initialChange = { diff: initialDiff, kind: { type: "add" as const }, path: "src/first.ts" };
  socket.notify("item/fileChange/patchUpdated", {
    changes: [initialChange],
    itemId: "live-file-change",
    threadId: "thread",
    turnId: "turn",
  });

  const firstSnapshotItem = client.getSnapshot().currentThread?.turns[0]?.items.find((item) => item.id === "live-file-change");
  assert.equal(firstSnapshotItem?.type, "fileChange");
  assert.equal(firstSnapshotItem.changes[0]?.diff, initialDiff);

  const grownDiff = `${initialDiff}\n+later streamed line`;
  const grownChanges = [
    { ...initialChange, diff: grownDiff },
    { diff: "+second file", kind: { type: "add" as const }, path: "src/second.ts" },
  ];
  socket.notify("item/fileChange/patchUpdated", {
    changes: grownChanges,
    itemId: "live-file-change",
    threadId: "thread",
    turnId: "turn",
  });

  const grownSnapshotItem = client.getSnapshot().currentThread?.turns[0]?.items.find((item) => item.id === "live-file-change");
  assert.equal(grownSnapshotItem?.type, "fileChange");
  assert.equal(grownSnapshotItem.status, "inProgress");
  assert.equal(grownSnapshotItem.changes[0]?.diff, grownDiff);
  assert.equal(grownSnapshotItem.changes[1]?.path, "src/second.ts");

  let publishedSnapshots = 0;
  const unsubscribe = client.subscribe(() => {
    publishedSnapshots += 1;
  });
  socket.notify("item/fileChange/patchUpdated", {
    changes: grownChanges,
    itemId: "live-file-change",
    threadId: "thread",
    turnId: "turn",
  });
  unsubscribe();
  assert.equal(publishedSnapshots, 0);

  const canonicalChanges = [
    { ...initialChange, diff: `${grownDiff}\n+canonical line`, path: "C:/repo/src/first.ts" },
    { diff: "+second canonical file", kind: { type: "add" as const }, path: "C:/repo/src/second.ts" },
  ];
  socket.notify("item/started", {
    item: { changes: canonicalChanges, id: "live-file-change", status: "inProgress", type: "fileChange" },
    threadId: "thread",
    turnId: "turn",
  });
  const reconciledItems = client.getSnapshot().currentThread?.turns[0]?.items.filter((item) => item.id === "live-file-change");
  assert.equal(reconciledItems?.length, 1);
  assert.equal(reconciledItems?.[0]?.type, "fileChange");
  if (reconciledItems?.[0]?.type === "fileChange") {
    assert.deepEqual(reconciledItems[0].changes, canonicalChanges);
  }

  const completedChange = { ...canonicalChanges[0], diff: `${canonicalChanges[0].diff}\n+completed line` };
  socket.notify("item/completed", {
    item: { changes: [completedChange], id: "live-file-change", status: "completed", type: "fileChange" },
    threadId: "thread",
    turnId: "turn",
  });
  const completedItem = client.getSnapshot().currentThread?.turns[0]?.items.find((item) => item.id === "live-file-change");
  assert.equal(completedItem?.type, "fileChange");
  if (completedItem?.type === "fileChange") {
    assert.equal(completedItem.status, "completed");
    assert.equal(completedItem.changes[0]?.diff, completedChange.diff);
  }
}));

test("empty file-change starts preserve a provisional patch snapshot", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread());
  const provisionalChange = { diff: "+preview", kind: { type: "add" as const }, path: "src/preview.ts" };
  socket.notify("item/fileChange/patchUpdated", {
    changes: [provisionalChange],
    itemId: "live-file-change",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("item/started", {
    item: { changes: [], id: "live-file-change", status: "inProgress", type: "fileChange" },
    threadId: "thread",
    turnId: "turn",
  });

  const item = client.getSnapshot().currentThread?.turns[0]?.items.find((candidate) => candidate.id === "live-file-change");
  assert.equal(item?.type, "fileChange");
  if (item?.type === "fileChange") {
    assert.deepEqual(item.changes, [provisionalChange]);
  }
}));

test("a later lifecycle item discards an abandoned provisional file change", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread());
  socket.notify("item/fileChange/patchUpdated", {
    changes: [{ diff: "+never applied", kind: { type: "add" }, path: "src/abandoned.ts" }],
    itemId: "abandoned-file-change",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("item/started", {
    item: { content: [], id: "later-reasoning", summary: [], type: "reasoning" },
    threadId: "thread",
    turnId: "turn",
  });

  const items = client.getSnapshot().currentThread?.turns[0]?.items ?? [];
  assert.equal(items.some((item) => item.id === "abandoned-file-change"), false);
  assert.equal(items.some((item) => item.id === "later-reasoning"), true);
}));

test("differing acknowledgement runs the preserved tail once and tail failure stays admitted", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  FakeWebSocket.intercept = (target, request) => {
    if (isSteerRequest(request)) {
      queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: "different-turn" }));
      return true;
    }
    return false;
  };
  assert.equal((await client.sendThreadMessage(source, [{ text: "one", text_elements: [], type: "text" }]))?.id, "thread");
  assert.equal(socket.requests.filter(isSteerRequest).length, 1);
  assert.equal(socket.requests.filter((request) => request.method === "thread/metadata/read").length, 1);
  assert.equal(socket.requests.filter((request) => request.method === "thread/steers/read").length, 1);

  const second = activeThread("codex", "second");
  client.selectThreadPayload(second);
  FakeWebSocket.intercept = (target, request) => {
    if (isSteerRequest(request)) {
      queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: "different-second-turn" }));
      return true;
    }
    if (request.method === "thread/metadata/read") {
      queueMicrotask(() => target.fail(request.id, "reconciliation failed"));
      return true;
    }
    return false;
  };
  assert.equal(await client.sendThreadMessage(second, [{ text: "two", text_elements: [], type: "text" }]), null);
}));

test("Codex slash mentions travel outside plain user input on steer and start", async () => withClient(async (client, socket) => {
  const skillPath = "C:/skills/iterate/SKILL.md";
  const input = [{ text: "/iterate do the work", text_elements: [], type: "text" as const }];
  const active = activeThread();
  client.selectThreadPayload(active);

  assert.equal(await client.sendThreadMessage(active, input, {
    activatedSkillPaths: [skillPath],
  }), null);
  const steer = socket.requests.find(isSteerRequest);
  assert.deepEqual(steer?.params?.input, input);
  assert.deepEqual((steer?.params?.context as { activatedSkillPaths?: string[] })?.activatedSkillPaths, [skillPath]);
  assert.equal((steer?.params?.input as Array<{ type?: string }>).some((item) => item.type === "skill"), false);

  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  assert.equal(await client.sendThreadMessage(idle, input, {
    activatedSkillPaths: [skillPath],
  }), null);
  const admission = socket.requests.find((request) => (
    isAdmissionRequest(request) && request.params?.threadId === "idle"
  ));
  assert.deepEqual(admission?.params?.input, input);
  assert.deepEqual((admission?.params?.context as { activatedSkillPaths?: string[] })?.activatedSkillPaths, [skillPath]);
  assert.equal((admission?.params?.input as Array<{ type?: string }>).some((item) => item.type === "skill"), false);
}));

test("existing-thread sends preserve provider routes without publishing browser lifecycle", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  const result = await client.sendThreadMessage(idle, [{ text: "codex", text_elements: [], type: "text" }]);
  assert.equal(result, null);
  const admission = socket.requests.find((request) => isAdmissionRequest(request) && request.params?.threadId === "idle");
  assert.equal(typeof admission?.params?.clientMessageId, "string");
  assert.equal(admission?.params?.intent, "continue");
  assert.equal(socket.requests.filter((request) => isAdmissionRequest(request) && request.params?.threadId === "idle").length, 1);
  assert.equal(socket.requests.some((request) => request.method === "thread/resume"), false);
  assert.equal(socket.requests.some((request) => request.method === "turn/start" && request.params?.threadId === "idle"), false);
  assert.equal(socket.requests.some((request) => request.method === "thread/metadata/read" && request.params?.threadId === "idle"), false);
  assert.equal(socket.requests.some((request) => isSteerRequest(request) && request.params?.threadId === "idle"), false);
  assert.equal(socket.requests.some((request) => request.method === "workbench/thread-state/intent/accept"
    && (request.params?.identity as { threadId?: string } | undefined)?.threadId === "idle"), false);

  FakeWebSocket.intercept = null;

  for (const harness of ["copilot", "opencode", "future-provider"] as const) {
    const provider = activeThread(harness, `${harness}-thread`);
    client.selectThreadPayload(provider);
    const before = socket.requests.length;
    await assert.rejects(client.sendThreadMessage(provider, [{ text: harness, text_elements: [], type: "text" }]), /not installed/u);
    await assert.rejects(client.listModels(harness), /not installed/u);
    assert.deepEqual(socket.requests.slice(before).filter(request =>
      ["models/list", "thread/create", "thread/message/submit"].includes(request.method)
      && request.workbenchHarness === harness), []);
    assert.equal(client.getSnapshot().currentThread?.harness, harness);
  }
}));

test("bounded selected Codex captures one lifecycle resume intent and preserves loaded transcript state", async () => withClient(async (client, socket) => {
  const loadedItem: ThreadItem = {
    id: "loaded-item",
    memoryCitation: null,
    delivery: null,
    questions: null,
    phase: "commentary",
    text: "already loaded",
    type: "agentMessage",
  };
  const base = activeThread("codex", "idle", "completed");
  const idle: ThreadPayload = {
    ...base,
    nextPageCursor: "idle-turn",
    turnHistory: [{
      ...historyEntry("idle-turn", "loaded"),
      itemCount: 1,
      itemIds: [loadedItem.id],
    }],
    turns: [{ ...base.turns[0]!, items: [loadedItem] }],
  };
  client.selectThreadPayload(idle);

  assert.equal(await client.sendThreadMessage(idle, [{ text: "start", text_elements: [], type: "text" }]), null);
  const admission = socket.requests.find((request) => isAdmissionRequest(request) && request.params?.threadId === "idle");
  assert.equal(admission?.params?.intent, "continue");
  assert.equal(socket.requests.filter((request) => request.method === "turn/start" && request.params?.threadId === "idle").length, 0);
  assert.equal(socket.requests.some((request) => isSteerRequest(request) && request.params?.threadId === "idle"), false);
  const snapshot = client.getSnapshot().currentThread;
  assert.deepEqual(snapshot?.turns.find((turn) => turn.id === "idle-turn")?.items.map((item) => item.id), ["loaded-item"]);
  assert.equal(snapshot?.turns.find((turn) => turn.id === "idle-turn")?.itemsView, "full");
  assert.equal(snapshot?.turnHistory.find((turn) => turn.turnId === "idle-turn")?.itemCount, 1);
  assert.equal(snapshot?.nextPageCursor, "idle-turn");
}));

test("managed admission reports an unseen provider-active turn without a browser lifecycle fork", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  FakeWebSocket.intercept = (target, request) => {
    if (!isAdmissionRequest(request) || request.params?.threadId !== "idle") return false;
    queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: "provider-turn" }));
    return true;
  };

  assert.equal(await client.sendThreadMessage(idle, [{ text: "steer", text_elements: [], type: "text" }]), null);
  assert.equal(socket.requests.some(isSteerRequest), false);
  assert.equal(socket.requests.some((request) => request.method === "turn/start" && request.params?.threadId === "idle"), false);
}));

test("managed admission fails closed when provider-active state has no turn identity", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  FakeWebSocket.intercept = (target, request) => {
    if (!isAdmissionRequest(request) || request.params?.threadId !== "idle") return false;
    queueMicrotask(() => target.fail(request.id, "Active Codex thread idle has no current in-progress turn."));
    return true;
  };

  await assert.rejects(
    client.sendThreadMessage(idle, [{ text: "do not guess", text_elements: [], type: "text" }]),
    /no current in-progress turn/u,
  );
  assert.equal(socket.requests.some((request) => (
    request.params?.threadId === "idle"
    && (request.method === "turn/start" || isSteerRequest(request))
  )), false);
}));

test("detached new-turn admission rejects authoritative active lifecycle evidence", async () => withClient(async (client, socket) => {
  const detached = activeThread("codex", "detached", "interrupted");
  FakeWebSocket.intercept = (target, request) => {
    if (!isAdmissionRequest(request)) return false;
    queueMicrotask(() => target.fail(request.id, "The questionnaire response cannot start a new turn while the provider reports an active turn."));
    return true;
  };

  await assert.rejects(
    client.sendThreadMessage(
      detached,
      [{ text: "new turn only", text_elements: [], type: "text" }],
      { selectThread: false, startNewTurn: true },
    ),
    /provider reports an active turn/u,
  );
  const admission = socket.requests.find(isAdmissionRequest);
  assert.ok(admission);
  assert.equal(admission.params?.intent, "newTurn");
  assert.equal(socket.requests.some((request) => request.method === "turn/start"), false);
  assert.equal(socket.requests.some(isSteerRequest), false);
}));

test("detached new-turn admission fails closed when active lifecycle has no turn identity", async () => withClient(async (client, socket) => {
  const detached = activeThread("codex", "detached", "interrupted");
  FakeWebSocket.intercept = (target, request) => {
    if (!isAdmissionRequest(request)) return false;
    queueMicrotask(() => target.fail(request.id, "Active Codex thread detached has no current in-progress turn."));
    return true;
  };

  await assert.rejects(
    client.sendThreadMessage(
      detached,
      [{ text: "do not guess", text_elements: [], type: "text" }],
      { selectThread: false, startNewTurn: true },
    ),
    /no current in-progress turn/u,
  );
  assert.equal(socket.requests.some((request) => (
    request.method === "turn/start" || isSteerRequest(request)
  )), false);
}));

test("an accepted background child turn leaves lifecycle publication to the daemon", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "parent"));
  const child = activeThread("codex", "child", "completed");
  const result = await client.sendThreadMessage(
    child,
    [{ text: "continue", text_elements: [], type: "text" }],
    { selectThread: false },
  );
  assert.equal(result?.id, "child");
  const startIndex = socket.requests.findIndex((request) => isAdmissionRequest(request) && request.params?.threadId === "child");
  const acceptedIndex = socket.requests.findIndex((request) => request.method === "workbench/thread-state/intent/accept" && (request.params?.identity as { threadId?: string } | undefined)?.threadId === "child");
  assert.ok(startIndex >= 0);
  assert.equal(acceptedIndex, -1);
  const admission = socket.requests[startIndex]!;
  assert.equal(admission.params?.intent, "continue");
  assert.equal(admission.params?.threadId, "child");
}));

test("Copilot and OpenCode user notifications keep their provider-owned turn history path", async () => withClient(async (client, socket) => {
  for (const harness of ["copilot", "opencode"] as const) {
    const provider = activeThread(harness, `${harness}-notification`);
    client.selectThreadPayload(provider);
    socket.notify("item/started", {
      item: { clientId: null, content: [{ text: harness, text_elements: [], type: "text" }], id: `${harness}-item`, type: "userMessage" },
      threadId: provider.id,
      turnId: provider.turns[0]!.id,
    }, harness);
    const current = client.getSnapshot().currentThread;
    assert.equal(current?.turnHistory.length, 1);
    assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), [`${harness}-item`]);
  }
}));

test("project reset rejects stale reads while newer canonical notifications merge into valid reads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let deferred: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read") {
      deferred = request;
      return true;
    }
    return false;
  };
  const staleRead = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/page/read");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(deferred!.id, { browseResultEntries: [], nextCursor: null, questionnaireEntries: [], steerEntries: [], thread: wireThread("thread") });
  assert.equal(await staleRead, null);
  assert.equal(client.getSnapshot().currentThread, null);

  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), root: "repo", rootPath: "C:/repo" });
  client.selectThreadPayload(source);
  deferred = null;
  const racedRead = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/page/read", 1);
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "new", text_elements: [], type: "text" }], id: "new-item", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  socket.respond(deferred!.id, { browseResultEntries: [], nextCursor: null, questionnaireEntries: [], steerEntries: [], thread: wireThread("thread", "turn") });
  assert.ok(await racedRead);
  assert.deepEqual(client.getSnapshot().currentThread?.turns[0]?.items.map((item) => item.id), ["new-item"]);
}));

test("late latest pages cannot erase completed live items", async () => withClient(async (client, socket) => {
  const liveItem = {
    clientId: null,
    content: [{ text: "live", text_elements: [], type: "text" as const }],
    id: "live-item",
    type: "userMessage" as const,
  };
  const source = activeThread("codex", "thread", "completed");
  source.turns[0]!.items = [liveItem];
  client.selectThreadPayload(source);
  let pageRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method !== "thread/page/read") return false;
    pageRequest = request;
    return true;
  };

  const read = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/page/read");
  const stalePage = wireThread("thread", "turn", "completed");
  stalePage.turns[0]!.items = [{
    clientId: null,
    content: [{ text: "stored", text_elements: [], type: "text" }],
    id: "stored-item",
    type: "userMessage",
  }];
  socket.respond(pageRequest!.id, {
    browseResultEntries: [],
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: stalePage,
  });

  assert.deepEqual(
    (await read)?.turns[0]?.items.map((item) => item.id),
    ["stored-item", "live-item"],
  );
}));

test("refreshing the selected thread preserves pending steer ownership", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let steerRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (!isSteerRequest(request)) return false;
    steerRequest = request;
    return true;
  };

  const send = client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "steer");

  assert.equal((await client.refreshCurrentThread())?.id, "thread");
  socket.respond(steerRequest!.id, { kind: "steered", turnId: "different-turn" });
  assert.equal((await send)?.id, "thread");
}));

test("refreshing the selected thread surfaces read failures", async () => withClient(async (client) => {
  client.selectThreadPayload(activeThread());
  FakeWebSocket.intercept = (target, request) => {
    if (request.method !== "thread/page/read") return false;
    queueMicrotask(() => target.fail(request.id, "refresh failed"));
    return true;
  };

  await assert.rejects(client.refreshCurrentThread(), /refresh failed/u);
}));

test("foreign pinned thread context owns provider cwd, subagents, and late-read fencing without replacing the viewed project", async () => withClient(async (client, socket) => {
  const ownerProject = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    kind: "git" as const,
    lastCommitTimeMs: null,
    name: "owner",
    relativePath: "owner",
    rootPath: "C:/owner",
    roots: [{ id: "owner", isPrimary: true, name: "owner", relativePath: "owner", rootPath: "C:/owner" }],
  };
  const entries: WorkbenchThreadSidebarEntry[] = [{
    activityAt: 2,
    createdAt: 1,
    cwd: "C:/owner",
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["child"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    name: "Child",
    parentThreadId: fixtureIdentityValues.WorkbenchThreadId["root"],
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: fixtureIdentityValues.ProjectId["owner"],
    title: "Child",
    updatedAt: 2,
  }];
  let deferredRead: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "workbench/thread-state/observe") {
      queueMicrotask(() => target.respond(request.id, { observation: {
        ...request.params, error: null, freshness: "fresh", revision: 1, updateKind: "threadObservation",
        entries: [{
          activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: request.params?.target && (request.params.target as { threadId: string }).threadId },
          lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
          metadata: { archived: false, pinned: true, snoozed: false }, title: "Root",
        }, ...(request.params?.target && (request.params.target as { threadId: string }).threadId === "root" ? entries : [])],
      } }));
      return true;
    }
    if (request.method !== "thread/page/read") return false;
    if (request.params?.threadId === "late") {
      deferredRead = request;
      return true;
    }
    const thread = wireThread(String(request.params?.threadId ?? "root"));
    thread.cwd = "C:/owner";
    queueMicrotask(() => target.respond(request.id, {
      browseResultEntries: [],
      nextCursor: null,
      questionnaireEntries: [],
      steerEntries: [],
      thread,
    }));
    return true;
  };

  await client.openThread("root", { harness: "codex", project: ownerProject });
  const ownerRead = socket.requests.find((request) => request.method === "thread/page/read" && request.params?.threadId === "root");
  assert.equal(ownerRead?.params?.threadId, "root");
  assert.equal(client.getSnapshot().subagents[0]?.threadId, "child");
  await installObservedThreadState(client, {
    activeProjectSnapshot: {
      entries: [{
        activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["root"] },
        lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
        metadata: { archived: false, pinned: true, snoozed: false }, title: "Root",
      }, ...entries.map(entry => ({ ...entry, title: "Updated child" }))],
      projectId: fixtureIdentityValues.ProjectId["owner"], error: null, freshness: "fresh", revision: 2,
    },
    durableQuestionnaireEntries: [{
      activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["root"] },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: true, snoozed: false }, title: "Root",
    }, ...entries.map(entry => ({ ...entry, title: "Updated child" }))],
  });
  assert.equal(client.getSnapshot().subagents[0]?.title, "Updated child");

  const lateOpen = client.openThread("late", { harness: "codex", project: ownerProject });
  await waitForRequest(socket, "thread/page/read", 1);
  const replacement = client.createThread("codex", fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000090"));
  const lateThread = wireThread("late");
  lateThread.cwd = "C:/owner";
  socket.respond(deferredRead!.id, {
    browseResultEntries: [],
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: lateThread,
  });
  await lateOpen;
  assert.equal(client.getSnapshot().currentThread?.id, replacement.id);
  assert.equal(client.getSnapshot().subagents.length, 0);
}));

test("foreign pinned draft admission sends and publishes accepted intent through the owning project", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  await withClient(async (client, socket) => {
    const ownerProject = {
      id: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
      kind: "git" as const,
      lastCommitTimeMs: null,
      name: "owner",
      relativePath: "owner",
      rootPath: "C:/owner",
      roots: [{ id: "owner", isPrimary: true, name: "owner", relativePath: "owner", rootPath: "C:/owner" }],
    };
    const draft = client.createThread("codex", fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000091"), { project: ownerProject });
    FakeWebSocket.intercept = (target, request) => {
      if (request.method === "thread/create") {
        const thread = wireThread("foreign-materialized", "bootstrap", "completed");
        thread.cwd = "C:/owner";
        queueMicrotask(() => target.respond(request.id, { thread }));
        return true;
      }
      if (isAdmissionRequest(request)) {
        queueMicrotask(() => target.respond(request.id, { kind: "started", turn: wireThread("foreign-materialized", "started").turns[0] }));
        return true;
      }
      if (request.method === "thread/resume") {
        const thread = wireThread("foreign-materialized", "started");
        thread.cwd = "C:/owner";
        queueMicrotask(() => target.respond(request.id, { model: "model", reasoningEffort: null, serviceTier: null, thread }));
        return true;
      }
      return false;
    };

    await client.sendThreadMessage(draft, [{ text: "from owner", text_elements: [], type: "text" }]);
    const start = socket.requests.find((request) => request.method === "thread/create");
    assert.equal(start?.params?.projectId, "owner");
    assert.equal(acceptedIntents[0]?.projectId, "owner");
  }, {
    publishAcceptedIntent: async (event) => { acceptedIntents.push(event); },
  });
});

test("previous Codex pages preserve live state and merge only their scoped sidecars", async () => withClient(async (client, socket) => {
  const olderTimeline = [{ completedAt: 2, firstSeenAt: 1, itemId: "older-item", lastSeenAt: 2, startedAt: 1 }];
  const currentTimeline = [{ completedAt: 4, firstSeenAt: 2, itemId: "current-item", lastSeenAt: 4, startedAt: 2 }];
  const replacementOlderTimeline = [{ completedAt: 3, firstSeenAt: 1, itemId: "older-item", lastSeenAt: 3, startedAt: 1 }];
  const history = [
    { ...historyEntry("older", "unloaded"), itemTimeline: olderTimeline },
    { ...historyEntry("turn", "loaded"), itemTimeline: currentTimeline },
  ];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  const deferredPageReads: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read") {
      deferredPageReads.push(request);
      return true;
    }
    return false;
  };

  const latestRead = client.readThread("thread", "codex", { cursor: null });
  const latestRequest = await waitForRequest(socket, "thread/page/read");
  assert.equal(latestRequest.params?.cursor, null);
  socket.respond(latestRequest.id, {
    browseResultEntries: [browseEntry("browse:turn", "turn")],
    nextCursor: "turn",
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["turn"], history),
  });
  assert.ok(await latestRead);

  const previousRead = client.readThread("thread", "codex", {
    cursor: "turn",
  });
  const previousRequest = await waitForRequest(socket, "thread/page/read", 1);
  assert.equal(previousRequest.params?.cursor, "turn");
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "live", text_elements: [], type: "text" }], id: "live-item", type: "userMessage" },
    threadId: "thread",
    turnId: "turn",
  });
  socket.respond(previousRequest.id, {
    browseResultEntries: [browseEntry("browse:older", "older")],
    entryScope: { mode: "turns", turnIds: ["older"] },
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["older"], [
      { ...historyEntry("older", "loaded"), itemTimeline: replacementOlderTimeline },
      historyEntry("turn", "unloaded"),
    ]),
  });

  const result = await previousRead;
  assert.ok(result);
  assert.deepEqual(result.turns.map((turn) => turn.id), ["older", "turn"]);
  assert.deepEqual(result.turns.find((turn) => turn.id === "turn")?.items.map((item) => item.id), ["live-item"]);
  assert.deepEqual(result.turnHistory.find((entry) => entry.turnId === "turn")?.itemTimeline, currentTimeline);
  assert.deepEqual(result.turnHistory.find((entry) => entry.turnId === "older")?.itemTimeline, replacementOlderTimeline);
  assert.deepEqual(result.browseResultEntries?.map((entry) => entry.entryKey), ["browse:older", "browse:turn"]);
  assert.equal(result.status, "active");
  assert.equal(socket.requests.filter((request) => request.method === "thread/resume").length, 0);
  assert.equal(deferredPageReads.length, 2);
}));

test("mounted and inactive retention unload old Codex bodies without making the warm page stale", async () => withClient(async (client, socket) => {
  const base = activeThread("codex", "thread", "completed");
  const turns = ["oldest", "older", "previous", "current"].map((id, index) => ({
    ...base.turns[0]!,
    completedAt: index + 1,
    id,
    startedAt: index,
  }));
  const history = turns.map((turn) => ({
    ...historyEntry(turn.id, "loaded"),
    completedAt: turn.completedAt,
    itemIds: [`item:${turn.id}`],
    itemTimeline: [{
      completedAt: turn.completedAt! * 1_000,
      firstSeenAt: turn.startedAt! * 1_000,
      itemId: `item:${turn.id}`,
      lastSeenAt: turn.completedAt! * 1_000,
      startedAt: turn.startedAt! * 1_000,
    }],
    startedAt: turn.startedAt,
  }));
  client.selectThreadPayload({
    ...base,
    browseResultEntries: [],
    nextPageCursor: null,
    turnHistory: history,
    turns,
  });
  const pageRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read" && request.params?.threadId === "thread") {
      pageRequests.push(request);
      return true;
    }
    return false;
  };
  for (const [cursor, turnId, nextCursor] of [
    [null, "current", "current"],
    ["current", "previous", "previous"],
    ["previous", "older", "older"],
  ] as const) {
    const requestIndex = pageRequests.length;
    const read = client.readThread("thread", "codex", { cursor });
    const request = await waitForRequest(socket, "thread/page/read", requestIndex);
    socket.respond(request.id, {
      browseResultEntries: [browseEntry(`browse:${turnId}`, turnId)],
      ...(cursor === null ? {} : { entryScope: { mode: "turns", turnIds: [turnId] } }),
      nextCursor,
      questionnaireEntries: [],
      steerEntries: [],
      thread: wireThreadWithHistory([turnId], history),
    });
    assert.ok(await read);
  }
  const owner = client.getThreadController("project", {
    kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
  });
  const releaseView = owner.acquire("view");
  const surface = owner.acquireHistorySurface();
  surface.setAtEnd(true);

  let retained = client.getSnapshot().currentThread!;
  assert.deepEqual(retained.turns.map(({ id }) => id), ["previous", "current"]);
  assert.equal(retained.nextPageCursor, "previous");
  assert.deepEqual(retained.browseResultEntries?.map(({ turnId }) => turnId), ["previous", "current"]);
  assert.deepEqual(retained.turnHistory.slice(0, 2).map((entry) => ({
    itemIds: entry.itemIds, itemTimeline: entry.itemTimeline, loadState: entry.loadState,
  })), [
    { itemIds: undefined, itemTimeline: undefined, loadState: "unloaded" },
    { itemIds: undefined, itemTimeline: undefined, loadState: "unloaded" },
  ]);

  client.selectThreadPayload(activeThread("codex", "other", "completed"));
  releaseView();
  surface.release();
  const retainedKey = client.getSnapshot().threadDocuments.keysByThreadId.thread!;
  retained = client.getSnapshot().threadDocuments.documentsByKey[retainedKey]!;
  assert.deepEqual(retained.turns.map(({ id }) => id), ["current"]);
  assert.equal(retained.nextPageCursor, "current");

  let pageRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read" && request.params?.threadId === "thread") {
      pageRequest = request;
      return true;
    }
    return false;
  };
  const freshnessRead = client.readThread("thread", "codex", { cursor: null });
  await waitForRequest(socket, "thread/page/read");
  socket.respond(pageRequest!.id, {
    browseResultEntries: [browseEntry("browse:current", "current")],
    nextCursor: "current",
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["current"], history.map((entry) => (
      entry.turnId === "current" ? entry : { ...entry, itemIds: undefined, itemTimeline: undefined, loadState: "unloaded" as const }
    ))),
  });
  assert.ok(await freshnessRead);
  const refreshedKey = client.getSnapshot().threadDocuments.keysByThreadId.thread!;
  assert.deepEqual(
    client.getSnapshot().threadDocuments.documentsByKey[refreshedKey]?.turns.map(({ id }) => id),
    ["current"],
  );
}));

test("thread reads always use the harness-neutral page contract without capability negotiation", async () => withClient(async (client, socket) => {
  assert.ok(await client.readThread("thread", "codex"));
  const page = socket.requests.find((request) => (
    request.method === "thread/page/read" && request.params?.threadId === "thread"
  ));
  assert.equal(page?.params?.cursor, null);
  assert.equal(page?.params?.threadId, "thread");
  assert.equal(socket.requests.some((request) => request.method === "thread/resume"), false);
  assert.equal(socket.requests.some((request) => request.method === "thread/context/read"), false);
}));

test("live Codex notifications remain the selected transcript owner without page rereads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const pageReadCount = () => socket.requests.filter((request) => (
    request.method === "thread/page/read" && request.params?.threadId === source.id
  )).length;

  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "live", text_elements: [], type: "text" }], id: "live-item", type: "userMessage" },
    threadId: source.id,
    turnId: source.turns[0]!.id,
  });
  socket.notify("turn/completed", {
    threadId: source.id,
    turn: { ...source.turns[0]!, completedAt: 2, status: "completed" },
  });
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(pageReadCount(), 0);
  assert.deepEqual(client.getSnapshot().currentThread?.turns[0]?.items.map((item) => item.id), ["live-item"]);
  assert.equal(client.getSnapshot().currentThread?.turns[0]?.status, "completed");
}));

test("previous Codex pages reject a body that is not the exact predecessor", async () => withClient(async (client, socket) => {
  const history = [historyEntry("older", "unloaded"), historyEntry("turn", "loaded")];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  let contextRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read") {
      contextRequest = request;
      return true;
    }
    return false;
  };

  const previousRead = client.readThread("thread", "codex", {
    cursor: "turn",
  });
  await waitForRequest(socket, "thread/page/read");
  socket.respond(contextRequest!.id, {
    browseResultEntries: [],
    entryScope: { mode: "turns", turnIds: ["wrong"] },
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory(["wrong"], history),
  });

  assert.equal(await previousRead, null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["turn"]);
}));

test("previous Codex pages reject an empty body when history names a predecessor", async () => withClient(async (client, socket) => {
  const history = [historyEntry("older", "unloaded"), historyEntry("turn", "loaded")];
  client.selectThreadPayload({ ...activeThread(), turnHistory: history });
  let contextRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read") {
      contextRequest = request;
      return true;
    }
    return false;
  };

  const previousRead = client.readThread("thread", "codex", {
    cursor: "turn",
  });
  await waitForRequest(socket, "thread/page/read");
  socket.respond(contextRequest!.id, {
    browseResultEntries: [],
    entryScope: { mode: "turns", turnIds: [] },
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThreadWithHistory([], history),
  });

  assert.equal(await previousRead, null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["turn"]);
}));

test("newest pages commit complete history while live transcript owners advance", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let pageRequest: SocketRequest | null = null;
  let questionnaireRequest: SocketRequest | null = null;
  let browseRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read") {
      pageRequest = request;
      return true;
    }
    if (request.method === "thread/questionnaires/read") {
      questionnaireRequest = request;
      return true;
    }
    if (request.method === "thread/browse/read") {
      browseRequest = request;
      return true;
    }
    return false;
  };

  const read = client.readThread("thread", "codex");
  await waitForRequest(socket, "thread/page/read");
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "live", text_elements: [], type: "text" }], id: "live-item", type: "userMessage" },
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("thread/status/changed", { status: { type: "idle" }, threadId: "thread" });
  client.setCurrentThreadAgent("thread", "library:agents/live.md");
  client.setCurrentThreadModel("thread", "live-model");

  socket.notify("questionnaire/resolved", { requestKey: "live", threadId: "thread", turnId: "turn" });
  await waitForRequest(socket, "thread/questionnaires/read");
  socket.respond(questionnaireRequest!.id, { data: [questionnaireEntry("turn", "live-questionnaire")] });
  socket.notify("browse/result/recorded", { threadId: "thread" });
  await waitForRequest(socket, "thread/browse/read");
  socket.respond(browseRequest!.id, { data: [browseEntry("live-browse", "turn")] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completeThread = wireThread("thread");
  completeThread.turns[0]!.items = [{
    id: "complete-plan",
    memoryCitation: null,
    delivery: null,
    questions: null,
    phase: "commentary",
    text: "complete plan",
    type: "agentMessage",
  }];
  socket.respond(pageRequest!.id, {
    browseResultEntries: [browseEntry("stored-browse", "turn")],
    nextCursor: null,
    questionnaireEntries: [questionnaireEntry("turn", "stored-questionnaire")],
    steerEntries: [],
    thread: completeThread,
  });

  const result = await read;
  assert.ok(result);
  const itemIds = result.turns.flatMap((turn) => turn.items.map((item) => item.id));
  assert.equal(itemIds.includes("complete-plan"), true);
  assert.equal(itemIds.includes("live-item"), true);
  assert.equal(itemIds.some((itemId) => itemId.includes("stored-questionnaire")), true);
  assert.equal(itemIds.some((itemId) => itemId.includes("live-questionnaire")), true);
  assert.deepEqual(result.browseResultEntries?.map((entry) => entry.entryKey), ["stored-browse", "live-browse"]);
  assert.equal(result.status, "idle");
  assert.equal(result.agentPath, "library:agents/live.md");
  assert.equal(result.model, "live-model");
}));

test("candidate reads still surface genuine provider failures", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client) => {
    FakeWebSocket.intercept = (socket, request) => {
      if (request.method !== "thread/page/read") {
        return false;
      }

      queueMicrotask(() => socket.fail(request.id, `${request.workbenchHarness ?? "codex"} missing`));
      return true;
    };

    assert.equal(await client.readThread("missing"), null);
    const expectedMessage = "Unable to open codex thread missing: codex missing";
    assert.equal(client.getSnapshot().threadsError, expectedMessage);
    assert.deepEqual(statusMessages, [expectedMessage]);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("failed opens return their exact failure without relabelling the current selection", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client) => {
    client.selectThreadPayload(activeThread("codex", "selected"));
    FakeWebSocket.intercept = (socket, request) => {
      if (request.method !== "thread/page/read" || request.params?.threadId !== "missing") {
        return false;
      }

      queueMicrotask(() => socket.fail(request.id, "transcript ownership conflict"));
      return true;
    };

    assert.deepEqual(
      await client.openThread("missing", { harness: "codex" }),
      {
        failure: {
          harness: "codex",
          message: "transcript ownership conflict",
          transientRollout: false,
        },
        kind: "failure",
      },
    );
    assert.equal(client.getSnapshot().currentThread?.id, "selected");
    assert.deepEqual(statusMessages, ["transcript ownership conflict"]);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("open-thread selection binding prevents a late open from replacing newer selection", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "b"));
  let openRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/page/read" && request.params?.threadId === "a") {
      openRequest = request;
      return true;
    }
    return false;
  };
  const opening = client.openThread("a", { harness: "codex", source: "open" });
  await waitForRequest(socket, "thread/page/read");
  client.selectThreadPayload(activeThread("codex", "c"));
  socket.respond(openRequest!.id, { browseResultEntries: [], nextCursor: null, questionnaireEntries: [], steerEntries: [], thread: wireThread("a") });
  assert.deepEqual(await opening, { kind: "superseded" });
  assert.equal(client.getSnapshot().currentThread?.id, "c");
}));

test("same-key, A-B-A, and clear-reselect commands invalidate fast preparation while profile changes do not", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const sameKey = client.sendThreadMessage(source, [{ text: "same-key", text_elements: [], type: "text" }]);
  client.selectThreadPayload({ ...source, updatedAt: 2 });
  await assert.rejects(sameKey, ThreadMessageNotSentError);

  const aba = client.sendThreadMessage(source, [{ text: "aba", text_elements: [], type: "text" }]);
  client.selectThreadPayload(activeThread("codex", "b"));
  client.selectThreadPayload(source);
  await assert.rejects(aba, ThreadMessageNotSentError);

  const clear = client.sendThreadMessage(source, [{ text: "clear", text_elements: [], type: "text" }]);
  client.clearThreadSelection();
  client.selectThreadPayload(source);
  await assert.rejects(clear, ThreadMessageNotSentError);

  const profile = client.sendThreadMessage(source, [{ text: "profile", text_elements: [], type: "text" }]);
  client.setCurrentThreadComposerSettings("thread", {
    agentPath: "agent://changed", agentSource: null, harness: "codex", model: "changed-model", reasoningEffort: null, serviceTier: "fast",
  });
  assert.equal(await profile, null);
  assert.equal(socket.requests.filter(isSteerRequest).length, 1);
  assert.equal(socket.requests.some((request) => request.method === "thread/resume"), false);
}));

test("visible questionnaire keeps back-to-back selected steers admissible", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const pending = {
    harness: "codex",
    hidden: false,
    itemId: "question",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
    requestKey: "question-key",
    threadId: "thread",
    turnId: "turn",
  };
  socket.notify("questionnaire/requested", pending);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method !== "questionnaires/pending/read") return false;
    queueMicrotask(() => target.respond(request.id, { data: [pending] }));
    return true;
  };

  const results = await Promise.all(["one", "two", "three"].map((text) => (
    client.sendThreadMessage(source, [{ text, text_elements: [], type: "text" }])
  )));

  assert.deepEqual(results, [null, null, null]);
  const steerRequests = socket.requests.filter(isSteerRequest);
  assert.equal(steerRequests.length, 3);
  assert.deepEqual(steerRequests.map((request) => request.params?.expectedTurnId), ["turn", "turn", "turn"]);
  const handles = steerRequests.map((request) => String(request.params?.clientMessageId ?? ""));
  assert.equal(handles.every(Boolean), true);
  assert.equal(new Set(handles).size, 3);
  assert.equal(socket.requests.some((request) => request.method === "thread/metadata/read"), false);

  const snapshot = client.getSnapshot();
  assert.equal(snapshot.pendingUserInputRequestsByThreadId["thread"]?.requestKey, "question-key");
  assert.match(snapshot.currentThread?.status ?? "", /waitingOnUserInput/u);
  assert.equal(snapshot.currentThread?.turns[0]?.items.filter((item) => item.type === "userMessage").length, 3);
}));

test("selection drift after managed admission keeps the newly selected thread", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isAdmissionRequest(request) && request.params?.threadId === "idle") {
      admissionRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(idle, [{ text: "stale", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");
  client.selectThreadPayload(activeThread("codex", "other"));
  socket.respond(admissionRequest!.id, { kind: "started", turn: wireThread("idle", "idle-started").turns[0] });
  assert.equal(await send, null);
  assert.equal(socket.requests.some((request) => (isSteerRequest(request) || request.method === "turn/start") && request.params?.threadId === "idle"), false);
  assert.equal(client.getSnapshot().currentThread?.id, "other");
}));

test("same-selection completion drift during managed admission projects the started turn once", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isAdmissionRequest(request) && request.params?.threadId === "idle") {
      admissionRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "keep me", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");
  socket.notify("thread/status/changed", {
    status: { type: "idle" },
    threadId: "idle",
  });
  socket.respond(admissionRequest!.id, { kind: "started", turn: wireThread("idle", "idle-started").turns[0] });

  assert.equal(await send, null);
  assert.equal(socket.requests.filter(isAdmissionRequest).length, 1);
  assert.equal(client.getSnapshot().currentThread?.turns.filter((turn) => turn.id === "idle-started").length, 1);
  assert.equal(client.getSnapshot().currentThread?.id, "idle");
}));

test("idle status with a stale in-progress turn delegates authoritative admission to the bridge", async () => withClient(async (client, socket) => {
  const stale = { ...activeThread(), status: "idle" };
  client.selectThreadPayload(stale);
  FakeWebSocket.intercept = (target, request) => {
    if (isAdmissionRequest(request)) {
      queueMicrotask(() => target.respond(request.id, { kind: "started", turn: wireThread("thread", "new-turn").turns[0] }));
      return true;
    }
    return false;
  };

  const result = await client.sendThreadMessage(stale, [{ text: "new turn", text_elements: [], type: "text" }]);
  assert.equal(socket.requests.filter(isSteerRequest).length, 0);
  assert.equal(socket.requests.filter((request) => request.method === "turn/start").length, 0);
  assert.equal(socket.requests.filter(isAdmissionRequest).length, 1);
  assert.equal(result, null);
  assert.equal(client.getSnapshot().currentThread?.turns.at(-1)?.id, "new-turn");
  assert.equal(socket.requests.some((request) => request.method === "thread/metadata/read"), false);
}));

test("managed admission preserves already-loaded earlier turns when projecting the start", async () => withClient(async (client, socket) => {
  const base = activeThread("codex", "thread", "completed");
  const olderTurn = { ...base.turns[0]!, completedAt: 2, durationMs: 1, id: "older", startedAt: 1, status: "completed" as const };
  const currentTurn = { ...base.turns[0]!, id: "current" };
  const source = {
    ...base,
    status: "idle",
    turnHistory: [historyEntry("older", "loaded"), { ...historyEntry("older", "loaded"), turnId: "current" }],
    turns: [olderTurn, currentTurn],
  };
  client.selectThreadPayload(source);
  FakeWebSocket.intercept = (target, request) => {
    if (isAdmissionRequest(request)) {
      queueMicrotask(() => target.respond(request.id, {
        kind: "started",
        turn: wireThread("thread", "thread-started").turns[0],
      }));
      return true;
    }
    return false;
  };

  assert.equal(await client.sendThreadMessage(source, [{ text: "next", text_elements: [], type: "text" }]), null);
  assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["older", "current", "thread-started"]);
}));

test("daemon-side active-turn admission settles without a second browser steer", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isAdmissionRequest(request) && !admissionRequest) {
      admissionRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "join active", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");
  socket.notify("turn/started", {
    threadId: "idle",
    turn: wireThread("idle", "notification-turn").turns[0],
  });
  socket.respond(admissionRequest!.id, { kind: "steered", turnId: "notification-turn" });

  assert.equal(await send, null);
  assert.equal(socket.requests.filter(isSteerRequest).length, 0);
  assert.equal(socket.requests.some((request) => request.method === "turn/start" && request.params?.threadId === "idle"), false);
}));

test("canonical initial notification before managed admission acknowledgement is preserved once", async () => withClient(async (client, socket) => {
  const idle = activeThread("codex", "idle", "completed");
  client.selectThreadPayload(idle);
  let admissionRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isAdmissionRequest(request)) {
      admissionRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(idle, [{ text: "initial", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "admission");
  const clientId = String(admissionRequest!.params?.clientMessageId ?? "");
  const startedTurn = wireThread("idle", "new-turn").turns[0]!;
  socket.notify("turn/started", { threadId: "idle", turn: startedTurn });
  socket.notify("item/started", {
    item: { clientId, content: [{ text: "initial", text_elements: [], type: "text" }], id: "canonical-initial", type: "userMessage" },
    threadId: "idle",
    turnId: "new-turn",
  });
  socket.respond(admissionRequest!.id, { kind: "started", turn: startedTurn });

  assert.equal(await send, null);
  const initialItems = client.getSnapshot().currentThread?.turns.find((turn) => turn.id === "new-turn")?.items.filter((item) => item.type === "userMessage") ?? [];
  assert.deepEqual(initialItems.map((item) => item.id), ["canonical-initial"]);
}));

test("preserved general active steer rejects interruption before acknowledgement", async () => withClient(async (client, socket) => {
  const baseSource = activeThread();
  const source = {
    ...baseSource,
    turns: [{ ...baseSource.turns[0]!, id: "thread-turn" }],
  };
  client.selectThreadPayload(source);
  let pendingSteer: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isSteerRequest(request)) {
      pendingSteer = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(
    source,
    [{ text: "interrupted", text_elements: [], type: "text" }],
    { selectThread: false },
  );
  await waitForRequest(socket, "steer");
  socket.notify("turn/completed", {
    threadId: "thread",
    turn: {
      ...wireThread("thread", "thread-turn").turns[0]!,
      completedAt: 2,
      durationMs: 1,
      status: "interrupted",
    },
  });
  socket.respond(pendingSteer!.id, { kind: "steered", turnId: "thread-turn" });
  await assert.rejects(send, /turn stopped before this steer was delivered/u);
  assert.equal(getWorkbenchInputState(client.getSnapshot().currentThread!.turns[0]!.items.at(-1)!)?.status, "interrupted");
}));

test("malformed general acknowledgements render exact failed evidence before rejection", async () => withClient(async (client, socket) => {
  FakeWebSocket.intercept = (target, request) => {
    if (!isSteerRequest(request)) {
      return false;
    }
    queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: " " }));
    return true;
  };

  const codex = { ...activeThread("codex", "codex-failure"), status: "active:waitingOnUserInput" };
  client.selectThreadPayload(codex);
  await assert.rejects(
    client.sendThreadMessage(codex, [{ text: "codex", text_elements: [], type: "text" }], { selectThread: false }),
    /empty turn id/u,
  );
  client.selectThreadPayload(codex);
  assert.equal(getWorkbenchInputState(client.getSnapshot().currentThread!.turns.at(-1)!.items.at(-1)!)?.status, "failed");
}));

test("raw canonical notifications preserve waiting status and stable preferences", async () => withClient(async (client, socket) => {
  const source = { ...activeThread(), agentPath: "agent://selected", model: "selected-model", serviceTier: "fast" };
  client.selectThreadPayload(source);
  socket.notify("questionnaire/requested", {
    hidden: false, itemId: "question", requestKey: "question", threadId: "thread", turnId: "turn",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "new", text_elements: [], type: "text" }], id: "canonical", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  const current = client.getSnapshot().currentThread;
  assert.equal(current?.model, "selected-model");
  assert.equal(current?.serviceTier, "fast");
  assert.equal(current?.agentPath, "agent://selected");
  assert.ok(current?.status.includes("waitingOnUserInput"));
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["canonical"]);
}));

test("live compaction notifications preserve distinct markers and complete one owned timeline entry", async () => withClient(async (client, socket) => {
  const source = activeThread();
  source.turns[0] = {
    ...source.turns[0]!,
    items: [
      { id: "compaction-one", type: "contextCompaction" },
      { id: "between", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "between", type: "agentMessage" },
    ],
  };
  client.selectThreadPayload(source);

  socket.notify("item/started", {
    item: { id: "compaction-two", type: "contextCompaction" },
    startedAtMs: 100,
    threadId: "thread",
    turnId: "turn",
  });
  let current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    completedAt: null,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 100,
    startedAt: 100,
  }]);

  socket.notify("item/completed", {
    completedAtMs: 200,
    item: { id: "compaction-two", type: "contextCompaction" },
    threadId: "thread",
    turnId: "turn",
  });
  current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    completedAt: 200,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 200,
    startedAt: 100,
  }]);

  socket.notify("item/completed", {
    completedAtMs: 250,
    item: withWorkbenchThreadItemIdentity({ id: "item-99", type: "contextCompaction" }, "provisional"),
    threadId: "thread",
    turnId: "turn",
  });
  current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline, [{
    aliases: ["item-99"],
    completedAt: 250,
    firstSeenAt: 100,
    itemId: "compaction-two",
    lastSeenAt: 250,
    startedAt: 100,
  }]);
  const opaqueSnapshotId = "5ce58db5-d6fc-48ba-aa84-336ce4bd3580";
  socket.notify("item/completed", {
    completedAtMs: 300,
    item: withWorkbenchThreadItemIdentity({ id: opaqueSnapshotId, type: "contextCompaction" }, "provisional"),
    threadId: "thread",
    turnId: "turn",
  });
  current = client.getSnapshot().currentThread;
  assert.deepEqual(current?.turns[0]?.items.map((item) => item.id), ["compaction-one", "between", "compaction-two"]);
  assert.deepEqual(current?.turnHistory[0]?.itemTimeline?.[0]?.aliases, ["item-99", opaqueSnapshotId]);
  assert.equal(current?.turnHistory[0]?.itemTimeline?.[0]?.completedAt, 300);
}));

test("status and token owners survive canonical updates, authoritative nulls, and compact acknowledgement", async () => withClient(async (client, socket) => {
  const usage = (totalTokens: number) => ({
    last: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
    modelContextWindow: 100,
    total: { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens },
  });
  const selected = {
    ...activeThread(),
    agentPath: "agent://selected",
    model: "selected-model",
    reasoningEffort: "high",
    serviceTier: "fast",
    tokenUsage: usage(10),
  };
  client.selectThreadPayload(selected);
  client.selectThreadPayload({
    ...selected,
    agentPath: null,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    tokenUsage: null,
  });
  assert.equal(client.getSnapshot().currentThread?.agentPath, "agent://selected");
  assert.equal(client.getSnapshot().currentThread?.model, "selected-model");
  assert.equal(client.getSnapshot().currentThread?.reasoningEffort, "high");
  assert.equal(client.getSnapshot().currentThread?.serviceTier, "fast");
  assert.equal(client.getSnapshot().currentThread?.tokenUsage?.total.totalTokens, 10);

  socket.notify("thread/status/changed", { status: { type: "idle" }, threadId: "thread" });
  assert.equal(client.getSnapshot().currentThread?.status, "idle");

  socket.notify("thread/tokenUsage/updated", { threadId: "thread", tokenUsage: usage(20), turnId: "turn" });
  assert.equal(client.getSnapshot().currentThread?.tokenUsage?.total.totalTokens, 20);

  await client.compactThread(client.getSnapshot().currentThread!);
  assert.equal(client.getSnapshot().currentThread?.tokenUsage?.total.totalTokens, 20);
}));

test("a thread controller changes its own preferences without changing the selected thread", async () => withClient(async client => {
  client.selectThreadPayload(activeThread("codex", "background"));
  client.selectThreadPayload(activeThread("codex", "selected"));
  const owner = client.getThreadController("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["background"] });
  owner.actions.changeSettings({
    harness: "codex", model: "background-model", reasoningEffort: "high", serviceTier: "fast", agentPath: null, agentSource: null,
  });
  const snapshot = client.getSnapshot();
  const key = snapshot.threadDocuments.keysByThreadId.background!;
  assert.equal(snapshot.threadDocuments.documentsByKey[key]?.model, "background-model");
  assert.equal(snapshot.threadDocuments.documentsByKey[key]?.reasoningEffort, "high");
  assert.equal(snapshot.threadDocuments.documentsByKey[key]?.serviceTier, "fast");
  assert.equal(snapshot.currentThread?.model, "model");
  assert.equal(snapshot.currentThreadId, "selected");
}));

test("changing shell projects preserves a mounted thread's canonical document", async () => withClient(async client => {
  client.selectThreadPayload(activeThread("codex", "pinned"));
  const owner = client.getThreadController("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["pinned"] });
  const release = owner.acquire("view");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  const snapshot = client.getSnapshot();
  const key = snapshot.threadDocuments.keysByThreadId.pinned!;
  assert.equal(snapshot.threadDocuments.documentsByKey[key]?.id, "pinned");
  assert.equal(snapshot.currentThread, null);
  release();
}));

test("a mounted thread read survives unrelated shell project selection", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "pinned"));
  const owner = client.getThreadController("project", { kind: "provider", harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["pinned"] });
  const release = owner.acquire("view");
  FakeWebSocket.intercept = (_socket, request) => request.method === "thread/page/read";
  const pending = owner.read();
  const request = await waitForRequest(socket, "thread/page/read");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(request.id, {
    thread: wireThread("pinned"), browseResultEntries: [], questionnaireEntries: [], steerEntries: [], nextCursor: null,
  });
  assert.equal((await pending)?.id, "pinned");
  assert.equal(client.getSnapshot().currentThread, null);
  release();
}));

for (const selection of ["create", "payload"] as const) {
  test(`${selection} selects an uncached draft without provider admission`, async () => withClient(async (client, socket) => {
    await client.openThread("thread", { harness: "codex" });
    const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("aca7aafb-a768-4ab9-aab5-b885a84c650e");
    const draft: ThreadPayload<typeof draftId> = { ...activeThread(), id: draftId, isDraft: true, turns: [], turnHistory: [] };
    if (selection === "create") client.createThread("codex", draftId);
    else client.selectThreadPayload(draft);
    const owner = client.getThreadController("project", { kind: "draft", draftId });
    const release = owner.acquire("view");
    try {
      await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "unused" });
      assert.equal(socket.requests.some(request => (
        request.method === "workbench/thread-state/observe"
        && (request.params?.target as { threadId?: string } | undefined)?.threadId === draftId
      )), false);
      assert.equal(socket.requests.some(request => (
        (request.method === "thread/page/read" || request.method === "thread/metadata/read")
        && request.params?.threadId === draftId
      )), false);
      assert.equal(client.threadObservations.getObservations().length, 0);
      assert.equal(owner.getSnapshot().status, "ready");
      assert.equal(owner.getSnapshot().document?.id, draftId);
      assert.equal(owner.getSnapshot().document?.isDraft, true);
    } finally {
      release();
    }
  }));
}

test("an unselected draft remains owned and changes provider without moving selection", async () => withClient(async client => {
  client.selectThreadPayload(activeThread("codex", "selected"));
  const draft = client.createThread("codex", fixtureIdentitySchemas.DraftIdSchema.parse("draft"), { select: false });
  const owner = client.getThreadController("project", { kind: "draft", draftId: draft.id });
  const release = owner.acquire("view");
  assert.equal(owner.getSnapshot().document?.id, draft.id);
  owner.actions.changeSettings({
    agentPath: null, agentSource: null, harness: "opencode", model: "draft-model", reasoningEffort: null, serviceTier: null,
  });
  assert.equal(owner.getSnapshot().document?.harness, "opencode");
  assert.equal(client.getSnapshot().currentThreadId, "selected");
  release();
}));

test("opening a thread restores reported context usage without provider activity", async () => withClient(async (client) => {
  const usage = {
    last: { cacheWriteInputTokens: 0, cachedInputTokens: 3, inputTokens: 12, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 16 },
    modelContextWindow: 100,
    total: { cacheWriteInputTokens: 0, cachedInputTokens: 30, inputTokens: 120, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 160 },
  };
  FakeWebSocket.intercept = (socket, request) => {
    if (request.method !== "thread/page/read") return false;
    queueMicrotask(() => socket.respond(request.id, {
      browseResultEntries: [], nextCursor: null, questionnaireEntries: [], steerEntries: [],
      thread: wireThread("thread", "turn", "completed"), tokenUsage: usage,
    }));
    return true;
  };
  const thread = await client.readThread("thread", "codex");
  assert.deepEqual(thread?.tokenUsage, usage);
}));

test("a live context measurement wins over an older in-flight page response", async () => withClient(async (client) => {
  client.selectThreadPayload(activeThread());
  const usage = {
    last: { cacheWriteInputTokens: 0, cachedInputTokens: 3, inputTokens: 12, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 16 },
    modelContextWindow: 100,
    total: { cacheWriteInputTokens: 0, cachedInputTokens: 30, inputTokens: 120, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 160 },
  };
  FakeWebSocket.intercept = (socket, request) => {
    if (request.method !== "thread/page/read") return false;
    queueMicrotask(() => {
      socket.notify("thread/tokenUsage/updated", { threadId: "thread", turnId: "turn", tokenUsage: usage });
      socket.respond(request.id, {
        browseResultEntries: [], nextCursor: null, questionnaireEntries: [], steerEntries: [],
        thread: wireThread("thread", "turn"), tokenUsage: { ...usage, modelContextWindow: 50 },
      });
    });
    return true;
  };
  await client.readThread("thread", "codex");
  assert.deepEqual(client.getSnapshot().currentThread?.tokenUsage, usage);
}));

test("known non-selected and unknown canonical notifications do not retarget or materialize public documents", async () => withClient(async (client, socket) => {
  const background = activeThread("codex", "background");
  const selected = activeThread("codex", "selected");
  client.selectThreadPayload(background);
  client.selectThreadPayload(selected);
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "background", text_elements: [], type: "text" }], id: "background-item", type: "userMessage" },
    threadId: "background", turnId: "background-turn",
  });
  socket.notify("item/started", {
    item: { clientId: null, content: [{ text: "unknown", text_elements: [], type: "text" }], id: "unknown-item", type: "userMessage" },
    threadId: "unknown", turnId: "unknown-turn",
  });
  assert.equal(client.getSnapshot().currentThread?.id, "selected");
  assert.equal(client.getSnapshot().threadDocuments.documentsByKey["codex:unknown"], undefined);
  assert.deepEqual(client.getSnapshot().threadDocuments.documentsByKey["codex:background"]?.turns[0]?.items, []);
}));

test("known hidden threads retain complete live text before later selected deltas append", async () => withClient(async (client, socket) => {
  const background = activeThread("codex", "background");
  client.selectThreadPayload(background);
  client.selectThreadPayload(activeThread("codex", "selected"));
  let visibleEmissions = 0;
  const unsubscribe = client.subscribe(() => {
    visibleEmissions += 1;
  });

  socket.notify("item/started", {
    item: {
      id: "background-commentary",
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "commentary",
      text: "",
      type: "agentMessage",
    },
    threadId: "background",
    turnId: "background-turn",
  });
  socket.notify("item/agentMessage/delta", {
    delta: "complete retained ",
    itemId: "background-commentary",
    threadId: "background",
    turnId: "background-turn",
  });
  socket.notify("item/agentMessage/delta", {
    delta: "prefix",
    itemId: "background-commentary",
    threadId: "background",
    turnId: "background-turn",
  });

  assert.equal(client.getSnapshot().currentThread?.id, "selected");
  assert.deepEqual(
    client.getSnapshot().threadDocuments.documentsByKey["codex:background"]?.turns[0]?.items,
    [],
  );
  assert.equal(visibleEmissions, 0);
  unsubscribe();

  let pageRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method !== "thread/page/read" || request.params?.threadId !== "background") {
      return false;
    }
    pageRequest = request;
    return true;
  };
  const opening = client.openThread("background", { harness: "codex" });
  await waitForRequest(socket, "thread/page/read");
  socket.respond(pageRequest!.id, {
    browseResultEntries: [],
    nextCursor: null,
    questionnaireEntries: [],
    steerEntries: [],
    thread: wireThread("background"),
  });
  assert.equal((await opening).kind, "success");

  const readCommentary = () => client.getSnapshot().currentThread?.turns[0]?.items.find(
    (item): item is Extract<ThreadItem, { type: "agentMessage" }> => item.id === "background-commentary" && item.type === "agentMessage",
  )?.text;
  assert.equal(readCommentary(), "complete retained prefix");

  socket.notify("item/agentMessage/delta", {
    delta: " and selected suffix",
    itemId: "background-commentary",
    threadId: "background",
    turnId: "background-turn",
  });
  assert.equal(readCommentary(), "complete retained prefix and selected suffix");
}));

test("selected text deltas keep canonical snapshots current without publishing the whole runtime", async () => withClient(async (client, socket) => {
  const source = activeThread();
  source.turns[0]!.items = [{
    id: "commentary",
    memoryCitation: null,
    delivery: null,
    questions: null,
    phase: "commentary",
    text: "",
    type: "agentMessage",
  }];
  source.turns.unshift({
    completedAt: 1,
    durationMs: 1,
    error: null,
    id: "settled-turn",
    items: [{
      id: "settled-message", text: "settled", type: "agentMessage",
      phase: "final_answer", memoryCitation: null, delivery: null, questions: null,
    }],
    itemsView: "full",
    startedAt: 0,
    status: "completed",
  });
  client.selectThreadPayload(source);
  const settledTurn = client.getSnapshot().currentThread?.turns[0];
  const key = {
    field: "agentMessageText" as const,
    index: null,
    itemId: "commentary",
    source: { kind: "json" as const, sourceKey: "codex:thread" },
    threadId: "thread",
    turnId: "turn",
  };
  const sqliteKey = {
    ...key,
    source: { kind: "sqlite" as const, sourceKey: "codex:thread" },
  };
  client.textPresentation.subscribe(key, "", () => undefined);
  client.textPresentation.subscribe(sqliteKey, "", () => undefined);
  let publications = 0;
  const unsubscribe = client.subscribe(() => { publications += 1; });

  socket.notify("item/agentMessage/delta", {
    delta: "streamed ",
    itemId: "commentary",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("item/agentMessage/delta", {
    delta: "text",
    itemId: "commentary",
    threadId: "thread",
    turnId: "turn",
  });

  const currentItem = client.getSnapshot().currentThread?.turns
    .find((turn) => turn.id === "turn")?.items[0];
  assert.equal(currentItem?.type === "agentMessage" ? currentItem.text : null, "streamed text");
  assert.equal(client.getSnapshot().currentThread?.turns[0], settledTurn);
  assert.equal(publications, 0);
  await waitForCondition(
    () => client.textPresentation.getSnapshot(key) === "streamed text",
    "expected JSON leaf presentation to catch up",
  );
  assert.equal(client.textPresentation.getSnapshot(sqliteKey), "streamed text");
  unsubscribe();
}));

test("missing text shells and item completion still publish structural state", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread());
  let publications = 0;
  const unsubscribe = client.subscribe(() => { publications += 1; });

  socket.notify("item/agentMessage/delta", {
    delta: "first",
    itemId: "commentary",
    threadId: "thread",
    turnId: "turn",
  });
  assert.ok(publications > 0);
  publications = 0;

  socket.notify("item/agentMessage/delta", {
    delta: " without a mounted leaf",
    itemId: "commentary",
    threadId: "thread",
    turnId: "turn",
  });
  assert.ok(publications > 0);
  publications = 0;

  socket.notify("item/completed", {
    completedAtMs: 2_000,
    item: {
      id: "commentary",
      memoryCitation: null,
      phase: "commentary",
      text: "first without a mounted leaf",
      delivery: null,
      questions: null,
      type: "agentMessage",
    },
    threadId: "thread",
    turnId: "turn",
  });
  assert.ok(publications > 0);
  unsubscribe();
}));

test("project reset during history and control awaits cannot resurrect thread state or start follow-up reads", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let historyRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/steers/read") {
      historyRequest = request;
      return true;
    }
    return false;
  };
  socket.notify("item/completed", {
    item: { clientId: null, content: [{ text: "event", text_elements: [], type: "text" }], id: "event", type: "userMessage" },
    threadId: "thread", turnId: "turn",
  });
  await waitForRequest(socket, "thread/steers/read");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(historyRequest!.id, { data: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.getSnapshot().currentThread, null);

  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), root: "repo", rootPath: "C:/repo" });
  client.selectThreadPayload(source);
  let interruptRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/stop") {
      interruptRequest = request;
      return true;
    }
    return false;
  };
  const stop = client.stopThread(source);
  await waitForRequest(socket, "thread/stop");
  const readsBeforeReset = socket.requests.filter((request) => request.method === "thread/page/read").length;
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("final"), root: "final", rootPath: "C:/final" });
  socket.respond(interruptRequest!.id, { ok: true });
  assert.equal((await stop)?.id, "thread");
  assert.equal(socket.requests.filter((request) => request.method === "thread/page/read").length, readsBeforeReset);
  assert.equal(client.getSnapshot().currentThread, null);
}));

test("project reset during admitted reconciliation history cannot reinstall the old thread", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  let historyRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (isSteerRequest(request)) {
      queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: "acknowledged-turn" }));
      return true;
    }
    if (request.method === "thread/steers/read") {
      historyRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/steers/read");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(historyRequest!.id, { data: [] });
  assert.equal(await send, null);
  assert.equal(client.getSnapshot().currentThread, null);
  assert.equal(client.getSnapshot().threadDocuments.documentsByKey["codex:thread"], undefined);
}));

test("project reset suppresses stale reconciliation failure warnings", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread();
    client.selectThreadPayload(source);
    let readRequest: SocketRequest | null = null;
    FakeWebSocket.intercept = (target, request) => {
      if (isSteerRequest(request)) {
        queueMicrotask(() => target.respond(request.id, { kind: "steered", turnId: "acknowledged-turn" }));
        return true;
      }
      if (request.method === "thread/metadata/read") {
        readRequest = request;
        return true;
      }
      return false;
    };
    const send = client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
    await waitForRequest(socket, "thread/metadata/read");
    client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
    socket.fail(readRequest!.id, "old reconciliation failed");
    assert.equal(await send, null);
    assert.equal(statusMessages.some((message) => message.includes("immediate thread reconciliation failed")), false);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("thread selection reuses cached rate limits while automatic reads are throttled", async () => withClient(async (client, socket) => {
  const pendingRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "account/limits/read") {
      pendingRequests.push(request);
      return true;
    }
    return false;
  };
  const respondWithRateLimits = (request: SocketRequest, limitName: string) => {
    const snapshot = {
      credits: null, individualLimit: null, limitId: "codex", limitName, planType: null,
      primary: null, rateLimitReachedType: null, secondary: null,
    };
    socket.respond(request.id, {
      rateLimitResetCredits: null,
      rateLimits: snapshot,
      rateLimitsByLimitId: { codex: snapshot },
    });
  };

  const seedRefresh = client.refreshRateLimits();
  await waitForCondition(() => pendingRequests.length === 1, "Expected the seed rate-limit read.");
  respondWithRateLimits(pendingRequests[0]!, "cached");
  await seedRefresh;

  client.selectThreadPayload(activeThread("codex", "first", "completed"));
  client.selectThreadPayload(activeThread("codex", "second", "completed"));
  assert.equal(client.getSnapshot().rateLimits?.limitName, "cached");
  assert.equal(pendingRequests.length, 1);

  const explicitRefresh = client.refreshRateLimits();
  await waitForCondition(() => pendingRequests.length === 2, "Expected an explicit rate-limit read.");
  assert.equal(client.getSnapshot().rateLimits?.limitName, "cached");
  respondWithRateLimits(pendingRequests[1]!, "explicit");
  await explicitRefresh;
  assert.equal(client.getSnapshot().rateLimits?.limitName, "explicit");

  socket.notify("account/rateLimits/updated", {});
  await waitForCondition(() => pendingRequests.length === 3, "Expected the account update to bypass the refresh throttle.");
  respondWithRateLimits(pendingRequests[2]!, "notification");
  await waitForCondition(
    () => client.getSnapshot().rateLimits?.limitName === "notification",
    "Expected the account update to replace cached rate limits.",
  );
}));

test("project reset fences a late rate-limit success from the previous project", async () => withClient(async (client, socket) => {
  const pendingRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "account/limits/read") {
      pendingRequests.push(request);
      return true;
    }
    return false;
  };
  const staleRefresh = client.refreshRateLimits();
  await waitForRequest(socket, "account/limits/read", 1);
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  client.selectThreadPayload(activeThread());
  const currentRefresh = client.refreshRateLimits();
  await waitForRequest(socket, "account/limits/read", 2);
  socket.fail(pendingRequests[1]!.id, "new project rate limits unavailable");
  await currentRefresh;

  const staleSnapshot = {
    credits: null, individualLimit: null, limitId: "codex", limitName: "stale", planType: null,
    primary: null, rateLimitReachedType: null, secondary: null,
  };
  socket.respond(pendingRequests[0]!.id, {
    rateLimitResetCredits: null,
    rateLimits: staleSnapshot,
    rateLimitsByLimitId: { codex: staleSnapshot },
  });
  await staleRefresh;
  assert.equal(client.getSnapshot().rateLimits, null);
}));

test("project changes during draft materialization prevent stale dispatch without list polling", async () => withClient(async (client, socket) => {
  const draft = { ...activeThread("codex", "draft", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("draft"), isDraft: true as const, source: "draft" };
  client.selectThreadPayload(draft);
  let startRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/create") {
      startRequest = request;
      return true;
    }
    return false;
  };
  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "thread/create");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(startRequest!.id, { thread: wireThread("materialized") });
  await assert.rejects(send, ThreadMessageNotSentError);
  assert.equal(socket.requests.some((request) => request.method === "thread/list"), false);
  assert.equal(socket.requests.some((request) => request.method === "thread/metadata/read" && request.params?.threadId === "materialized"), false);
  assert.equal(socket.requests.some((request) => isSteerRequest(request) && request.params?.threadId === "materialized"), false);
}));

test("navigation during creation profile acknowledgement cannot select or send the old draft", async () => withClient(async (client, socket) => {
  const draft = { ...activeThread("codex", "draft", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("draft"), isDraft: true as const, source: "draft" };
  client.selectThreadPayload(draft);
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/create") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("created") }));
      return true;
    }
    return request.method === "profiles/target/read";
  };
  const created: string[] = [];
  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
    composerProfileSlot: { kind: "new-thread", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
    onThreadCreated: thread => created.push(thread.id),
  });
  const profileRead = await waitForRequest(socket, "profiles/target/read");
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  socket.respond(profileRead.id, { selection: null });
  await assert.rejects(send, ThreadMessageNotSentError);
  assert.deepEqual(created, []);
  assert.notEqual(client.getSnapshot().currentThread?.id, "created");
  assert.equal(socket.requests.some(request => request.method === "turn/start" || isSteerRequest(request)), false);
}));

test("native plan snapshots and notifications stay out while tagged agent markdown remains", async () => withClient(async (client, socket) => {
  const source = activeThread();
  source.turns[0]!.items = [
    { id: "native-plan", text: "unsupported native plan", type: "plan" },
    {
      id: "tagged-message",
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "final_answer",
      text: "<plan>\n# retained tagged plan\n</plan>",
      type: "agentMessage",
    },
  ];
  client.selectThreadPayload(source);
  assert.deepEqual(client.getSnapshot().currentThread?.turns[0]?.items.map(({ id }) => id), ["tagged-message"]);

  socket.notify("item/plan/delta", {
    delta: "streamed native plan",
    itemId: "streaming-plan",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("item/started", {
    item: { id: "lifecycle-plan", text: "lifecycle native plan", type: "plan" },
    startedAtMs: 2_000,
    threadId: "thread",
    turnId: "turn",
  });

  const items = client.getSnapshot().currentThread?.turns[0]?.items ?? [];
  assert.deepEqual(items.map(({ id }) => id), ["tagged-message"]);
  assert.equal(items[0]?.type === "agentMessage" ? items[0].text : null, "<plan>\n# retained tagged plan\n</plan>");
}));

test("project changes after draft turn dispatch preserve durable acceptance without stale materialization", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  await withClient(async (client, socket) => {
    const draft = { ...activeThread("codex", "00000000-0000-4000-8000-000000000002", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000002"), isDraft: true as const, source: "draft" };
    const materialized: string[] = [];
    let startRequest: SocketRequest | null = null;
    client.selectThreadPayload(draft);
    FakeWebSocket.intercept = (target, request) => {
      if (request.method === "thread/create") {
        queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized-after-dispatch", "old", "completed") }));
        return true;
      }
      if (isAdmissionRequest(request)) {
        startRequest = request;
        return true;
      }
      return false;
    };

    const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
      onThreadMaterialized: (thread) => materialized.push(thread.id),
    });
    await waitForRequest(socket, "admission");
    client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
    socket.respond(startRequest!.id, { kind: "started", turn: wireThread("materialized-after-dispatch", "new-turn").turns[0] });

    assert.equal(await send, null);
    assert.deepEqual(acceptedIntents, [{
      draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000002"),
      harness: "codex",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "materialized-after-dispatch",
      title: "draft",
      turnId: "new-turn",
    }]);
    assert.deepEqual(materialized, []);
  }, {
    publishAcceptedIntent: async (event) => { acceptedIntents.push(event); },
  });
});

test("native turn admission settles a draft when the turn-start response is lost", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  await withClient(async (client, socket) => {
    const draft = { ...activeThread("codex", "00000000-0000-4000-8000-000000000003", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000003"), isDraft: true as const, source: "draft" };
    const materialized: string[] = [];
    let startRequest: SocketRequest | null = null;
    client.selectThreadPayload(draft);
    FakeWebSocket.intercept = (target, request) => {
      if (request.method === "thread/create") {
        queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized-after-response-loss", "bootstrap", "completed") }));
        return true;
      }
      if (isAdmissionRequest(request)) {
        startRequest = request;
        return true;
      }
      return false;
    };

    const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
      onThreadMaterialized: (thread) => materialized.push(thread.id),
    });
    await waitForRequest(socket, "admission");
    const admittedTurn = wireThread("materialized-after-response-loss", "native-turn", "inProgress").turns[0]!;
    socket.notify("turn/started", { threadId: "materialized-after-response-loss", turn: admittedTurn });
    socket.fail(startRequest!.id, "response lost after admission");

    assert.equal(await send, null);
    assert.deepEqual(materialized, ["materialized-after-response-loss"]);
    assert.deepEqual(acceptedIntents, [{
      draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000003"),
      harness: "codex",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "materialized-after-response-loss",
      title: "draft",
      turnId: "native-turn",
    }]);
    assert.deepEqual(client.getSnapshot().currentThread?.turns.map((turn) => turn.id), ["native-turn"]);
    assert.equal(client.getSnapshot().currentThread?.turns.some((turn) => getWorkbenchTurnAdmission(turn) === "connecting"), false);
  }, {
    publishAcceptedIntent: async (event) => { acceptedIntents.push(event); },
  });
});

test("draft projection precedes admission and materialization is skipped on start failure", async () => {
  const acceptedIntents: WorkbenchAcceptedIntent[] = [];
  let markAcceptedIntentObserved!: () => void;
  const acceptedIntentObserved = new Promise<void>((resolve) => { markAcceptedIntentObserved = resolve; });
  let releaseAcceptedIntent: (() => void) | null = null;
  const acceptedIntentPending = new Promise<void>((resolve) => { releaseAcceptedIntent = resolve; });
  await withClient(async (client, socket) => {
  const draft = { ...activeThread("codex", "00000000-0000-4000-8000-000000000001", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"), isDraft: true as const, source: "draft" };
  client.selectThreadPayload(draft);
  const created: string[] = [];
  const materialized: string[] = [];
  let startRequest: SocketRequest | null = null;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/create") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized", "old", "completed") }));
      return true;
    }
    if (isAdmissionRequest(request)) {
      startRequest = request;
      return true;
    }
    return false;
  };

  const send = client.sendThreadMessage(draft, [{ text: "draft", text_elements: [], type: "text" }], {
    onThreadCreated: (thread) => created.push(thread.id),
    onThreadMaterialized: (thread) => materialized.push(thread.id),
  });
  await waitForRequest(socket, "admission");
  assert.deepEqual(created, ["materialized"]);
  assert.equal(materialized.length, 0);
  assert.equal(client.getSnapshot().currentThread?.id, "materialized");
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  assert.equal(client.getSnapshot().currentThread?.turns.length, 1);
  assert.equal(getWorkbenchTurnAdmission(client.getSnapshot().currentThread!.turns[0]!), "connecting");
  const startedNotificationThread = wireThread("materialized", "old", "completed");
  startedNotificationThread.name = "New thread";
  socket.notify("thread/started", { thread: startedNotificationThread });
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  const failedPendingItem = client.getSnapshot().currentThread!.turns.at(-1)!.items[0]!;
  assert.deepEqual(getWorkbenchInputState(failedPendingItem), { kind: "optimistic", placement: "initial", status: "pending" });
  socket.fail(startRequest!.id, "start failed");
  await assert.rejects(send, /start failed/u);
  assert.equal(materialized.length, 0);
  assert.equal(client.getSnapshot().currentThread?.turns.some((turn) => getWorkbenchTurnAdmission(turn) === "connecting"), false);
  assert.equal(client.getSnapshot().currentThread?.turns.flatMap((turn) => turn.items).some((item) => getWorkbenchInputState(item)?.kind === "optimistic"), false);

  client.selectThreadPayload(draft);
  let admittedStartRequest!: SocketRequest;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method === "thread/create") {
      queueMicrotask(() => target.respond(request.id, { thread: wireThread("materialized", "old", "completed") }));
      return true;
    }
    if (isAdmissionRequest(request)) {
      admittedStartRequest = request;
      return true;
    }
    return false;
  };
  const admittedInput = [
    { text: "draft", text_elements: [], type: "text" as const },
    { type: "image" as const, url: "data:image/png;base64,AAAA" },
  ];
  const admittedSend = client.sendThreadMessage(draft, admittedInput, {
    onThreadCreated: (thread) => created.push(thread.id),
    onThreadMaterialized: (thread) => materialized.push(thread.id),
  });
  await waitForRequest(socket, "admission", 1);
  assert.equal(client.getSnapshot().currentThread?.turns.length, 1);
  assert.equal(getWorkbenchTurnAdmission(client.getSnapshot().currentThread!.turns[0]!), "connecting");
  const admittedPendingItem = client.getSnapshot().currentThread!.turns.at(-1)!.items[0]!;
  assert.deepEqual(getWorkbenchInputState(admittedPendingItem), { kind: "optimistic", placement: "initial", status: "pending" });
  const clientUserMessageId = String(admittedStartRequest?.params?.clientMessageId ?? "");
  assert.ok(clientUserMessageId);
  const admittedTurn = wireThread("materialized", "new-turn").turns[0]!;
  socket.notify("turn/started", { threadId: "materialized", turn: admittedTurn });
  socket.notify("item/started", {
    item: { clientId: clientUserMessageId, content: admittedInput, id: "canonical-draft", type: "userMessage" },
    threadId: "materialized",
    turnId: "new-turn",
  });
  socket.respond(admittedStartRequest!.id, { kind: "started", turn: admittedTurn });
  await acceptedIntentObserved;
  assert.deepEqual(acceptedIntents, [{
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    harness: "codex",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    threadId: "materialized",
    title: "draft",
    turnId: "new-turn",
  }]);
  assert.deepEqual(materialized, ["materialized"]);
  releaseAcceptedIntent?.();
  const admitted = await admittedSend;
  assert.ok(admitted);
  assert.equal(admitted.preview, "draft");
  assert.equal(client.getSnapshot().currentThread?.preview, "draft");
  assert.deepEqual(created, ["materialized", "materialized"]);
  assert.deepEqual(materialized, ["materialized"]);
  assert.deepEqual(admitted.turns.map((turn) => turn.id), ["new-turn"]);
  assert.deepEqual(admitted.turns.at(-1)?.items.filter((item) => item.type === "userMessage").map((item) => item.id), ["canonical-draft"]);
  }, {
    publishAcceptedIntent: async (event) => {
      acceptedIntents.push(event);
      markAcceptedIntentObserved();
      await acceptedIntentPending;
    },
  });
});

test("steer-history reads are latest-wins, retain the last success, and warn once per failure streak", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread();
    client.selectThreadPayload(source);
    await client.sendThreadMessage(source, [{ text: "queued", text_elements: [], type: "text" }]);
    const handle = String(socket.requests.find(isSteerRequest)?.params?.clientMessageId ?? "");
    const history: WorkbenchSteerHistoryEntry = {
      attemptedAt: 1, canonicalItemId: null, clientUserMessageId: handle, dispatchSequence: 0,
      entryKey: `turn-steer-client:${handle}`, error: null, input: [{ text: "queued", text_elements: [], type: "text" }],
      itemId: handle, requestId: "1", resolvedAt: null, status: "pending", threadId: "thread", turnId: "turn",
    };
    const historyRequests: SocketRequest[] = [];
    FakeWebSocket.intercept = (_target, request) => {
      if (request.method === "thread/steers/read") {
        historyRequests.push(request);
        return true;
      }
      return false;
    };
    const trigger = (id: string) => socket.notify("item/completed", {
      item: { clientId: null, content: [{ text: id, text_elements: [], type: "text" }], id, type: "userMessage" },
      threadId: "thread", turnId: "turn",
    });

    trigger("event-1");
    trigger("event-2");
    await waitForRequest(socket, "thread/steers/read", 1);
    socket.respond(historyRequests[1]!.id, { data: [history] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.fail(historyRequests[0]!.id, "stale failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(client.getSnapshot().currentThread?.turns[0]?.items.some((item) => (
      item.id === history.itemId && getWorkbenchInputState(item)?.status === "pending"
    )));
    assert.equal(statusMessages.length, 0);

    trigger("event-3");
    await waitForRequest(socket, "thread/steers/read", 2);
    socket.fail(historyRequests[2]!.id, "latest failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    trigger("event-4");
    await waitForRequest(socket, "thread/steers/read", 3);
    socket.fail(historyRequests[3]!.id, "same streak");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(statusMessages.length, 1);

    trigger("event-5");
    await waitForRequest(socket, "thread/steers/read", 4);
    socket.respond(historyRequests[4]!.id, { data: [history] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    trigger("event-6");
    await waitForRequest(socket, "thread/steers/read", 5);
    socket.fail(historyRequests[5]!.id, "new streak");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(statusMessages.length, 2);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("questionnaire and Browse history reads are latest-wins within one project", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const questionnaireRequests: SocketRequest[] = [];
  const browseRequests: SocketRequest[] = [];
  FakeWebSocket.intercept = (_target, request) => {
    if (request.method === "thread/questionnaires/read") {
      questionnaireRequests.push(request);
      return true;
    }
    if (request.method === "thread/browse/read") {
      browseRequests.push(request);
      return true;
    }
    return false;
  };

  socket.notify("questionnaire/resolved", { requestKey: "one", threadId: "thread" });
  socket.notify("questionnaire/resolved", { requestKey: "two", threadId: "thread" });
  await waitForRequest(socket, "thread/questionnaires/read", 1);
  socket.respond(questionnaireRequests[1]!.id, { data: [] });
  socket.respond(questionnaireRequests[0]!.id, { data: [{
    insertAfterItemId: null, insertAfterItemIndex: null, itemId: null,
    request: { id: "old", questions: [], submitLabel: "send", summary: "old", title: "old" },
    requestKey: "old", resolvedAt: 1, response: { answers: {} }, threadId: "thread", turnId: "turn",
  }] });

  socket.notify("browse/result/recorded", { threadId: "thread" });
  socket.notify("browse/result/recorded", { threadId: "thread" });
  await waitForRequest(socket, "thread/browse/read", 1);
  socket.respond(browseRequests[1]!.id, { data: [] });
  socket.respond(browseRequests[0]!.id, { data: [{
    action: "snapshot", actionIndex: 0, assetUrl: null, commandItemId: null, durationMs: 1,
    entryKey: "old", recordedAt: 1, session: "old", state: "completed", threadId: "thread", turnId: "turn",
  }] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const current = client.getSnapshot().currentThread;
  assert.equal(current?.turns.flatMap((turn) => turn.items).some(isSyntheticQuestionnaireHistoryItem), false);
  assert.deepEqual(current?.browseResultEntries, []);
}));

test("questionnaire history keeps last-known answers through refresh failures and clears on later empty success", async () => {
  const statusMessages: string[] = [];
  await withClient(async (client, socket) => {
    const source = activeThread();
    source.turns[0]!.items = [{
      id: "anchor-turn",
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "commentary",
      text: "choose",
      type: "agentMessage",
    }];
    client.selectThreadPayload(source);
    const requests: SocketRequest[] = [];
    FakeWebSocket.intercept = (_target, request) => {
      if (request.method !== "thread/questionnaires/read") return false;
      requests.push(request);
      return true;
    };
    const trigger = (requestKey: string) => socket.notify("questionnaire/resolved", {
      requestKey,
      threadId: "thread",
      turnId: "turn",
    });

    trigger("settled");
    await waitForRequest(socket, "thread/questionnaires/read");
    socket.respond(requests[0]!.id, { data: [questionnaireEntry("turn", "settled")] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hasQuestionnaire = () => client.getSnapshot().currentThread?.turns[0]?.items.some(
      isSyntheticQuestionnaireHistoryItem,
    );
    assert.equal(hasQuestionnaire(), true);

    trigger("failure-one");
    await waitForRequest(socket, "thread/questionnaires/read", 1);
    socket.fail(requests[1]!.id, "temporarily unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasQuestionnaire(), true);
    assert.deepEqual(statusMessages, ["Unable to refresh questionnaire history; showing the last known answers."]);

    trigger("failure-two");
    await waitForRequest(socket, "thread/questionnaires/read", 2);
    socket.fail(requests[2]!.id, "still unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasQuestionnaire(), true);
    assert.equal(statusMessages.length, 1);

    trigger("stale-failure");
    trigger("newer-success");
    await waitForRequest(socket, "thread/questionnaires/read", 4);
    socket.respond(requests[4]!.id, { data: [questionnaireEntry("turn", "settled")] });
    socket.fail(requests[3]!.id, "stale failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasQuestionnaire(), true);
    assert.equal(statusMessages.length, 1);

    trigger("empty-success");
    await waitForRequest(socket, "thread/questionnaires/read", 5);
    socket.respond(requests[5]!.id, { data: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hasQuestionnaire(), false);
  }, { onStatusMessage: (message) => statusMessages.push(message) });
});

test("observed history preserves questionnaires with reused request keys", async () => withClient(async (client) => {
  const source = activeThread();
  source.turns = ["older", "newer"].map((turnId) => ({
    completedAt: 2,
    durationMs: 1,
    error: null,
    id: turnId,
    items: [{
      id: `anchor-${turnId}`,
      memoryCitation: null,
      delivery: null,
      questions: null,
      phase: "commentary",
      text: turnId,
      type: "agentMessage",
    }],
    itemsView: "full",
    startedAt: 1,
    status: "completed",
  }));
  await installProjectThreadState(client, {
    entries: [{
      activityAt: 2,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      questionnaireHistory: [
        questionnaireEntry("older", "question-older"),
        questionnaireEntry("newer", "question-newer"),
      ],
      title: "Thread",
    }],
    error: null,
    freshness: "fresh",
    projectId: fixtureIdentityValues.ProjectId["project"],
    revision: 1,
  });
  client.selectThreadPayload(source);

  assert.deepEqual(
    client.getSnapshot().currentThread?.turns.map((turn) => turn.items[1]?.id),
    [
      "question-older",
      "question-newer",
    ],
  );
}));

test("draft harness migration selects the new exact document and deletes the old key", async () => withClient(async (client) => {
  const draft = { ...activeThread("codex", "draft", "completed"), id: fixtureIdentitySchemas.DraftIdSchema.parse("draft"), isDraft: true as const, source: "draft" };
  client.selectThreadPayload(draft);
  client.setDraftThreadHarness("opencode");
  const documents = client.getSnapshot().threadDocuments;
  assert.equal(documents.selectedThreadKey, "opencode:draft");
  assert.equal(documents.documentsByKey["codex:draft"], undefined);
  assert.equal(documents.documentsByKey["opencode:draft"]?.harness, "opencode");
  assert.equal(documents.keysByThreadId.draft, "opencode:draft");
}));

test("selection drift after dispatch keeps exact failed evidence without selecting the old thread", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "a");
  const other = activeThread("codex", "b");
  client.selectThreadPayload(source);
  let pending: SocketRequest | null = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isSteerRequest(request) && request.params?.threadId === "a") {
      pending = request;
      return true;
    }
    return false;
  };
  const admission = client.sendThreadMessage(source, [{ text: "one", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "steer");
  client.selectThreadPayload(other);
  socket.fail(pending!.id, "transport failed");
  await assert.rejects(admission, /transport failed/u);
  assert.equal(client.getSnapshot().currentThread?.id, "b");
  client.selectThreadPayload(source);
  assert.equal(getWorkbenchInputState(client.getSnapshot().currentThread!.turns[0]!.items[0]!)?.status, "failed");

  const admittedSource = activeThread("codex", "c");
  const selectedOther = activeThread("codex", "d");
  client.selectThreadPayload(admittedSource);
  pending = null;
  FakeWebSocket.intercept = (_target, request) => {
    if (isSteerRequest(request) && request.params?.threadId === "c") {
      pending = request;
      return true;
    }
    return false;
  };
  const admitted = client.sendThreadMessage(admittedSource, [{ text: "two", text_elements: [], type: "text" }]);
  await waitForRequest(socket, "steer", 1);
  client.selectThreadPayload(selectedOther);
  socket.respond(pending!.id, { kind: "steered", turnId: "different-c-turn" });
  assert.equal((await admitted)?.id, "c");
  assert.equal(client.getSnapshot().currentThread?.id, "d");
  assert.equal(client.getSnapshot().threadDocuments.selectedThreadKey, "codex:d");
}));

test("questionnaire supplemental input and skills stay inside one daemon answer intent", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  await client.stopThread(source);
  assert.ok(socket.requests.some((request) => request.method === "thread/stop"));

  socket.notify("questionnaire/requested", {
    itemId: "question-2", requestKey: "question-key", threadId: "thread", turnId: "turn",
    request: { id: "question", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  await client.submitPendingUserInputRequest("thread", { answers: {} }, {
    supplementalInput: [{ text: "extra", text_elements: [], type: "text" }],
  });
  const supplemental = socket.requests.filter((request) => request.method === "questionnaire/respond").at(-1);
  assert.deepEqual(supplemental?.params?.supplementalInput, [{ text: "extra", text_elements: [], type: "text" }]);
  assert.equal(socket.requests.some(isSteerRequest), false);

  const skillPath = "C:/skills/iterate/SKILL.md";
  socket.notify("questionnaire/requested", {
    itemId: "question-3", requestKey: "question-key-2", threadId: "thread", turnId: "turn",
    request: { id: "question-2", questions: [], submitLabel: "send", summary: "question", title: "question" },
  });
  await client.submitPendingUserInputRequest("thread", { answers: {} }, {
    activatedSkillPaths: [skillPath],
  });
  const activatedOnly = socket.requests.filter((request) => request.method === "questionnaire/respond").at(-1);
  assert.deepEqual(activatedOnly?.params?.activatedSkillPaths, [skillPath]);
  assert.equal(socket.requests.some(isSteerRequest), false);
}));

test("interrupted proper questionnaires detach while approvals are discarded", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const question = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  socket.notify("questionnaire/requested", { itemId: "item", request: question, requestKey: "question", threadId: "thread", turnId: "turn" });
  socket.notify("turn/completed", { threadId: "thread", turn: { ...source.turns[0], completedAt: 2, status: "interrupted" } });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "question");

  socket.notify("questionnaire/resolved", { requestKey: "question", threadId: "thread", turnId: "turn" });
  socket.notify("questionnaire/requested", {
    itemId: "approval-item",
    request: { ...question, approval: {}, id: "approval" },
    requestKey: "approval",
    threadId: "thread",
    turnId: "turn",
  });
  socket.notify("turn/completed", { threadId: "thread", turn: { ...source.turns[0], completedAt: 2, status: "interrupted" } });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("observed questionnaires survive shell project changes while native requests retain precedence", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  client.selectThreadPayload(source);
  const durableRequest = {
    id: "durable",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  const durableEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    pendingQuestionnaire: { itemId: "item", request: durableRequest, requestKey: "durable", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
    title: "Thread",
  };

  await installObservedThreadState(client, {
    activeProjectSnapshot: null,
    durableQuestionnaireEntries: [durableEntry],
  });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "durable");
  client.setProjectContext({ projectId: "", root: "", rootPath: "" });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "durable");
  await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "fixture-barrier" });

  socket.notify("questionnaire/requested", {
    itemId: "native-item",
    request: { ...durableRequest, id: "native" },
    requestKey: "native",
    threadId: "thread",
    turnId: "turn",
  });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "native");

  await installObservedThreadState(client, {
    activeProjectSnapshot: null,
    durableQuestionnaireEntries: [],
  });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, "native");
  socket.notify("questionnaire/resolved", { requestKey: "native", threadId: "thread", turnId: "turn" });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("stop dismisses detached questionnaires without interrupting an inactive provider turn", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  client.selectThreadPayload(source);
  const request = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  await installProjectThreadState(client, {
    entries: [{ activityAt: 2, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] }, lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, metadata: { archived: false, pinned: false, snoozed: false }, pendingQuestionnaire: { itemId: "item", request, requestKey: "question", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, title: "Thread" }],
    error: null, freshness: "fresh", projectId: fixtureIdentityValues.ProjectId["project"], revision: 1,
  });
  await waitForCondition(() => client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey === "question", "Durable questionnaire was not installed.");

  await client.stopThread(source);

  const stop = socket.requests.find(candidate => candidate.method === "thread/stop");
  assert.equal(stop?.params?.turnId, undefined);
  assert.equal(stop?.params?.requestKey, "question");
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("stop supplies the active turn and observed questionnaire to shared policy", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  socket.notify("questionnaire/requested", {
    itemId: "item",
    request: {
      id: "question",
      questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
      submitLabel: "Send",
      summary: "Choose",
      title: "Questionnaire",
    },
    requestKey: "question",
    threadId: "thread",
    turnId: "turn",
  });

  await client.stopThread(source);

  const stop = socket.requests.find(candidate => candidate.method === "thread/stop");
  assert.equal(stop?.params?.turnId, "turn");
  assert.equal(stop?.params?.requestKey, "question");
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("detached Workbench questionnaires submit one daemon-owned answer intent", async () => withClient(async (client, socket) => {
  const source = activeThread("codex", "thread", "interrupted");
  client.selectThreadPayload(source);
  const request = {
    id: "question",
    questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
    submitLabel: "Send",
    summary: "Choose",
    title: "Questionnaire",
  };
  const durableEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
    lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    pendingQuestionnaire: { itemId: "item", request, requestKey: "question", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
    title: "Thread",
  };
  await installProjectThreadState(client, {
    entries: [durableEntry],
    error: null,
    freshness: "fresh",
    projectId: fixtureIdentityValues.ProjectId["project"],
    revision: 1,
  });
  await waitForCondition(() => Boolean(client.getSnapshot().pendingUserInputRequestsByThreadId.thread), "Durable questionnaire was not installed.");
  socket.notify("questionnaire/requested", {
    itemId: "item",
    request,
    requestKey: "question",
    threadId: "thread",
    turnId: "turn",
  });

  await client.submitPendingUserInputRequest("thread", { answers: { route: { answers: ["Approve"] } } }, {
    activatedSkillPaths: ["C:/skills/iterate/SKILL.md"],
    insertAfterItemId: "prompt",
    insertAfterItemIndex: 0,
    turnId: "turn",
  });
  const responses = socket.requests.filter((candidate) => candidate.method === "questionnaire/respond");
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0]?.params?.response, { answers: { route: { answers: ["Approve"] } } });
  assert.deepEqual(responses[0]?.params?.activatedSkillPaths, ["C:/skills/iterate/SKILL.md"]);
  assert.equal(responses[0]?.params?.requestKey, "question");
  assert.equal(responses[0]?.params?.threadId, "thread");
  assert.equal(socket.requests.some((candidate) => (
    candidate.method === "thread/metadata/read"
    || candidate.method === "workbench/codex/message/admit"
    || candidate.method === "questionnaire/history/record"
    || candidate.method === "workbench/thread-state/questionnaire/resolve"
  )), false);
  await installObservedThreadState(client, {
    activeProjectSnapshot: null,
    durableQuestionnaireEntries: [durableEntry],
  });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("Workbench MCP questionnaires submit natively while their Codex turn is active", async () => withClient(async (client, socket) => {
  const source = activeThread();
  client.selectThreadPayload(source);
  const requestKey = "workbench-mcp:question";
  FakeWebSocket.intercept = (target, candidate) => {
    if (candidate.method !== "questionnaires/pending/read") return false;
    const pending = client.getSnapshot().pendingUserInputRequestsByThreadId.thread;
    queueMicrotask(() => target.respond(candidate.id, { data: pending ? [pending] : [] }));
    return true;
  };
  await installProjectThreadState(client, {
    entries: [{
      activityAt: 2,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
      lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey, settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
      metadata: { archived: false, pinned: false, snoozed: false },
      pendingQuestionnaire: {
        itemId: null,
        request: {
          id: requestKey,
          questions: [{
            allowOther: true,
            header: "smoke test",
            id: "smoke_test",
            isSecret: false,
            options: [],
            question: "What should lily receive?",
          }],
          submitLabel: "Submit",
          summary: "",
          title: "smoke test",
        },
        requestKey,
        turnId: null,
      },
      title: "Thread",
    }],
    error: null,
    freshness: "fresh",
    projectId: fixtureIdentityValues.ProjectId["project"],
    revision: 1,
  });

  await client.submitPendingUserInputRequest("thread", {
    answers: { smoke_test: { answers: ["hello lily"] } },
  });
  assert.equal(socket.requests.filter((candidate) => candidate.method === "questionnaire/respond").length, 1);
  assert.equal(socket.requests.find((candidate) => candidate.method === "questionnaire/respond")?.params?.turnId, null);
  assert.equal(socket.requests.some((candidate) => candidate.method === "workbench/codex/message/admit"), false);
  assert.equal(socket.requests.some((candidate) => candidate.method === "turn/start"), false);
}));

async function installRecoveredWorkbenchQuestionnaire(
  client: ReturnType<typeof WorkbenchThreadClient>,
  requestKey = "workbench-mcp:recovered",
  turnId: fixtureIdentitySchemas.WorkbenchTurnId | null = fixtureIdentityValues.WorkbenchTurnId.turn,
) {
  const request = {
    id: requestKey,
    questions: [{
      allowOther: true,
      header: "details",
      id: "details",
      isSecret: false,
      options: [],
      question: "What should change?",
    }],
    submitLabel: "Submit",
    summary: "",
    title: "details",
  };
  const pending = { itemId: null, request, requestKey, threadId: fixtureIdentityValues.WorkbenchThreadId.thread, turnId };
  const { threadId: _threadId, ...durable } = pending;
  await installProjectThreadState(client, {
    entries: [{
      activityAt: 2,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
      lifecycle: { kind: "stopped", reason: "providerInterrupted", settled: false, turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] },
      metadata: { archived: false, pinned: false, snoozed: false },
      pendingQuestionnaire: durable,
      title: "Thread",
    }],
    error: null,
    freshness: "fresh",
    projectId: fixtureIdentityValues.ProjectId["project"],
    revision: 1,
  });
  return pending;
}

test("saved Workbench questionnaires use daemon routing without browser metadata or history work", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "thread", "interrupted"));
  const pending = await installRecoveredWorkbenchQuestionnaire(client);
  const response = { answers: { details: { answers: ["Keep one owner."] } } };
  await client.submitPendingUserInputRequest("thread", response);

  const daemonResponse = socket.requests.find((candidate) => candidate.method === "questionnaire/respond");
  assert.equal(daemonResponse?.params?.requestKey, pending.requestKey);
  assert.deepEqual(daemonResponse?.params?.response, response);
  assert.equal(socket.requests.some((candidate) => (
    candidate.method === "thread/metadata/read"
    || candidate.method === "workbench/codex/message/admit"
    || candidate.method === "questionnaire/history/record"
    || candidate.method === "workbench/thread-state/questionnaire/resolve"
  )), false);
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("clearing project selection releases its observation rather than retaining it as a document cache", async () => withClient(async client => {
  await client.openThread("thread", { harness: "codex" });
  assert.equal(client.threadObservations.getObservations().length, 1);
  client.setProjectContext({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("other"), root: "other", rootPath: "C:/other" });
  assert.equal(client.getSnapshot().currentThread, null);
  assert.equal(client.threadObservations.getObservations().length, 0);
}));

test("server reset waits for restored project admission before reopening retained observations", async () => withClient(async (client, socket) => {
  await client.openThread("thread", { harness: "codex" });
  const count = () => socket.requests.filter(request => request.method === "workbench/thread-state/observe").length;
  assert.equal(count(), 1);
  socket.notify("workbench/thread-state/reset", {});
  // An acknowledged socket request drains earlier sends without a timer or guessed delay.
  await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "unused" });
  assert.equal(count(), 1);
  client.threadObservations.reset();
  await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "unused" });
  assert.equal(count(), 2);
}));

test("live observed questionnaires arrive and clear without sidebar questionnaire installation", async () => withClient(async (client, socket) => {
  const question = {
    itemId: null, requestKey: "observed-question", turnId: "turn",
    request: { id: "question", title: "Choose", summary: "", submitLabel: "Send", questions: [
      { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
    ] },
  };
  let observation!: Record<string, unknown>;
  FakeWebSocket.intercept = (target, request) => {
    if (request.method !== "workbench/thread-state/observe") return false;
    observation = {
      ...request.params, revision: 1, freshness: "fresh", error: null, updateKind: "threadObservation",
      entries: [{
        activityAt: 1, entryKind: "thread", title: "Thread", identity: { harness: "codex", threadId: "thread" },
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: question.requestKey, turnId: "turn", settled: false },
        pendingQuestionnaire: question,
      }],
    };
    queueMicrotask(() => target.respond(request.id, { observation }));
    return true;
  };
  await client.openThread("thread", { harness: "codex" });
  const pending = client.getSnapshot().pendingUserInputRequestsByThreadId.thread;
  assert.equal(pending?.requestKey, question.requestKey);
  socket.notify("workbench/thread-state/updated", { ...observation, entries: [], revision: 2 });
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread, undefined);
}));

test("opening a thread does not publish its document before its durable state is admitted", async () => withClient(async (client, socket) => {
  let opening!: SocketRequest;
  FakeWebSocket.intercept = (_socket, request) => {
    if (request.method !== "workbench/thread-state/observe") return false;
    opening = request;
    return true;
  };
  const read = client.openThread("thread", { harness: "codex" });
  await waitForRequest(socket, "workbench/thread-state/observe");
  await client.requestWorkbench("workbench/thread-state/release", { subscriptionId: "fixture-barrier" });
  assert.equal(client.getSnapshot().currentThread, null);
  socket.respond(opening.id, { observation: {
    ...opening.params, revision: 1, freshness: "fresh", error: null, updateKind: "threadObservation",
    entries: [{
      activityAt: 1, entryKind: "thread", title: "Thread", identity: { harness: "codex", threadId: "thread" },
      metadata: { archived: false, pinned: true, snoozed: false },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    }],
  } });
  assert.equal((await read).kind, "success");
  assert.equal(client.getSnapshot().currentThread?.id, "thread");
}));

test("a stale route cannot select a shared read but the document remains cached", async () => withClient(async (client, socket) => {
  const page = Promise.withResolvers<SocketRequest>();
  FakeWebSocket.intercept = (_socket, request) => {
    if (request.method !== "thread/page/read") return false;
    page.resolve(request);
    return true;
  };
  let current = true;
  const opening = client.openThread("thread", { harness: "codex", isCurrent: () => current });
  const request = await page.promise;
  current = false;
  socket.respond(request.id, { thread: wireThread("thread"), nextCursor: null, browseResultEntries: [], questionnaireEntries: [], steerEntries: [] });
  assert.deepEqual(await opening, { kind: "superseded" });
  assert.equal(client.getSnapshot().currentThread, null);
  assert.ok(client.getThreadController("project", { kind: "provider", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("thread") }).getSnapshot().document);
}));

test("repeated opens of one identity share the pending read without invalidating it", async () => withClient(async (client, socket) => {
  FakeWebSocket.intercept = (_socket, request) => request.method === "thread/page/read";
  const first = client.openThread("thread", { harness: "codex" });
  const request = await waitForRequest(socket, "thread/page/read");
  const second = client.openThread("thread", { harness: "codex" });
  socket.respond(request.id, {
    thread: wireThread("thread"), browseResultEntries: [], questionnaireEntries: [], steerEntries: [], nextCursor: null,
  });
  assert.equal((await first).kind, "success");
  assert.equal((await second).kind, "success");
  assert.equal(socket.requests.filter(request => request.method === "thread/page/read").length, 1);
}));

test("daemon questionnaire rejection keeps the exact saved request retryable", async () => withClient(async (client, socket) => {
  client.selectThreadPayload(activeThread("codex", "thread", "interrupted"));
  FakeWebSocket.intercept = (target, candidate) => {
    if (candidate.method !== "questionnaire/respond") return false;
    queueMicrotask(() => target.fail(candidate.id, "daemon routing failed"));
    return true;
  };
  const pending = await installRecoveredWorkbenchQuestionnaire(client);
  await assert.rejects(
    client.submitPendingUserInputRequest("thread", { answers: { details: { answers: ["Continue"] } } }),
    /daemon routing failed/u,
  );
  assert.equal(client.getSnapshot().pendingUserInputRequestsByThreadId.thread?.requestKey, pending.requestKey);
  assert.equal(socket.requests.filter((candidate) => candidate.method === "questionnaire/respond").length, 1);
}));

