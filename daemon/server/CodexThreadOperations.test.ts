/*
 * No production exports. Tests protect cold provider dispatch, identity mapping, and questionnaire waiter liveness.
 */
import assert from "node:assert/strict";
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

async function threadFixture(handle: (request: JsonRpcRequest) => Promise<object>, options: {
  nativeQuestionnaireRequestKey?: string;
  workbenchQuestionnaireRequestKey?: string;
} = {}) {
  const database = createThreadStateTestDatabase();
  database.admitThread("local:///project", "wb-thread", "codex", "native-thread", "C:/project");
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
    resolveProject: async () => { throw new Error("Known thread operations must not rediscover the project"); },
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

test("WB pages retain configuration supplied on native thread metadata", async () => {
  const fixture = await threadFixture(async () => ({
    thread: {
      id: "native-thread", cwd: "C:/project", status: { type: "idle" }, source: "appServer",
      createdAt: 1, updatedAt: 2, turns: [], parentThreadId: null, model: "configured-model", reasoningEffort: "low",
    } as Thread,
    nextCursor: null, questionnaireEntries: [], steerEntries: [], browseResultEntries: [],
  }));
  const page = await fixture.operations.page({ threadId: fixture.threadId, cursor: null });
  assert.equal(page.thread.id, fixture.threadId);
  assert.equal(page.thread.model, "configured-model");
  assert.equal(page.thread.reasoningEffort, "low");
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
      bridgeUrl: "ws://127.0.0.1:1",
      resolveProjectFromCwd: async () => { throw new Error("Model reads must not resolve project ownership."); },
      handleWorkbenchRequest: async () => { throw new Error("Model reads must not enter Workbench thread admission."); },
      onNotification() {},
      sendToClient() { throw new Error("Server operations must not require a browser client."); },
      storageRoot: root,
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
