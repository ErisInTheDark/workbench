/*
 * Exports:
 * - No production exports; Node tests cover selected Codex message admission ordering and lifecycle races. Keywords: codex, message, admission, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodexJsonRpcResponse } from "../../codex/protocol.ts";
import type { ThreadPayload } from "../../types.ts";
import ThreadDocumentStore from "../state/ThreadDocumentStore.ts";
import ThreadSourceStore from "../state/ThreadSourceStore.ts";
import ThreadOptimisticInputStore from "./ThreadOptimisticInputStore.ts";
import ThreadMessageAdmissionController, { type ThreadMessageAdmissionLifecycleState } from "./ThreadMessageAdmissionController.ts";
import { ThreadMessageNotSentError } from "./thread-message-submission.ts";

function thread(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness: "codex", id: "thread", isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "active", tokenUsage: null, turnHistory: [],
    turns: [{ completedAt: null, durationMs: null, error: null, id: "turn", items: [], itemsView: "full", startedAt: 1, status: "inProgress" }], updatedAt: 1,
  };
}

function setup(
  sendRequest: <TResponse>(message: { method: string; params?: unknown } & Record<string, unknown>) => Promise<CodexJsonRpcResponse<TResponse>>,
  options: {
    connect?: () => Promise<void>;
    createClientUserMessageId?: () => string;
    renderSource?: (key: string) => void;
    resumedThread?: ThreadPayload;
  } = {},
) {
  const documents = ThreadDocumentStore();
  const sources = ThreadSourceStore();
  const optimisticInputs = ThreadOptimisticInputStore({ createClientUserMessageId: options.createClientUserMessageId ?? (() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") });
  const source = thread();
  sources.install(source);
  documents.upsertDocument(source, { select: true });
  const lifecycle: ThreadMessageAdmissionLifecycleState = {
    disposed: false, messageAdmissionIntentRevision: 1, projectContextGeneration: 1, projectId: "project", projectRootPath: "C:/repo",
  };
  const events: string[] = [];
  const controller = ThreadMessageAdmissionController({
    client: { connect: options.connect ?? (async () => { events.push("connect"); }), sendRequest },
    documents,
    emitWarning: (message) => events.push(`warning:${message}`),
    getLifecycleState: () => ({ ...lifecycle }),
    getThreadStatus: (value) => value.status,
    optimisticInputs,
    publishAccepted: ({ turnId }) => events.push(`accepted:${turnId}`),
    renderSource: options.renderSource ?? (() => events.push("render")),
    sources,
  });
  const admit = (input: Parameters<typeof controller.admit>[1]) => controller.admit("thread", input, {
    mergeAndInstallResumedThread: (resumedThread) => {
      sources.install(resumedThread);
      return resumedThread;
    },
    projectStartedTurn: ({ clientUserMessageId, input: startedInput, turn }) => {
      const current = sources.get("codex:thread");
      if (!current) return;
      const started = { ...current, status: "active", turns: [...current.turns, turn] };
      sources.install(started);
      optimisticInputs.enqueueInitial(started, turn.id, startedInput, { clientUserMessageId, status: "sent" });
    },
    resumeRequest: { method: "thread/resume", params: { threadId: "thread" } },
    startRequest: { method: "turn/start", params: {} },
    toResumedThread: () => options.resumedThread ?? { ...thread(), status: "idle", turns: [] },
  });
  return { admit, controller, documents, events, lifecycle, optimisticInputs, sources };
}

test("admission connects, enqueues, sends exact native identity, and settles pending", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const setupResult = setup(async <TResponse>(message: { method: string; params?: unknown }) => {
    requests.push(message);
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  const result = await setupResult.admit([{ text: "one", text_elements: [], type: "text" }]);
  assert.deepEqual(result, { handle: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "admitted" });
  assert.deepEqual(requests.map((request) => request.method), ["turn/steer"]);
  assert.deepEqual(requests[0]?.params, {
    clientUserMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedTurnId: "turn",
    input: [{ text: "one", text_elements: [], type: "text" }], threadId: "thread",
  });
  assert.deepEqual(setupResult.events, ["connect", "render"]);
});

test("active waiting source admits an ordinary steer", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const result = setup(async <TResponse>(message) => {
    requests.push(message);
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "active:waitingOnUserInput" }));

  assert.equal((await result.admit([{ text: "queued", text_elements: [], type: "text" }])).kind, "admitted");
  assert.deepEqual(requests.map(({ method }) => method), ["turn/steer"]);
  assert.equal((requests[0]?.params as { expectedTurnId?: string }).expectedTurnId, "turn");
});

test("idle thread resumes once and starts one turn with native identity", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const result = setup(async <TResponse>(message) => {
    requests.push(message);
    if (message.method === "thread/resume") {
      return { id: 1, result: { thread: {} } } as CodexJsonRpcResponse<TResponse>;
    }
    return {
      id: 2,
      result: { turn: { ...thread().turns[0]!, id: "new-turn" } },
    } as CodexJsonRpcResponse<TResponse>;
  });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle" }));

  const admission = await result.admit([{ text: "new turn", text_elements: [], type: "text" }]);
  assert.equal(admission.kind, "turnStarted");
  assert.deepEqual(requests.map(({ method }) => method), ["thread/resume", "turn/start"]);
  assert.equal((requests[1]?.params as { clientUserMessageId?: string }).clientUserMessageId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(result.events.at(-1), "accepted:new-turn");
});

test("idle source churn during resume cannot steer a stale in-progress turn", async () => {
  const requests: Array<{ method: string; params?: unknown }> = [];
  let result: ReturnType<typeof setup>;
  result = setup(async <TResponse>(message) => {
    requests.push(message);
    if (message.method === "thread/resume") {
      result.sources.update("codex:thread", (source) => ({ ...source, updatedAt: source.updatedAt + 1 }));
      return { id: 1, result: { thread: {} } } as CodexJsonRpcResponse<TResponse>;
    }
    return { id: 2, result: { turn: { ...thread().turns[0]!, id: "new-turn" } } } as CodexJsonRpcResponse<TResponse>;
  });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle" }));

  assert.equal((await result.admit([{ text: "new turn", text_elements: [], type: "text" }])).kind, "turnStarted");
  assert.deepEqual(requests.map(({ method }) => method), ["thread/resume", "turn/start"]);
});

test("waiting resume candidate steers its in-progress turn", async () => {
  const requests: string[] = [];
  const waiting = { ...thread(), status: "active:waitingOnUserInput" };
  const result = setup(async <TResponse>(message) => {
    requests.push(message.method);
    return message.method === "thread/resume"
      ? { id: 1, result: { thread: {} } } as CodexJsonRpcResponse<TResponse>
      : { id: 2, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  }, { resumedThread: waiting });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle", turns: [] }));

  assert.equal((await result.admit([{ text: "queued", text_elements: [], type: "text" }])).kind, "admitted");
  assert.deepEqual(requests, ["thread/resume", "turn/steer"]);
});

test("active-to-idle drift during connect resumes and starts instead of cancelling", async () => {
  let release!: () => void;
  const connected = new Promise<void>((resolve) => { release = resolve; });
  const methods: string[] = [];
  const result = setup(async <TResponse>(message) => {
    methods.push(message.method);
    return message.method === "thread/resume"
      ? { id: 1, result: { thread: {} } } as CodexJsonRpcResponse<TResponse>
      : { id: 2, result: { turn: { ...thread().turns[0]!, id: "new-turn" } } } as CodexJsonRpcResponse<TResponse>;
  }, { connect: () => connected });
  const admission = result.admit([{ text: "new turn", text_elements: [], type: "text" }]);
  result.sources.update("codex:thread", (source) => ({
    ...source,
    status: "idle",
    turns: source.turns.map((turn) => ({ ...turn, status: "completed" })),
  }));
  release();
  assert.equal((await admission).kind, "turnStarted");
  assert.deepEqual(methods, ["thread/resume", "turn/start"]);
});

test("idle-to-active drift during connect steers the newest turn without resume", async () => {
  let release!: () => void;
  const connected = new Promise<void>((resolve) => { release = resolve; });
  const methods: string[] = [];
  const result = setup(async <TResponse>(message) => {
    methods.push(message.method);
    return { id: 1, result: { turnId: "new-active" } } as CodexJsonRpcResponse<TResponse>;
  }, { connect: () => connected });
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle", turns: [] }));
  const admission = result.admit([{ text: "join", text_elements: [], type: "text" }]);
  result.sources.update("codex:thread", (source) => ({
    ...source,
    status: "active",
    turns: [{ ...thread().turns[0]!, id: "new-active" }],
  }));
  release();
  assert.equal((await admission).kind, "admitted");
  assert.deepEqual(methods, ["turn/steer"]);
});

test("lifecycle drift during connect rejects before enqueue or steer", async () => {
  let calls = 0;
  const setupResult = setup(async <TResponse>() => {
    calls += 1;
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  const admission = setupResult.admit([{ text: "one", text_elements: [], type: "text" }]);
  setupResult.lifecycle.messageAdmissionIntentRevision += 1;
  await assert.rejects(admission);
  assert.equal(calls, 0);
  assert.deepEqual(setupResult.events, ["connect"]);
});

test("owner cancellation wins over connect and resume failures before dispatch", async () => {
  let connectResult: ReturnType<typeof setup>;
  connectResult = setup(async <TResponse>() => (
    { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>
  ), { connect: async () => {
    connectResult.lifecycle.messageAdmissionIntentRevision += 1;
    throw new Error("connect failed");
  } });
  await assert.rejects(
    connectResult.admit([{ text: "one", text_elements: [], type: "text" }]),
    ThreadMessageNotSentError,
  );

  for (const resumeResult of ["transport", "malformed"] as const) {
    let result: ReturnType<typeof setup>;
    result = setup(async <TResponse>(message) => {
      if (message.method === "thread/resume") {
        result.lifecycle.messageAdmissionIntentRevision += 1;
        if (resumeResult === "transport") {
          throw new Error("resume failed");
        }
        return { id: 1, result: {} } as CodexJsonRpcResponse<TResponse>;
      }
      return { id: 2, result: { turn: thread().turns[0] } } as CodexJsonRpcResponse<TResponse>;
    });
    result.sources.update("codex:thread", (source) => ({ ...source, status: "idle", turns: [] }));
    await assert.rejects(
      result.admit([{ text: "one", text_elements: [], type: "text" }]),
      ThreadMessageNotSentError,
    );
  }

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
  const result = await setupResult.admit([{ text: "one", text_elements: [], type: "text" }]);
  assert.equal(result.kind, "admitted");
});

test("valid steer acknowledgement after project reset remains admitted", async () => {
  let result: ReturnType<typeof setup>;
  result = setup(async <TResponse>() => {
    result.lifecycle.projectContextGeneration += 1;
    result.documents.clear();
    result.sources.clear();
    result.optimisticInputs.clear();
    return { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>;
  });

  assert.equal((await result.admit([{ text: "one", text_elements: [], type: "text" }])).kind, "admitted");
});

test("malformed turn start acknowledgement fails with the controlled boundary error", async () => {
  const result = setup(async <TResponse>(message) => (
    message.method === "thread/resume"
      ? { id: 1, result: { thread: {} } } as CodexJsonRpcResponse<TResponse>
      : { id: 2, result: { turn: {} } } as CodexJsonRpcResponse<TResponse>
  ));
  result.sources.update("codex:thread", (source) => ({ ...source, status: "idle", turns: [] }));

  await assert.rejects(
    result.admit([{ text: "new turn", text_elements: [], type: "text" }]),
    /turn\/start returned an empty turn id/u,
  );
});

test("interruption before acknowledgement rejects instead of masquerading as delivery", async () => {
  let result: ReturnType<typeof setup>;
  result = setup(async <TResponse>(message) => {
    const handle = (message.params as { clientUserMessageId: string }).clientUserMessageId;
    result.optimisticInputs.transition(handle, "interrupted");
    return { id: 1, result: { turnId: "different-turn" } } as CodexJsonRpcResponse<TResponse>;
  });
  await assert.rejects(
    result.admit([{ text: "one", text_elements: [], type: "text" }]),
    /stopped before this steer was delivered/u,
  );
});

test("malformed successful acknowledgement fails the exact optimistic entry", async () => {
  const setupResult = setup(async <TResponse>() => (
    { id: 1, result: {} } as CodexJsonRpcResponse<TResponse>
  ));
  await assert.rejects(
    setupResult.admit([{ text: "one", text_elements: [], type: "text" }]),
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
    (result) => { result.lifecycle.messageAdmissionIntentRevision += 1; },
    (result) => { result.documents.selectDocumentKey(""); },
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
    const admission = result.admit([{ text: "one", text_elements: [], type: "text" }]);
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
    await result.admit([{ text: "one", text_elements: [], type: "text" }]),
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
  assert.equal((await delivered.admit([{ text: "one", text_elements: [], type: "text" }])).kind, "admitted");
});

test("projection failure warns without reclassifying admission", async () => {
  const warnings: string[] = [];
  const result = setup(async <TResponse>() => (
    { id: 1, result: { turnId: "turn" } } as CodexJsonRpcResponse<TResponse>
  ), { renderSource: () => { throw new Error("render failed"); } });
  result.events.splice(0);
  const admission = await result.admit([{ text: "one", text_elements: [], type: "text" }]);
  warnings.push(...result.events.filter((event) => event.startsWith("warning:")));
  assert.equal(admission.kind, "admitted");
  assert.equal(warnings.length, 1);
});

test("two overlapping acknowledgements can settle in reverse order without losing either entry", async () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const resolvers: Array<(value: CodexJsonRpcResponse<unknown>) => void> = [];
  const result = setup(<TResponse>() => new Promise<CodexJsonRpcResponse<TResponse>>((resolve) => {
    resolvers.push(resolve as (value: CodexJsonRpcResponse<unknown>) => void);
  }), { createClientUserMessageId: () => ids.shift()! });
  const first = result.admit([{ text: "same", text_elements: [], type: "text" }]);
  const second = result.admit([{ text: "same", text_elements: [], type: "text" }]);
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
  const admission = result.admit([{ text: "one", text_elements: [], type: "text" }]);
  await Promise.resolve();
  result.optimisticInputs.confirmCanonicalUserMessage("codex:thread", "turn", {
    clientId: requestedHandle, content: [{ text: "one", text_elements: [], type: "text" }], id: "canonical", type: "userMessage",
  });
  const marker = await Promise.race([admission.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5))]);
  assert.equal(marker, "pending");
});
