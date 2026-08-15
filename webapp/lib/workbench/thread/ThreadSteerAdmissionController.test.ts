/*
 * Exports:
 * - No production exports; Node tests cover selected Codex steer admission ordering and lifecycle races. Keywords: codex, steer, admission, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodexJsonRpcResponse } from "../../codex/protocol.ts";
import type { ThreadPayload } from "../../types.ts";
import ThreadDocumentStore from "../state/ThreadDocumentStore.ts";
import ThreadSourceStore from "../state/ThreadSourceStore.ts";
import ThreadOptimisticInputStore from "./ThreadOptimisticInputStore.ts";
import ThreadSteerAdmissionController, { type ThreadSteerAdmissionLifecycleState } from "./ThreadSteerAdmissionController.ts";

function thread(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness: "codex", id: "thread", isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "active", tokenUsage: null, turnHistory: [], unreadBadge: null,
    turns: [{ completedAt: null, durationMs: null, error: null, id: "turn", items: [], itemsView: "full", startedAt: 1, status: "inProgress" }], updatedAt: 1,
  };
}

function setup(
  sendRequest: <TResponse>(message: { method: string; params?: unknown } & Record<string, unknown>) => Promise<CodexJsonRpcResponse<TResponse>>,
  options: {
    connect?: () => Promise<void>;
    createSteerId?: () => string;
    renderSource?: (key: string) => void;
  } = {},
) {
  const documents = ThreadDocumentStore();
  const sources = ThreadSourceStore();
  const optimisticInputs = ThreadOptimisticInputStore({ createSteerId: options.createSteerId ?? (() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") });
  const source = thread();
  sources.install(source);
  documents.upsertDocument(source, { select: true });
  const lifecycle: ThreadSteerAdmissionLifecycleState = {
    disposed: false, projectContextGeneration: 1, projectId: "project", projectRootPath: "C:/repo", steerAdmissionIntentRevision: 1,
  };
  const events: string[] = [];
  const controller = ThreadSteerAdmissionController({
    client: { connect: options.connect ?? (async () => { events.push("connect"); }), sendRequest },
    documents,
    emitWarning: (message) => events.push(`warning:${message}`),
    getLifecycleState: () => ({ ...lifecycle }),
    optimisticInputs,
    renderSource: options.renderSource ?? (() => events.push("render")),
    sources,
  });
  return { controller, documents, events, lifecycle, optimisticInputs, sources };
}

test("admission connects, enqueues, sends exact native identity, and settles pending", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const setupResult = setup(async <TResponse>(message: { method: string; params?: unknown }) => {
    requests.push(message);
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  const result = await setupResult.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
  assert.deepEqual(result, { handle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "admitted" });
  assert.deepEqual(requests.map((request) => request.method), ["turn/steer"]);
  assert.deepEqual(requests[0]?.params, {
    clientUserMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedTurnId: "turn",
    input: [{ text: "one", text_elements: [], type: "text" }], threadId: "thread",
  });
  assert.deepEqual(setupResult.events, ["connect", "render"]);
});

test("idle thread status rejects a stale in-progress turn before admission preparation", async () => {
  let calls = 0;
  const result = setup(async <TResponse>() => {
    calls += 1;
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle" }));

  await assert.rejects(
    result.controller.admit("thread", [{ text: "new turn", text_elements: [], type: "text" }]),
    /no longer ready to accept a steer/u,
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.events, []);
  assert.equal(result.optimisticInputs.apply(thread(), []).turns[0]?.items.length, 0);
});

test("lifecycle drift during connect rejects before enqueue or steer", async () => {
  let calls = 0;
  const setupResult = setup(async <TResponse>() => {
    calls += 1;
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  const admission = setupResult.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
  setupResult.lifecycle.steerAdmissionIntentRevision += 1;
  await assert.rejects(admission);
  assert.equal(calls, 0);
  assert.deepEqual(setupResult.events, ["connect"]);
});

test("canonical delivery before a delayed error remains admitted", async () => {
  let setupResult: ReturnType<typeof setup>;
  setupResult = setup(async <TResponse>(message) => {
    const params = message.params as { clientUserMessageId: string };
    setupResult.optimisticInputs.confirmCanonicalUserMessage("codex:thread", "canonical-turn", {
      clientId: params.clientUserMessageId,
      content: [{ text: "one", text_elements: [], type: "text" }],
      id: "canonical-item",
      type: "userMessage",
    });
    return { error: { code: -32000, message: "late failure" }, id: 1 } as CodexJsonRpcResponse<TResponse>;
  });
  const result = await setupResult.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
  assert.equal(result.kind, "admitted");
});

test("interruption before acknowledgement rejects instead of masquerading as delivery", async () => {
  let result: ReturnType<typeof setup>;
  result = setup(async <TResponse>(message) => {
    const handle = (message.params as { clientUserMessageId: string }).clientUserMessageId;
    result.optimisticInputs.transition(handle, "interrupted");
    return { id: 1, result: { turnId: "different-turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  await assert.rejects(
    result.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]),
    /stopped before this steer was delivered/u,
  );
});

test("malformed successful acknowledgement fails the exact optimistic entry", async () => {
  const setupResult = setup(async <TResponse>() => (
    { id: 1, result: {} } as CodexJsonRpcResponse<TResponse>
  ));
  await assert.rejects(
    setupResult.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]),
    /empty turn id/u,
  );
  const projected = setupResult.optimisticInputs.apply(thread(), []);
  assert.match(projected.turns[0]?.items[0]?.id ?? "", /:failed:/u);
});

test("every lifecycle and exact-selection drift rejects before dispatch", async () => {
  const mutations: Array<(result: ReturnType<typeof setup>) => void> = [
    (result) => { result.lifecycle.projectContextGeneration += 1; },
    (result) => { result.lifecycle.projectId = "other"; },
    (result) => { result.lifecycle.projectRootPath = "C:/other"; },
    (result) => { result.lifecycle.steerAdmissionIntentRevision += 1; },
    (result) => { result.documents.selectDocumentKey(""); },
    (result) => { result.sources.update("codex:thread", (value) => ({ ...value, turns: value.turns.map((turn) => ({ ...turn, status: "completed" })) })); },
    (result) => { result.lifecycle.disposed = true; },
  ];
  for (const mutate of mutations) {
    let release!: () => void;
    const connected = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const result = setup(async <TResponse>() => {
      calls += 1;
      return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
    }, { connect: () => connected });
    const admission = result.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
    mutate(result);
    release();
    await assert.rejects(admission);
    assert.equal(calls, 0);
  }
});

test("differing acknowledgement reconciles only a still-pending handle", async () => {
  const result = setup(async <TResponse>() => (
    { id: 1, result: { turnId: "other-turn" } } as CodexJsonRpcResponse<TResponse>
  ));
  assert.deepEqual(
    await result.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]),
    { acknowledgedTurnId: "other-turn", handle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "admittedNeedsReconciliation" },
  );
  assert.ok(result.events.some((event) => event.startsWith("warning:")));

  let delivered: ReturnType<typeof setup>;
  delivered = setup(async <TResponse>(message) => {
    const handle = (message.params as { clientUserMessageId: string }).clientUserMessageId;
    delivered.optimisticInputs.confirmCanonicalUserMessage("codex:thread", "canonical-turn", {
      clientId: handle, content: [{ text: "one", text_elements: [], type: "text" }], id: "canonical", type: "userMessage",
    });
    return { id: 1, result: { turnId: "other-turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  assert.equal((await delivered.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }])).kind, "admitted");
});

test("projection failure warns without reclassifying admission", async () => {
  const warnings: string[] = [];
  const result = setup(async <TResponse>() => (
    { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>
  ), { renderSource: () => { throw new Error("render failed"); } });
  result.events.splice(0);
  const admission = await result.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
  warnings.push(...result.events.filter((event) => event.startsWith("warning:")));
  assert.equal(admission.kind, "admitted");
  assert.equal(warnings.length, 1);
});

test("two overlapping acknowledgements can settle in reverse order without losing either entry", async () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const resolvers: Array<(value: CodexJsonRpcResponse<unknown>) => void> = [];
  const result = setup(<TResponse>() => new Promise<CodexJsonRpcResponse<TResponse>>((resolve) => {
    resolvers.push(resolve as (value: CodexJsonRpcResponse<unknown>) => void);
  }), { createSteerId: () => ids.shift()! });
  const first = result.controller.admit("thread", [{ text: "same", text_elements: [], type: "text" }]);
  const second = result.controller.admit("thread", [{ text: "same", text_elements: [], type: "text" }]);
  await Promise.resolve();
  resolvers[1]!({ id: 2, result: { turnId: "turn" } });
  resolvers[0]!({ id: 1, result: { turnId: "turn" } });
  await Promise.all([first, second]);
  assert.equal(result.optimisticInputs.apply(thread(), []).turns[0]?.items.length, 2);
});

test("an unresolved transport response does not settle from canonical projection alone", async () => {
  let requestedHandle = "";
  const result = setup(<TResponse>(message) => {
    requestedHandle = (message.params as { clientUserMessageId: string }).clientUserMessageId;
    return new Promise<CodexJsonRpcResponse<TResponse>>(() => {});
  });
  const admission = result.controller.admit("thread", [{ text: "one", text_elements: [], type: "text" }]);
  await Promise.resolve();
  result.optimisticInputs.confirmCanonicalUserMessage("codex:thread", "turn", {
    clientId: requestedHandle, content: [{ text: "one", text_elements: [], type: "text" }], id: "canonical", type: "userMessage",
  });
  const marker = await Promise.race([admission.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5))]);
  assert.equal(marker, "pending");
});
