/*
 * No production exports. Tests protect cold provider dispatch, identity mapping, and questionnaire waiter liveness.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CodexThreadOperations from "./CodexThreadOperations";
import CodexStdioBridge from "./CodexStdioBridge";
import type CodexAppServer from "./CodexAppServer";
import type { JsonRpcRequest } from "./bridge-types";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import { NativeThreadIdSchema, NativeTurnIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { readWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";

async function threadFixture(handle: (request: JsonRpcRequest) => Promise<object>, options: {
  nativeQuestionnaireRequestKey?: string;
  workbenchQuestionnaireRequestKey?: string;
} = {}) {
  const database = createThreadStateTestDatabase();
  database.admitThread(testProjectIds.project, "wb-thread", "codex", "native-thread", "C:/project");
  const thread = await database.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse("wb-thread") });
  assert.ok(thread);
  const native = {
    harness: "codex", nativeLocation: "C:/project", nativeThreadId: NativeThreadIdSchema.parse("native-thread"),
    nativeTurnId: NativeTurnIdSchema.parse("native-turn"),
  };
  await database.identities.threads.observeTurns([{
    kind: "turn", threadId: thread.threadId, turnId: native.nativeTurnId, nativeTurnId: native.nativeTurnId,
    nativeThreadId: native.nativeThreadId, nativeLocation: native.nativeLocation, harnessId: native.harness,
    state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  }]);
  const turnId = database.identities.threads.workbenchTurnIdForNative(native);
  const bridge = {
    ensureInitialized: async () => {},
    handleServerRequest: async (request: JsonRpcRequest) => ({ id: request.id ?? null, result: await handle(request) }),
    canDeliverQuestionnaire: (requestedThreadId: string, requestKey: string) => (
      requestedThreadId === native.nativeThreadId
      && requestKey === options.nativeQuestionnaireRequestKey
    ),
  };
  const operations = new CodexThreadOperations({
    identities: database.identities,
    resolveProject: async () => ({ id: thread.projectId, rootPath: "C:/project" }),
    bridge,
    questionnaires: {
      canDeliver: (_threadId, requestKey) => requestKey === options.workbenchQuestionnaireRequestKey,
      deliver: async () => null,
      interruptRetainingQuestionnaire: async () => false,
    },
  });
  return { operations, threadId: thread.threadId, turnId };
}

for (const fails of [false, true]) {
  test(`provider deletion translates only its owned thread and ${fails ? "propagates failure" : "settles"}`, async () => {
    const requests: JsonRpcRequest[] = [];
    const fixture = await threadFixture(async request => {
      requests.push(request);
      if (fails) throw new Error("deletion failed");
      return {};
    });
    const deletion = fixture.operations.delete(fixture.threadId);
    if (fails) await assert.rejects(deletion, /deletion failed/);
    else await deletion;
    assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
      { method: "thread/delete", params: { threadId: "native-thread" } },
    ]);
  });
}

for (const fails of [false, true]) {
  test(`Codex interruption awaits goal clearing and ${fails ? "retains its failure" : "translates WB identities"}`, async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const requests: JsonRpcRequest[] = [];
    const fixture = await threadFixture(async request => {
      requests.push(request);
      if (request.method === "thread/goal/clear") {
        entered.resolve();
        await gate.promise;
        if (fails) throw new Error("goal clear failed");
      }
      return {};
    });
    const stopping = fixture.operations.interrupt(fixture.threadId, fixture.turnId);
    await entered.promise;
    assert.deepEqual(requests.map(request => request.method), ["thread/goal/clear"]);
    gate.resolve();
    if (fails) {
      await assert.rejects(stopping, /goal clear failed/);
      assert.equal(requests.length, 1);
    } else {
      await stopping;
      assert.deepEqual(requests.map(request => request.method), ["thread/goal/clear", "turn/interrupt"]);
      assert.deepEqual(requests[1].params, { threadId: "native-thread", turnId: "native-turn" });
    }
  });
}

test("subagent interruption preserves its goal policy while translating identities", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => { requests.push(request); return {}; });
  await fixture.operations.interrupt(fixture.threadId, fixture.turnId, { preserveGoal: true });
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: "turn/interrupt", params: { threadId: "native-thread", turnId: "native-turn" } },
  ]);
});

test("Browse screenshots stay passive and records retain native storage references", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => {
    requests.push(request);
    return request.method === "workbench/thread/inject-tool-context"
      ? { acceptedAt: 123, itemId: "image-item", turnId: "native-turn" }
      : { ok: true };
  });
  const imageUrl = "data:image/png;base64,AA==";
  assert.deepEqual(await fixture.operations.browse.screenshot({
    threadId: fixture.threadId, turnId: fixture.turnId, imageUrl,
  }), { kind: "injected", acceptedAt: 123, turnId: fixture.turnId });
  const injection = requests[0];
  assert.equal(injection.method, "workbench/thread/inject-tool-context");
  const params = injection.params as {
    threadId: string; expectedTurnId: string; toolOutput: { output: { type: string; image_url?: string }[] };
  };
  assert.equal(params.threadId, "native-thread");
  assert.equal(params.expectedTurnId, "native-turn");
  assert.ok(params.toolOutput.output.some(part => part.type === "input_image" && part.image_url === imageUrl));
  const entry = {
    threadId: fixture.threadId, turnId: fixture.turnId, entryKey: "browse-entry", commandItemId: null,
    action: "snapshot", actionIndex: 0, assetUrl: "/retained-asset", detailKind: "result" as const,
    detailLabel: null, detailText: "snapshot", durationMs: 1, recordedAt: 123, session: "research", state: "completed" as const,
  };
  await fixture.operations.browse.record(entry);
  assert.deepEqual(requests.map(request => request.method), [
    "workbench/thread/inject-tool-context", "browse/result/record",
  ]);
  assert.deepEqual(requests[1].params, { ...entry, threadId: "native-thread", turnId: "native-turn" });
});

test("agent messages retain tool authority and WB attribution at the native admission edge", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => { requests.push(request); return {}; });
  const message = { message: "continue the review", senderName: "iris", senderThreadId: "wb-parent" };
  await fixture.operations.messageAgent({
    threadId: fixture.threadId, cwd: "C:/project", message,
    context: { subagentName: "lily", workflowIds: ["subagent"] },
  });
  const request = requests[0];
  assert.equal(request.method, "turn/start");
  const params = request.params as { threadId: string; input: object[]; toolOutput: { namespace: string; name: string; output: string } };
  assert.equal(params.threadId, "native-thread");
  assert.deepEqual(params.input, []);
  assert.equal(params.toolOutput.namespace, "workbench");
  assert.equal(params.toolOutput.name, "agent_message");
  assert.deepEqual(readWorkbenchAgentMessageText(params.toolOutput.output), message);
  assert.equal((request.workbenchPromptContext as { threadId: string }).threadId, fixture.threadId);
});

test("latest content reads stay bounded and metadata polls remain item-free", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => {
    requests.push(request);
    return { thread: {
      id: request.method === "thread/context/read" ? fixture.threadId : "native-thread", cwd: "C:/project", name: "thread", preview: "", source: "appServer",
      status: { type: "idle" }, createdAt: 1, updatedAt: 2, turns: [], parentThreadId: null,
    } };
  });
  await fixture.operations.read(fixture.threadId, { background: true });
  assert.equal((await fixture.operations.readLatest(fixture.threadId)).id, fixture.threadId);
  assert.equal(requests[0].workbenchRequestSource, "autoRefresh");
  assert.deepEqual(requests[0].params, { threadId: "native-thread", includeTurns: false });
  assert.equal(requests[1].method, "thread/context/read");
  assert.deepEqual(requests[1].params, { threadId: "native-thread", includeTurns: false });
  assert.deepEqual(requests[1].workbenchThreadHydration, { mode: "latest" });
});

test("materialisation sends native identifiers while compaction never starts a turn", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => { requests.push(request); return {}; });
  await fixture.operations.materialize(fixture.threadId, [fixture.turnId]);
  await fixture.operations.compact(fixture.threadId);
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: "workbench/transcript/materialize", params: { threadId: "native-thread", turnIds: ["native-turn"] } },
    { method: "thread/compact/start", params: { threadId: "native-thread" } },
  ]);
});

test("cancelled materialisation does not dispatch provider history work", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => { requests.push(request); return {}; });
  const cancellation = new AbortController();
  cancellation.abort(new Error("subscription replaced"));
  await assert.rejects(
    fixture.operations.materialize(fixture.threadId, [fixture.turnId], cancellation.signal),
    /subscription replaced/,
  );
  assert.deepEqual(requests, []);
});

test("recall materialises catalogue or exact native turn without dispatch after cancellation", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => { requests.push(request); return {}; });
  const cancellation = new AbortController();
  await fixture.operations.history.materialize(fixture.threadId, null, cancellation.signal);
  await fixture.operations.history.materialize(fixture.threadId, fixture.turnId, cancellation.signal);
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: "workbench/thread-recall/materialize", params: { threadId: "native-thread", turnId: null } },
    { method: "workbench/thread-recall/materialize", params: { threadId: "native-thread", turnId: "native-turn" } },
  ]);
  cancellation.abort(new Error("recall cancelled"));
  await assert.rejects(fixture.operations.history.materialize(fixture.threadId, fixture.turnId, cancellation.signal), /recall cancelled/);
  assert.equal(requests.length, 2);
});

test("questionnaire delivery derives liveness from native and Workbench wait owners", async () => {
  for (const owner of ["native", "workbench", "none"] as const) {
    const fixture = await threadFixture(async () => ({}), {
      ...(owner === "native" ? { nativeQuestionnaireRequestKey: "question" } : {}),
      ...(owner === "workbench" ? { workbenchQuestionnaireRequestKey: "question" } : {}),
    });
    const deliverable = await fixture.operations.interactions.canDeliver(fixture.threadId, "question");
    assert.equal(deliverable, owner !== "none", `${owner} questionnaire ownership`);
  }
});

test("message intents preserve native identity, content and bounded resume through the admission owner", async () => {
  const requests: JsonRpcRequest[] = [];
  const fixture = await threadFixture(async request => {
    requests.push(request);
    return request.method === "turn/steer"
      ? { turnId: "native-turn" }
      : { kind: "steered", turnId: "native-turn" };
  });
  const input = [
    { type: "text" as const, text: "message", text_elements: [] },
    { type: "image" as const, url: "data:image/png;base64,AA==", detail: "original" as const },
    { type: "localImage" as const, path: "C:/project/image.png" },
  ];
  const context = { workflowIds: ["default"], activatedSkillPaths: ["C:/skills/review/SKILL.md"] };
  for (const intent of ["continue", "newTurn", "steer"] as const) {
    const result = await fixture.operations.submit({
      threadId: fixture.threadId, clientMessageId: "message", input, context, intent,
      ...(intent === "steer" ? { expectedTurnId: fixture.turnId } : {}),
    } as Parameters<CodexThreadOperations["submit"]>[0]);
    assert.deepEqual(result, { kind: "steered", turnId: fixture.turnId });
    const request = requests.at(-1)!;
    if (intent === "steer") {
      assert.equal(request.method, "turn/steer");
      assert.deepEqual(request.params, {
        threadId: "native-thread", expectedTurnId: "native-turn", clientUserMessageId: "message", input,
      });
    } else {
      assert.equal(request.method, "workbench/codex/message/admit");
      const params = request.params as {
        threadId: string; resumeRequest: JsonRpcRequest; startRequest: JsonRpcRequest; steerRequest?: JsonRpcRequest;
      };
      assert.equal(params.threadId, "native-thread");
      assert.deepEqual(params.resumeRequest.params, {
        threadId: "native-thread", excludeTurns: true,
        initialTurnsPage: { itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
      });
      assert.deepEqual(params.startRequest.params, {
        threadId: "native-thread", clientUserMessageId: "message", input, summary: "detailed",
      });
      assert.deepEqual(params.startRequest.workbenchPromptContext, { ...context, harness: "codex", threadId: fixture.threadId });
      assert.deepEqual(params.resumeRequest.workbenchPromptContext, params.startRequest.workbenchPromptContext);
      assert.equal(Boolean(params.steerRequest), intent === "continue");
    }
  }
});

for (const rejected of [false, true]) {
  test(`cold provider operations ${rejected ? "retain initialisation failure without dispatching work" : "share the bridge initialisation gate"}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-provider-cold-"));
    const methods: string[] = [];
    let finishInitialize!: () => void;
    let entered!: () => void;
    const initializing = new Promise<void>(resolve => { entered = resolve; });
    const bridge = new CodexStdioBridge({
      appServer: {
        send(request: JsonRpcRequest) {
          methods.push(request.method);
          if (request.method === "initialize") {
            finishInitialize = () => {
              void bridge.handleUpstreamMessage({
                id: request.id,
                ...(rejected ? { error: { code: -32000, message: "provider unavailable" } } : { result: {} }),
              });
            };
            entered();
          } else if (request.method === "model/list") {
            queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result: { data: [], nextCursor: null } }));
          }
        },
      } as unknown as CodexAppServer,
      resolveProjectFromCwd: async () => { throw new Error("Model reads must not resolve project ownership."); },
      handleWorkbenchRequest: async () => { throw new Error("Model reads must not enter Workbench thread admission."); },
      onNotification() {},
    });
    const operations = new CodexThreadOperations({
      bridge,
      identities: new Proxy({} as NativeTranscriptIdentityOwners, {
        get() { throw new Error("Model reads must not access thread identity."); },
      }),
      resolveProject: async () => { throw new Error("Model reads must not require a project."); },
    });
    try {
      const results = Promise.allSettled([
        operations.requestNative("model/list", {}),
        operations.requestNative("model/list", {}),
      ]);
      await initializing;
      assert.deepEqual(methods, ["initialize"]);
      finishInitialize();
      const settled = await results;
      if (rejected) {
        assert.ok(settled.every(result => result.status === "rejected" && /provider unavailable/.test(String(result.reason))));
        assert.deepEqual(methods, ["initialize"]);
      } else {
        assert.ok(settled.every(result => result.status === "fulfilled"));
        assert.deepEqual(methods, ["initialize", "initialized", "model/list", "model/list"]);
      }
    } finally {
      await bridge.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
