/*
 * Exports:
 * - No production exports; Node tests cover thread-global native steer transcript identity and delivery. Keywords: codex, transcript, steer, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import CodexTranscriptStore from "./CodexTranscriptStore";
import type { JsonRpcRequest } from "./bridge-types";
import type { CodexTranscriptRawEvent } from "./codex-transcript-types";

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
    agentNickname: null, agentRole: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    forkedFromId: null, gitInfo: null, id: "thread", modelProvider: "openai", name: null, parentThreadId: null,
    path: null, preview: "", recencyAt: null, sessionId: "session", source: "appServer", status: { activeFlags: [], type: "active" },
    threadSource: null, turns, updatedAt: 2,
  };
}

function event(id: string): CodexTranscriptRawEvent {
  return { id, method: "turn/steer", payload: {}, receivedAt: 1, requestId: id, source: "workbench" };
}

async function withStore(run: (store: CodexTranscriptStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-transcript-test-"));
  const store = new CodexTranscriptStore(root);
  try {
    await run(store);
  } finally {
    await store.dispose();
    await fs.rm(root, { force: true, recursive: true });
  }
}

test("native steer admissions are thread-global and sequence ordered", async () => withStore(async (store) => {
  await store.recordClientRequest(request(9, "native-z", "turn-a"));
  await store.recordClientRequest(request(10, "native-a", "turn-b"));
  const entries = await store.listSteerHistory("thread");
  assert.deepEqual(entries.map((entry) => [entry.clientUserMessageId, entry.dispatchSequence, entry.requestId]), [
    ["native-z", 0, "9"],
    ["native-a", 1, "10"],
  ]);
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

test("a duplicate native id from another upstream request cannot mutate the first", async () => withStore(async (store) => {
  await store.recordClientRequest(request(1, "native"));
  await store.recordClientRequest(request(2, "native"));
  await store.recordClientRequestFailure(request(2, "native"), "wrong request failed");
  const entries = await store.listSteerHistory("thread");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.requestId, "1");
  assert.equal(entries[0]?.status, "pending");
}));

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
