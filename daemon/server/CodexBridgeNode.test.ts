/*
 * No exports. Tests exercise accepted-steer mapping and recovery through the real bridge node lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeThreadIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import CodexBridgeNode from "./CodexBridgeNode";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("accepted Codex steers cancel the mapped Workbench thread wait before publishing the response", async () => {
  const nativeThreadId = NativeThreadIdSchema.parse("native-thread");
  const workbenchThreadId = WorkbenchThreadIdSchema.parse("workbench-thread");
  const registry = getProcessWorkbenchAgentMcpRequestRegistry();
  const wait = registry.register(`codex-bridge-${process.pid}-${Date.now()}`, 1, {
    owner: {},
    steerInterruptible: true,
    toolName: "git_arc_wait",
  });
  wait.setWorkbenchThreadId(workbenchThreadId);
  let bridge!: CodexStdioBridge;
  let upstreamRequest!: JsonRpcRequest;
  const responses: unknown[] = [];
  const parent = {
    appServer: {
      async retirePrevious() {},
      send(request: JsonRpcRequest) { upstreamRequest = request; },
    },
    attachBridge(value: CodexStdioBridge) { bridge = value; },
    deactivateBridge() {},
  };
  const registrations = {
    codexAppServer: parent,
    codexMcpGeneration: { bump() {} },
    harnesses: { recoverAvailable: async () => undefined },
    threadIdentity: {
      knownNativeBinding: (_harness: string, threadId: string) => {
        assert.equal(threadId, nativeThreadId);
        return { harness: "codex", nativeLocation: "C:/repo", nativeThreadId };
      },
      workbenchIdForNative: () => workbenchThreadId,
    },
    transcript: { cutoverFailure: null, pendingRecoveryThreadIds: [], record: async () => undefined },
  } as unknown as DaemonRuntimeObjects;
  const instance = CodexBridgeNode.create({
    createCodexBridgeOptions: () => ({
      appServer: parent.appServer,
      bridgeUrl: "ws://127.0.0.1:1",
      handleWorkbenchRequest: async () => { throw new Error("unexpected Workbench request"); },
      onNotification() {},
      resolveProjectFromCwd: async () => null,
      sendToClient(_client, response) {
        assert.equal(wait.signal.aborted, true);
        responses.push(response);
      },
      storageRoot: ".",
    }),
    onCodexBridgeReady: async () => undefined,
    onCodexBridgeUnavailable() {},
  } as unknown as DaemonProcessContext, {
    get: key => registrations[key],
    handoffState: undefined,
    isReplacing: () => false,
    lease: { isCurrent: () => true },
    mode: "initial",
  });
  bridge = instance.registrations.codexBridge!;
  const client = { OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {} } as BridgeClient;
  try {
    await bridge.forwardRequest({
      id: 7,
      method: "turn/steer",
      params: { threadId: nativeThreadId },
    }, client, 7);
    assert.equal(wait.signal.aborted, false);
    await bridge.handleUpstreamMessage({ id: upstreamRequest.id ?? null, result: { turnId: "native-turn" } });
    assert.equal(wait.signal.aborted, true);
    assert.deepEqual(responses, [{ id: 7, result: { turnId: "native-turn" } }]);
  } finally {
    wait.unregister();
    await instance.dispose();
    await bridge.disposeImmediately();
  }
});

for (const mode of ["initial", "replacement"] as const) {
  test(`${mode} bridge recovery runs without holding readiness and cancels on retirement`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const failures: object[] = [];
    t.mock.method(console, "error", (...args: object[]) => { failures.push(args); });
    let bridge!: CodexStdioBridge;
    let cancelled = false;
    let available = 0;
    const parent = {
      appServer: {
        async retirePrevious() {},
        send(request: JsonRpcRequest) {
          if (request.method === "initialize") {
            queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result: {} }));
          }
        },
      },
      attachBridge(value: CodexStdioBridge) { bridge = value; },
      deactivateBridge() {},
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
      codexMcpGeneration: { bump() {} },
      codexHealth: { start() {} },
      harnesses: { recoverAvailable: async () => { available++; } },
      transcript: { pendingRecoveryThreadIds: ["thread"], cutoverFailure: null },
    } as unknown as DaemonRuntimeObjects;
    const instance = CodexBridgeNode.create({
      createCodexBridgeOptions: () => ({
        appServer: parent.appServer, bridgeUrl: "ws://127.0.0.1:1",
        handleWorkbenchRequest: async () => { throw new Error("unexpected Workbench request"); },
        onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null,
        storageRoot: ".",
      }),
      onCodexBridgeReady: async () => {},
      onCodexBridgeUnavailable() {},
    } as unknown as DaemonProcessContext, {
      get: (key) => registrations[key],
      handoffState: undefined, isReplacing: () => false,
      lease: { isCurrent: () => true }, mode,
    });
    bridge = instance.registrations.codexBridge!;
    bridge.recoverSqliteTranscriptThread = async (_id, signal?: AbortSignal) => {
      entered.resolve();
      signal?.addEventListener("abort", () => { cancelled = true; release.resolve(); }, { once: true });
      await release.promise;
      signal?.throwIfAborted();
    };
    let activation: Promise<void> | undefined;
    try {
      await instance.start();
      await instance.activate?.();
      instance.afterCommit?.();
      if (mode === "initial") {
        await bridge.ensureInitialized({ method: "initialize", params: {} });
      } else {
        let activated = false;
        activation = Promise.resolve().then(() => { activated = true; });
        await entered.promise;
        await Promise.resolve();
        assert.equal(activated, true, "provider recovery must not keep reload activation pending");
      }
      assert.equal(available, mode === "initial" ? 0 : 1, "initialisation must not duplicate process-owned turn recovery");
      await entered.promise;
      const handoff = instance.beginHandoff!({ isReplacing: () => false });
      handoff.expire();
      const retirement = handoff.detach();
      await Promise.resolve();
      assert.equal(cancelled, true, "retirement must cancel recovery before draining the bridge");
      await retirement;
      await handoff.commit();
      assert.deepEqual(failures, [], "owned cancellation is not a recording failure");
    } finally {
      release.resolve();
      await activation;
      await instance.dispose();
      await bridge.disposeImmediately();
    }
  });
}
