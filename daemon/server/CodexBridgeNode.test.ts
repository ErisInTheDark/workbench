/*
 * No exports. Tests exercise saved history and recovery through the real bridge node lifecycle.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NativeThreadIdSchema, NativeTurnIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import CodexBridgeNode from "./CodexBridgeNode";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { JsonRpcRequest } from "./bridge-types";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexLifecycleController from "./CodexLifecycleController";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import WorkbenchTranscriptRepository from "./database/transcript/WorkbenchTranscriptRepository";
import WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("canonical history does not initialise the native bridge", async (t) => {
  const fixture = createThreadStateTestDatabase();
  fixture.admitThread(testProjectIds.project, "saved-thread", "codex", "native-thread", "C:/repo");
  const identity = await fixture.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse("saved-thread") });
  assert.ok(identity);
  const nativeTurnId = NativeTurnIdSchema.parse("native-turn");
  const turn = {
    kind: "turn" as const, threadId: identity.threadId, turnId: nativeTurnId, nativeTurnId,
    nativeThreadId: NativeThreadIdSchema.parse("native-thread"), nativeLocation: "C:/repo", harnessId: "codex",
    state: "completed" as const, createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
  };
  const admitted = await fixture.identities.threads.observeTurn(turn);
  const [item] = await fixture.identities.items.admit([{
    threadId: identity.threadId, sources: [{ turnId: admitted.turnId, kind: "stable", reference: "message" }],
  }]);
  const repository = new WorkbenchTranscriptRepository(fixture.sqlite);
  repository.settle([
    { ...turn, turnId: admitted.turnId },
    { kind: "item", threadId: identity.threadId, turnId: admitted.turnId, publicItemId: item!.itemId,
      observedAt: 2, lifecycle: "completed", item: {
        id: "message", type: "agentMessage", text: "saved reply", phase: "commentary", memoryCitation: null, delivery: null, questions: null,
      } },
  ]);
  const requests: JsonRpcRequest[] = [];
  const failures: object[] = [];
  t.mock.method(console, "error", (...args: object[]) => { failures.push(args); });
  t.mock.method(console, "warn", (...args: object[]) => { failures.push(args); });
  const parent = {
    appServer: {
      async retirePrevious() {},
      send(request: JsonRpcRequest) { requests.push(request); },
    },
    deactivateBridge() {},
  };
  const registrations = {
    transcriptReader: new WorkbenchTranscriptReader({
      readSnapshot: async request => repository.read(request),
      readContext: async id => repository.readContext(id),
      readMaterializedTurns: async (id, turns) => repository.readMaterializedTurnIds(id, turns),
      readContextUsage: async () => null,
      readMetadata: async () => ({ entry: null, harness: "codex" }),
    }),
    codexAppServer: parent, toolRevision: { revision: "catalogue" },
    threadIdentity: fixture.identities.threads, transcriptIdentity: fixture.identities.items,
    threadState: { controller: { getCanonicalThreadEntry: async () => null } },
    database: { readTranscriptContext: async (id: string) => repository.readContext(id), readThreadContextUsage: async () => null },
    transcript: {
      read: async (request: Parameters<typeof repository.read>[0]) => repository.read(request),
      readMaterializedTurnIds: async (id: string, turns: readonly string[]) => repository.readMaterializedTurnIds(id, turns),
    },
  } as unknown as DaemonRuntimeObjects;
  const instance = CodexBridgeNode.create({
    isShuttingDown: () => false,
    isHardReloadPending: () => false,
    broadcastProviderNotification() {},
  } as unknown as DaemonProcessContext, {
    get: key => registrations[key], run: () => { throw new Error("unexpected graph operation"); },
    getSourceState: () => { throw new Error("unexpected source read"); },
    handoffState: undefined, isReplacing: () => false, lease: { isCurrent: () => true }, mode: "initial",
  });
  try {
    const page = await registrations.transcriptReader.readPage({ threadId: identity.threadId, cursor: null });
    assert.equal(page.thread.turns[0]?.items[0]?.type, "agentMessage");
    const message = page.thread.turns[0]?.items[0];
    assert.equal(message?.type === "agentMessage" && message.text, "saved reply");
    await registrations.transcriptReader.readPage({ threadId: identity.threadId, cursor: null });
    assert.deepEqual(requests, []);
  } finally {
    await instance.dispose();
    await instance.registrations.codexBridge!.disposeImmediately();
  }
  assert.deepEqual(failures, []);
});

test("legacy Codex subagent messages use the reloadable message owner", async () => {
  const routed: string[] = [];
  const parent = {
    appServer: { send() {} },
    deactivateBridge() {},
  };
  const registrations = {
    codexAppServer: parent,
    messages: {
      send: async () => { routed.push("messages"); },
    },
    projectCatalog: {
      resolveAgentEndpointProjectFromCwd: async () => ({
        cwd: "C:/repo",
        project: { id: testProjectIds.project },
        root: { rootPath: "C:/repo" },
      }),
    },
    subagents: {
      handleRequest: async (request: JsonRpcRequest) => {
        routed.push("subagents");
        return { id: request.id ?? null, result: {} };
      },
    },
    toolRevision: { revision: "catalogue" },
  } as unknown as DaemonRuntimeObjects;
  const instance = CodexBridgeNode.create({
    isShuttingDown: () => false,
    isHardReloadPending: () => false,
    broadcastProviderNotification() {},
  } as unknown as DaemonProcessContext, {
    get: key => registrations[key],
    run: async (key, operation) => await operation(registrations[key]),
    getSourceState: () => { throw new Error("unexpected source read"); },
    handoffState: undefined, isReplacing: () => false, lease: { isCurrent: () => true }, mode: "initial",
  });
  const bridge = instance.registrations.codexBridge!;
  try {
    const message = await bridge.handleBridgeRequest({
      id: 1,
      method: "workbench/subagent/message",
      params: { callerThreadId: "reviewer", cwd: "C:/repo", message: "review feedback", threadId: "target" },
    });
    const list = await bridge.handleBridgeRequest({
      id: 2,
      method: "workbench/subagent/list",
      params: { callerThreadId: "reviewer", cwd: "C:/repo" },
    });
    assert.equal(message?.error, undefined);
    assert.equal(list?.error, undefined);
    assert.deepEqual(routed, ["messages", "subagents"]);
  } finally {
    await instance.dispose();
    await bridge.disposeImmediately();
  }
});

test("managed steering interrupts only the mapped WB thread wait before returning", async () => {
  const fixture = createThreadStateTestDatabase();
  fixture.admitThread(testProjectIds.project, "saved-thread", "codex", "native-thread", "C:/repo");
  const identity = await fixture.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse("saved-thread") });
  assert.ok(identity);
  const registry = getProcessWorkbenchAgentMcpRequestRegistry();
  const wait = registry.register(randomUUID(), 1, { owner: {}, steerInterruptible: true, toolName: "git_arc_wait" });
  const other = registry.register(randomUUID(), 1, { owner: {}, steerInterruptible: true, toolName: "git_arc_wait" });
  wait.setWorkbenchThreadId(identity.threadId);
  other.setWorkbenchThreadId(WorkbenchThreadIdSchema.parse(randomUUID()));
  let bridge!: CodexStdioBridge;
  const turn = { id: "native-turn", items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
  const thread = {
    id: "native-thread", cwd: "C:/repo", createdAt: 1, updatedAt: 1, name: null, preview: "",
    status: { type: "active", activeFlags: [] }, source: "appServer", turns: [],
  };
  const registrations = {
    codexAppServer: {
      appServer: { send(request: JsonRpcRequest) {
        const result = request.method === "thread/read" ? { thread }
          : request.method === "thread/turns/list" ? { data: [turn], nextCursor: null }
            : request.method === "turn/steer" ? { turnId: turn.id } : null;
        assert.ok(result, `Unexpected native operation: ${request.method}`);
        assert.equal(wait.signal.aborted, false);
        queueMicrotask(() => { void bridge.handleUpstreamMessage({ id: request.id ?? null, result }); });
      } },
      deactivateBridge() {},
    },
    codexInstructions: {
      augment: async (request: JsonRpcRequest) => request,
      createThreadResume: (params: object) => ({ method: "thread/resume", params }),
    },
    toolRevision: { revision: "catalogue" },
    threadIdentity: fixture.identities.threads, transcriptIdentity: fixture.identities.items,
    projectCatalog: { resolveAgentEndpointProjectFromCwd: async () => ({
      project: { id: identity.projectId }, root: { rootPath: "C:/repo" },
    }) },
    transcript: { record: async () => undefined, readMaterializedTurnIds: async () => [] },
  } as unknown as DaemonRuntimeObjects;
  const instance = CodexBridgeNode.create({
    isShuttingDown: () => false, isHardReloadPending: () => false, broadcastProviderNotification() {},
  } as unknown as DaemonProcessContext, {
    get: key => registrations[key], run: () => { throw new Error("Unexpected graph operation"); },
    getSourceState: () => { throw new Error("Unexpected source read"); },
    handoffState: undefined, isReplacing: () => false, lease: { isCurrent: () => true }, mode: "initial",
  });
  bridge = instance.registrations.codexBridge!;
  try {
    const response = await bridge.handleServerRequest({
      id: 7, method: "workbench/codex/message/admit", params: {
        threadId: "native-thread",
        resumeRequest: { method: "thread/resume", params: { threadId: "native-thread" } },
        startRequest: { method: "turn/start", params: {
          threadId: "native-thread", clientUserMessageId: randomUUID(),
          input: [{ type: "text", text: "continue", text_elements: [] }],
        } },
        steerRequest: { method: "turn/steer", params: {} },
      },
    });
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, { kind: "steered", turnId: turn.id });
    assert.equal(wait.signal.aborted, true);
    assert.equal(other.signal.aborted, false);
  } finally {
    wait.unregister();
    other.unregister();
    await instance.dispose();
    await bridge.disposeImmediately();
  }
});

for (const scenario of [
  { name: "initial", mode: "initial", replacesHarness: false, replacesDatabase: false },
  { name: "bridge replacement", mode: "replacement", replacesHarness: false, replacesDatabase: false },
  { name: "harness replacement", mode: "replacement", replacesHarness: true, replacesDatabase: false },
  { name: "database replacement", mode: "replacement", replacesHarness: false, replacesDatabase: true },
] as const) {
  test(`${scenario.name} only baselines active turns after database replacement and retires recovery`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const failures: object[] = [];
    t.mock.method(console, "error", (...args: object[]) => { failures.push(args); });
    let bridge!: CodexStdioBridge;
    let cancelled = false;
    let recoveryCalls = 0;
    let readinessChecks = 0;
    const parent = {
      appServer: {
        send(request: JsonRpcRequest) {
          if (request.method === "initialize") {
            queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result: {} }));
          }
        },
      },
      attachBridge(value: CodexStdioBridge) { bridge = value; },
      deactivateBridge() {},
      isAvailable: () => true,
      isTransitioning: () => false,
      async waitUntilReady() { readinessChecks++; },
      beginBridgeHandoff(value: CodexStdioBridge) {
        return {
          waitForIdle: () => value.waitForIdle(),
          expire: () => value.expireForReload(),
          detach: () => value.detachForReload(),
          resume: () => value.resumeAfterReloadFailure(),
          commit: () => value.retireAfterHandoff(),
        };
      },
      detachBridge: async () => bridge.detachForReload(),
    };
    const registrations = {
      codexAppServer: parent,
      toolRevision: { revision: "catalogue" },
      codexLifecycle: new CodexLifecycleController({
        isShuttingDown: () => false,
        log() {}, logError() {},
        recover: async () => { throw new Error("Unexpected process recovery"); },
      }),
      transcript: { pendingRecoveryThreadIds: Promise.resolve(["thread"]) },
      transcriptReconciliation: { reconcile: async (_input: object, signal?: AbortSignal) => {
        recoveryCalls++;
        entered.resolve();
        signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
        await release.promise;
        signal?.throwIfAborted();
        return { turnIds: [], exhausted: false };
      } },
    } as unknown as DaemonRuntimeObjects;
    const instance = CodexBridgeNode.create({
      isShuttingDown: () => false,
      isHardReloadPending: () => false,
      broadcastProviderNotification() {},
    } as unknown as DaemonProcessContext, {
      get: (key) => registrations[key],
      run: () => { throw new Error("Unexpected graph operation in node fixture"); },
      getSourceState: () => { throw new Error("Unexpected source access in node fixture"); },
      handoffState: undefined,
      isReplacing: (scope) => scope === "harness:codex" && scenario.replacesHarness
        || scope === "server:database" && scenario.replacesDatabase,
      lease: { isCurrent: () => true }, mode: scenario.mode,
    });
    bridge = instance.registrations.codexBridge!;
    t.mock.getter(bridge, "activeSqliteTranscriptThreadIds", () => ["active-thread"]);
    let activation: Promise<void> | undefined;
    try {
      await instance.start();
      await instance.activate?.();
      instance.afterCommit?.();
      if (scenario.mode === "initial") {
        await bridge.ensureInitialized({ method: "initialize", params: {} });
      } else if (scenario.replacesDatabase) {
        let activated = false;
        activation = Promise.resolve().then(() => { activated = true; });
        await entered.promise;
        await Promise.resolve();
        assert.equal(activated, true, "provider recovery must not keep reload activation pending");
      }
      if (scenario.replacesDatabase) await entered.promise;
      else await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(recoveryCalls, scenario.replacesDatabase ? 1 : 0);
      assert.equal(readinessChecks, 1, "every bridge generation waits on parent-owned process readiness");
      const handoff = instance.beginHandoff!({ isReplacing: () => false });
      handoff.expire();
      let detached = false;
      const retirement = Promise.resolve(handoff.detach()).then(value => { detached = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(cancelled, scenario.replacesDatabase, "retirement cancels only demanded active recovery");
      if (scenario.replacesDatabase) assert.equal(detached, false, "retirement must drain cancelled baseline work");
      release.resolve();
      await retirement;
      await handoff.commit();
      assert.deepEqual(failures, [], "owned cancellation is not a recording failure");
    } finally {
      release.resolve();
      await activation;
      registrations.codexLifecycle.dispose();
      await instance.dispose();
      await bridge.disposeImmediately();
    }
  });
}
