/*
 * Exports:
 * - No production exports; Node tests cover turn ownership, thread-global native steer identity, delivery, and scoped context collection. Keywords: codex, transcript, turn ownership, steer, context, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { WorkbenchBrowseResultEntry, WorkbenchQuestionnaireHistoryEntry } from "../lib/types";
import CodexTranscriptStore from "./CodexTranscriptStore";
import type { JsonRpcRequest } from "./bridge-types";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import type {
  CodexTranscriptRawEvent,
  CodexTranscriptThreadFile,
  CodexTranscriptTurnFile,
} from "./codex-transcript-types";
import { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";

function captureProcessStderr(context: TestContext) {
  const stderr: string[] = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  context.after(() => {
    process.stderr.write = originalStderrWrite;
  });
  return stderr;
}

function request(id: number, clientUserMessageId: string, expectedTurnId = "turn-a"): JsonRpcRequest {
  return {
    id,
    method: "turn/steer",
    params: {
      clientUserMessageId,
      expectedTurnId,
      input: [{ text: "same", text_elements: [], type: "text" }],
      threadId: "thread",
    },
  };
}

function snapshot(turns: Thread["turns"]): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id: "thread", modelProvider: "openai", name: null, parentThreadId: null,
    path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session", source: "appServer", status: { activeFlags: [], type: "active" },
    threadSource: null, turns, updatedAt: 2,
  };
}

function transcriptTurn(id: string, itemIds: string[]): Thread["turns"][number] {
  return {
    completedAt: 2,
    durationMs: 1,
    error: null,
    id,
    items: itemIds.map((itemId) => ({
      clientId: null,
      content: [{ text: itemId, text_elements: [], type: "text" }],
      id: itemId,
      type: "userMessage",
    })),
    itemsView: "full",
    startedAt: 1,
    status: "completed",
  };
}

function threadFilePath(root: string) {
  return path.join(root, ".workbench", "transcripts", "codex", "threads", encodeTranscriptPathSegment("thread"), "thread.json");
}

function turnFilePath(root: string, turnId: string) {
  return path.join(
    root,
    ".workbench",
    "transcripts",
    "codex",
    "threads",
    encodeTranscriptPathSegment("thread"),
    "turns",
    `${encodeTranscriptPathSegment(turnId)}.json`,
  );
}

async function readThreadFile(root: string) {
  return JSON.parse(await fs.readFile(threadFilePath(root), "utf8")) as CodexTranscriptThreadFile;
}

async function hydrateThread(store: CodexTranscriptStore, turns: Thread["turns"]) {
  const response = await store.hydrateThreadResponse(
    { id: 90, method: "thread/read", params: { threadId: "thread" } },
    { id: 90, result: { thread: snapshot(turns) } },
  );
  return (response.result as { thread: Thread }).thread;
}

function event(id: string): CodexTranscriptRawEvent {
  return { id, method: "turn/steer", payload: {}, receivedAt: 1, requestId: id, source: "workbench" };
}

async function withStore(run: (store: CodexTranscriptStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-test-"));
  const store = new CodexTranscriptStore(root);
  try {
    await run(store, root);
  } finally {
    await store.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
}

test("stored item ownership rejects later duplicate turns without hiding their new items", async () => withStore(async (store, root) => {
  await store.recordHydratedThreadSnapshot({
    id: 80,
    result: { thread: snapshot([transcriptTurn("real", ["exec"])]) },
  });
  const refreshedTurns = [
    transcriptTurn("real", ["item-1"]),
    transcriptTurn("rollout-586", ["exec"]),
    transcriptTurn("mixed", ["exec", "new"]),
  ];
  await store.recordHydratedThreadSnapshot({ id: 81, result: { thread: snapshot(refreshedTurns) } });

  const threadFile = await readThreadFile(root);
  assert.deepEqual(threadFile.turnIndex.map((entry) => [entry.turnId, entry.itemIds]), [
    ["real", ["exec", "item-1"]],
    ["mixed", ["new"]],
  ]);

  const hydrated = await hydrateThread(store, refreshedTurns);
  assert.deepEqual(hydrated.turns.map((turn) => [turn.id, turn.items.map((item) => item.id)]), [
    ["mixed", ["new"]],
  ]);
}));

test("provider catalogs remain unloaded until one exact turn page materializes", async () => withStore(async (store, root) => {
  const older = { ...transcriptTurn("older", []), itemsView: "notLoaded" as const };
  const latest = transcriptTurn("latest", ["latest-item"]);
  await store.recordProviderTurnCatalog(snapshot([]), [older, latest], {
    cursor: "after-latest",
    turnId: "latest",
  });
  await assert.rejects(fs.access(turnFilePath(root, "older")));
  await assert.rejects(fs.access(turnFilePath(root, "latest")));

  await store.recordProviderTurnPage(snapshot([]), latest, "after-latest");
  const latestWindow = await store.hydrateThreadResponse(
    { id: 91, method: "thread/read", params: { threadId: "thread" } },
    { id: 91, result: { thread: snapshot([]) } },
    { hydration: { mode: "latest" } },
  );
  const latestThread = (latestWindow.result as { thread: Thread }).thread as Thread & {
    workbenchTurnHistory: Array<{ loadState: string; turnId: string }>;
  };
  assert.deepEqual(latestThread.turns.map((candidate) => candidate.id), ["latest"]);
  assert.deepEqual(latestThread.workbenchTurnHistory.map(({ loadState, turnId }) => [turnId, loadState]), [
    ["older", "unloaded"],
    ["latest", "loaded"],
  ]);
  assert.equal(await store.readProviderPreviousCursor("thread", "latest"), "after-latest");

  await store.recordProviderTurnPage(snapshot([]), transcriptTurn("older", ["older-item"]), null);
  const olderWindow = await store.hydrateThreadResponse(
    { id: 92, method: "thread/read", params: { threadId: "thread" } },
    { id: 92, result: { thread: snapshot([]) } },
    { hydration: { beforeTurnId: "latest", mode: "previous" } },
  );
  assert.deepEqual(
    (olderWindow.result as { thread: Thread }).thread.turns.map((candidate) => candidate.id),
    ["older"],
  );
  assert.equal(await store.readProviderPreviousCursor("thread", "older"), null);
}));

test("live turn lifecycle snapshots create and update one durable turn index entry", async () => withStore(async (store, root) => {
  await store.recordHydratedThreadSnapshot({ id: 93, result: { thread: snapshot([]) } });
  const startedTurn = {
    ...transcriptTurn("live", ["user"]),
    completedAt: null,
    durationMs: null,
    status: "inProgress" as const,
  };
  await store.recordUpstreamNotification({
    method: "turn/started",
    params: { threadId: "thread", turn: startedTurn },
  });

  const startedThreadFile = await readThreadFile(root);
  assert.deepEqual(startedThreadFile.turnIndex.map((entry) => ({
    itemIds: entry.itemIds,
    status: entry.status,
    turnId: entry.turnId,
  })), [{
    itemIds: ["user"],
    status: "inProgress",
    turnId: "live",
  }]);

  await store.recordUpstreamNotification({
    method: "turn/completed",
    params: {
      threadId: "thread",
      turn: {
        ...transcriptTurn("live", ["user", "assistant"]),
        completedAt: 4,
        durationMs: 3_000,
      },
    },
  });

  const completedThreadFile = await readThreadFile(root);
  assert.deepEqual(completedThreadFile.turnIndex.map((entry) => ({
    completedAt: entry.completedAt,
    itemIds: entry.itemIds,
    status: entry.status,
    turnId: entry.turnId,
  })), [{
    completedAt: 4,
    itemIds: ["user", "assistant"],
    status: "completed",
    turnId: "live",
  }]);
}));

test("duplicate stored ownership repairs from canonical turn timelines once", async () => withStore(async (store, root) => {
  const originalTurn = transcriptTurn("real", ["exec"]);
  const duplicateTurns = [
    originalTurn,
    transcriptTurn("rollout-586", ["exec"]),
    transcriptTurn("synthetic-uuid", ["exec"]),
  ];
  await store.recordHydratedThreadSnapshot({ id: 82, result: { thread: snapshot([originalTurn]) } });
  await store.recordHydratedThreadSnapshot({ id: 83, result: { thread: snapshot(duplicateTurns) } });

  const cleanThreadFile = await readThreadFile(root);
  const originalEntry = cleanThreadFile.turnIndex[0]!;
  await fs.writeFile(threadFilePath(root), JSON.stringify({
    ...cleanThreadFile,
    turnIndex: [
      { ...originalEntry, itemIds: ["item-1"], turnId: "real" },
      { ...originalEntry, itemIds: ["exec"], turnId: "rollout-586" },
      { ...originalEntry, itemIds: ["exec"], turnId: "synthetic-uuid" },
    ],
  }), "utf8");

  const providerTurns = duplicateTurns.slice(1);
  await store.recordHydratedThreadSnapshot({ id: 84, result: { thread: snapshot(providerTurns) } });
  const firstHydration = await hydrateThread(store, providerTurns);
  const secondHydration = await hydrateThread(store, providerTurns);
  assert.deepEqual(firstHydration.turns.map((turn) => turn.id), ["real"]);
  assert.deepEqual(secondHydration.turns.map((turn) => turn.id), ["real"]);
  assert.equal(firstHydration.turns[0]?.items.some((item) => item.id === "exec"), true);

  const repairedThreadFile = await readThreadFile(root);
  assert.deepEqual(repairedThreadFile.turnIndex.map((entry) => entry.turnId), ["real"]);
  assert.equal(repairedThreadFile.turnIndex[0]?.itemIds?.includes("exec"), true);
}));

test("selected hydration keeps notification items that arrived after the turn index", async () => withStore(async (store, root) => {
  const initialTurn = transcriptTurn("active", ["user"]);
  await store.recordHydratedThreadSnapshot({ id: 85, result: { thread: snapshot([initialTurn]) } });
  await store.recordUpstreamNotification({
    method: "item/completed",
    params: {
      item: { id: "commentary", memoryCitation: null, phase: "commentary", text: "visible", type: "agentMessage" },
      threadId: "thread",
      turnId: "active",
    },
  });

  const hydrated = await hydrateThread(store, [initialTurn]);
  assert.deepEqual(hydrated.turns[0]?.items.map((item) => item.id), ["user", "commentary"]);
  const threadFile = await readThreadFile(root);
  assert.deepEqual(threadFile.turnIndex[0]?.itemIds, ["user", "commentary"]);
}));

test("selected hydration replaces stale projected ids with canonical turn ids", async () => withStore(async (store, root) => {
  const canonicalTurn = transcriptTurn("active", ["user", "commentary"]);
  await store.recordHydratedThreadSnapshot({ id: 86, result: { thread: snapshot([canonicalTurn]) } });
  const threadFile = await readThreadFile(root);
  await fs.writeFile(threadFilePath(root), JSON.stringify({
    ...threadFile,
    turnIndex: threadFile.turnIndex.map((entry) => ({
      ...entry,
      itemCount: 2,
      itemIds: ["stale-user", "stale-commentary"],
    })),
  }), "utf8");

  const hydrated = await hydrateThread(store, [canonicalTurn]);
  assert.deepEqual(hydrated.turns[0]?.items.map((item) => item.id), ["user", "commentary"]);
  const repairedThreadFile = await readThreadFile(root);
  assert.deepEqual(repairedThreadFile.turnIndex[0]?.itemIds, ["user", "commentary"]);
}));

test("stored turn snapshots expose the normalized durable item timeline", async () => withStore(async (store, root) => {
  const turn = transcriptTurn("active", ["user"]);
  await store.recordHydratedThreadSnapshot({ id: 87, result: { thread: snapshot([turn]) } });
  const filePath = turnFilePath(root, "active");
  const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as CodexTranscriptTurnFile;
  await fs.writeFile(filePath, JSON.stringify({
    ...stored,
    itemTimeline: [
      {
        aliases: ["provider-user", "provider-user", ""],
        anchorItemId: "user",
        completedAt: 2_000,
        firstSeenAt: 1_000,
        itemId: "user",
        lastSeenAt: 2_000,
        sequence: 1,
        startedAt: 1_100,
      },
      { anchorItemId: null, itemId: "", sequence: 2 },
    ],
  }), "utf8");

  assert.deepEqual(await store.readStoredTurnSnapshot("thread", "active"), {
    itemTimeline: [{
      aliases: ["provider-user"],
      completedAt: 2_000,
      firstSeenAt: 1_000,
      itemId: "user",
      lastSeenAt: 2_000,
      startedAt: 1_100,
    }],
    turn,
  });
  assert.equal(await store.readStoredTurnSnapshot("thread", "missing"), null);
}));

test("a new empty transcript store completes every migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-empty-test-"));
  const store = new CodexTranscriptStore(root);
  try {
    await store.dispose();
    const migrationState = JSON.parse(await fs.readFile(path.join(root, ".workbench", "transcripts", "codex", "migration.json"), "utf8")) as {
      migratedAt?: unknown;
      schemaVersion?: unknown;
    };
    assert.equal(migrationState.schemaVersion, CODEX_TRANSCRIPT_SCHEMA_VERSION);
    assert.equal(typeof migrationState.migratedAt, "number");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("legacy transcript cleanup progress uses the dedicated transcript diagnostic log", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-diagnostic-test-"));
  const requestsDirectory = path.join(root, ".workbench", "transcripts", "codex", "threads", "thread", "requests");
  const records: Array<{ event: string; source: string }> = [];
  await fs.mkdir(requestsDirectory, { recursive: true });
  await fs.writeFile(path.join(requestsDirectory, "request.ndjson"), "{}\n", "utf8");
  const store = new CodexTranscriptStore(root, () => [], {
    flush: async () => undefined,
    write: (record) => { records.push(record); },
  });
  try {
    await store.dispose();
    assert.ok(records.some(({ event, source }) => (
      event === "request-journal-cleanup-started" && source === "codex-transcript"
    )));
    assert.ok(records.some(({ event, source }) => (
      event === "request-journal-cleanup-completed" && source === "codex-transcript"
    )));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("native steer admissions are thread-global and sequence ordered", async () => withStore(async (store) => {
  await store.recordClientRequest(request(9, "native-z", "turn-a"));
  await store.recordClientRequest(request(10, "native-a", "turn-b"));
  const entries = await store.listSteerHistory("thread");
  assert.deepEqual(entries.map((entry) => [entry.clientUserMessageId, entry.dispatchSequence, entry.requestId]), [
    ["native-z", 0, "9"],
    ["native-a", 1, "10"],
  ]);
}));

test("scoped thread context collection reads each sidecar kind for only the selected turns", async () => withStore(async (store) => {
  const browseEntry = (turnId: string): WorkbenchBrowseResultEntry => ({
    action: "snapshot",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: null,
    detailKind: "result",
    detailLabel: null,
    detailText: turnId,
    durationMs: 1,
    entryKey: `browse:${turnId}`,
    recordedAt: turnId === "turn-a" ? 1 : 2,
    session: "research",
    state: "completed",
    threadId: "thread",
    turnId,
  });
  const questionnaireEntry = (turnId: string): WorkbenchQuestionnaireHistoryEntry => ({
    insertAfterItemId: null,
    insertAfterItemIndex: null,
    itemId: null,
    request: { id: `request:${turnId}`, questions: [], submitLabel: "Submit", summary: "", title: "" },
    requestKey: `questionnaire:${turnId}`,
    resolvedAt: turnId === "turn-a" ? 1 : 2,
    response: { answers: {} },
    threadId: "thread",
    turnId,
  });

  for (const turnId of ["turn-a", "turn-b"]) {
    await store.recordBrowseResultEntry(browseEntry(turnId));
    await store.recordQuestionnaireResolved(questionnaireEntry(turnId));
    await store.recordClientRequest(request(turnId === "turn-a" ? 40 : 41, `native:${turnId}`, turnId));
  }

  const turnFileOwner = store as unknown as {
    readTurnFiles(threadId: string, options?: { turnIds?: Iterable<string> }): Promise<object[]>;
  };
  const readTurnFiles = turnFileOwner.readTurnFiles.bind(turnFileOwner);
  let turnFileReadCount = 0;
  turnFileOwner.readTurnFiles = async (...args) => {
    turnFileReadCount += 1;
    return await readTurnFiles(...args);
  };

  const scoped = await store.readThreadContextEntries("thread", { turnIds: ["turn-a"] });
  assert.equal(turnFileReadCount, 1);
  assert.deepEqual(scoped.browseResultEntries.map((entry) => entry.turnId), ["turn-a"]);
  assert.deepEqual(scoped.questionnaireEntries.map((entry) => entry.turnId), ["turn-a"]);
  assert.deepEqual(scoped.steerEntries.map((entry) => entry.turnId), ["turn-a"]);

  const full = await store.readThreadContextEntries("thread");
  assert.equal(turnFileReadCount, 2);
  assert.deepEqual(full.browseResultEntries.map((entry) => entry.turnId), ["turn-a", "turn-b"]);
  assert.deepEqual(full.questionnaireEntries.map((entry) => entry.turnId), ["turn-a", "turn-b"]);
  assert.deepEqual(full.steerEntries.map((entry) => entry.turnId), ["turn-a", "turn-b"]);
}));

test("questionnaire history preserves reused request keys within one turn", async () => withStore(async (store) => {
  const questionnaire = (itemId: string, answer: string): WorkbenchQuestionnaireHistoryEntry => ({
    insertAfterItemId: null,
    insertAfterItemIndex: null,
    itemId,
    request: { id: itemId, questions: [], submitLabel: "Submit", summary: "", title: itemId },
    requestKey: "reused",
    resolvedAt: itemId === "question-one" ? 1 : 2,
    response: { answers: { choice: { answers: [answer] } } },
    threadId: "thread",
    turnId: "turn",
  });

  await store.recordQuestionnaireResolved(questionnaire("question-one", "one"));
  await store.recordQuestionnaireResolved(questionnaire("question-two", "two"));
  await store.recordQuestionnaireResolved(questionnaire("question-one", "updated"));

  const entries = await store.listQuestionnaireHistory("thread");
  assert.deepEqual(entries.map((entry) => entry.itemId), ["question-one", "question-two"]);
  assert.deepEqual(entries.find((entry) => entry.itemId === "question-one")?.response, {
    answers: { choice: { answers: ["updated"] } },
  });
}));

test("canonical client identity wins over delayed acknowledgement and failure", async () => withStore(async (store) => {
  const original = request(21, "native", "expected-turn");
  await store.recordClientRequest(original);
  await store.recordUpstreamNotification({
    method: "item/started",
    params: {
      item: { clientId: "native", content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical", type: "userMessage" },
      threadId: "thread",
      turnId: "canonical-turn",
    },
  });
  await store.recordUpstreamResponse(original, { id: 21, result: { turnId: "different-turn" } });
  await store.recordClientRequestFailure(original, "late failure");
  const [entry] = await store.listSteerHistory("thread");
  assert.deepEqual({ canonicalItemId: entry?.canonicalItemId, error: entry?.error, status: entry?.status, turnId: entry?.turnId }, {
    canonicalItemId: "canonical", error: null, status: "sent", turnId: "canonical-turn",
  });
}));

test("a duplicate native id from another upstream request cannot mutate the first", async (context) => {
  const stderr = captureProcessStderr(context);
  await withStore(async (store) => {
    await store.recordClientRequest(request(1, "native"));
    await store.recordClientRequest(request(2, "native"));
    await store.recordClientRequestFailure(request(2, "native"), "wrong request failed");
    const entries = await store.listSteerHistory("thread");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.requestId, "1");
    assert.equal(entries[0]?.status, "pending");
  });
  assert.equal(stderr.length, 1);
  assert.match(stderr[0]!, /ignored duplicate native steer id for thread thread from upstream request 2/u);
});

test("a delayed admission failure cannot overwrite interruption evidence", async () => withStore(async (store) => {
  const original = request(3, "native");
  await store.recordClientRequest(original);
  await store.recordHydratedThreadSnapshot({
    id: 3,
    result: {
      thread: {
        agentNickname: null, agentRole: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
        forkedFromId: null, gitInfo: null, id: "thread", modelProvider: "openai", name: null, parentThreadId: null,
        path: null, preview: "", recencyAt: null, sessionId: "session", source: "appServer", status: { activeFlags: [], type: "active" },
        threadSource: null, turns: [{ completedAt: 2, durationMs: 1, error: null, id: "turn-a", items: [], itemsView: "full", startedAt: 1, status: "interrupted" }],
        updatedAt: 2,
      },
    },
  });
  await store.recordClientRequestFailure(original, "late failure");
  const [entry] = await store.listSteerHistory("thread");
  assert.equal(entry?.status, "interrupted");
  assert.equal(entry?.error, "The turn stopped before this steer was delivered.");
}));

test("blank and JSON-RPC failures update only their exact unresolved native request", async () => withStore(async (store) => {
  const blank = request(4, "blank");
  const failed = request(5, "failed");
  await store.recordClientRequest(blank);
  await store.recordClientRequest(failed);
  await store.recordUpstreamResponse(blank, { id: 4, result: { turnId: "" } });
  await store.recordUpstreamResponse(failed, { error: { code: -32000, message: "rejected" }, id: 5 });
  const entries = await store.listSteerHistory("thread");
  assert.deepEqual(entries.map((entry) => [entry.clientUserMessageId, entry.status, entry.error]), [
    ["blank", "failed", "turn/steer returned an empty turn id."],
    ["failed", "failed", "rejected"],
  ]);
}));

test("two identical native steers deliver independently across actual turns", async () => withStore(async (store) => {
  await store.recordClientRequest(request(6, "native-a", "expected"));
  await store.recordClientRequest(request(7, "native-b", "expected"));
  for (const [clientId, itemId, turnId] of [["native-a", "item-a", "actual-a"], ["native-b", "item-b", "actual-b"]] as const) {
    await store.recordUpstreamNotification({
      method: "item/started",
      params: {
        item: { clientId, content: [{ text: "same", text_elements: [], type: "text" }], id: itemId, type: "userMessage" },
        threadId: "thread",
        turnId,
      },
    });
  }
  assert.deepEqual((await store.listSteerHistory("thread")).map((entry) => [entry.clientUserMessageId, entry.status, entry.turnId, entry.canonicalItemId]), [
    ["native-a", "sent", "actual-a", "item-a"],
    ["native-b", "sent", "actual-b", "item-b"],
  ]);
}));

test("interrupted snapshots recover exact canonical delivery before terminalizing unresolved entries", async () => withStore(async (store) => {
  await store.recordClientRequest(request(8, "delivered", "turn-a"));
  await store.recordClientRequest(request(9, "unresolved", "turn-a"));
  await store.recordHydratedThreadSnapshot({
    id: 8,
    result: { thread: snapshot([{
      completedAt: 2, durationMs: 1, error: null, id: "turn-a", items: [{
        clientId: "delivered", content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical", type: "userMessage",
      }], itemsView: "full", startedAt: 1, status: "interrupted",
    }]) },
  });
  assert.deepEqual((await store.listSteerHistory("thread")).map((entry) => [entry.clientUserMessageId, entry.status]), [
    ["delivered", "sent"],
    ["unresolved", "interrupted"],
  ]);
}));

test("repeated canonical aliases are idempotent and clear stale failure evidence", async () => withStore(async (store) => {
  const original = request(10, "native");
  await store.recordClientRequest(original);
  await store.recordClientRequestFailure(original, "socket failed");
  for (const itemId of ["item-1", "canonical"]) {
    await store.recordUpstreamNotification({
      method: "item/completed",
      params: {
        item: { clientId: "native", content: [{ text: "same", text_elements: [], type: "text" }], id: itemId, type: "userMessage" },
        threadId: "thread", turnId: "actual",
      },
    });
  }
  const [entry] = await store.listSteerHistory("thread");
  assert.deepEqual({ canonicalItemId: entry?.canonicalItemId, error: entry?.error, status: entry?.status }, {
    canonicalItemId: "canonical", error: null, status: "sent",
  });
}));

test("native failure preserves admission sequence and legacy equal keys stay distinct by turn", async () => withStore(async (store) => {
  const native = request(11, "native");
  await store.recordClientRequest(native);
  const [before] = await store.listSteerHistory("thread");
  await store.recordClientRequestFailure(native, "failed");
  const [after] = await store.listSteerHistory("thread");
  assert.equal(after?.attemptedAt, before?.attemptedAt);
  assert.equal(after?.dispatchSequence, before?.dispatchSequence);

  await store.recordClientRequest(request(12, "", "legacy-a"));
  await store.recordClientRequest(request(12, "", "legacy-b"));
  const legacy = (await store.listSteerHistory("thread")).filter((entry) => !entry.clientUserMessageId);
  assert.deepEqual(legacy.map((entry) => entry.turnId).sort(), ["legacy-a", "legacy-b"]);
}));

test("legacy content reconciliation ignores entries that already have native identity", async () => withStore(async (store) => {
  await store.recordSteerHistoryEntry({
    attemptedAt: 1, canonicalItemId: null, clientUserMessageId: "native", dispatchSequence: null,
    entryKey: "legacy-native", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
    requestId: "legacy", resolvedAt: null, status: "pending", threadId: "thread", turnId: "turn-a",
  }, event("legacy-native"));
  await store.recordUpstreamNotification({
    method: "item/started",
    params: {
      item: { clientId: null, content: [{ text: "same", text_elements: [], type: "text" }], id: "unrelated", type: "userMessage" },
      threadId: "thread", turnId: "turn-a",
    },
  });
  const entry = (await store.listSteerHistory("thread")).find((candidate) => candidate.entryKey === "legacy-native");
  assert.equal(entry?.status, "pending");
}));

test("legacy delayed acknowledgement failure cannot regress canonical delivery", async () => withStore(async (store) => {
  const legacy = request(30, "", "turn-a");
  await store.recordClientRequest(legacy);
  await store.recordUpstreamNotification({
    method: "item/completed",
    params: {
      item: { clientId: null, content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical", type: "userMessage" },
      threadId: "thread", turnId: "turn-a",
    },
  });
  await store.recordUpstreamResponse(legacy, { error: { code: -32000, message: "late failure" }, id: 30 });
  const entry = (await store.listSteerHistory("thread")).find((candidate) => candidate.requestId === "30");
  assert.deepEqual({ canonicalItemId: entry?.canonicalItemId, error: entry?.error, status: entry?.status }, {
    canonicalItemId: "canonical", error: null, status: "sent",
  });
}));
