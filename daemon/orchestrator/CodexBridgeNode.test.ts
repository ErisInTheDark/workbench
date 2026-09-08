/*
 * Keywords: Codex, startup, reload, transcript recovery, cancellation.
 * No production exports. Tests exercise recovery through the real bridge node lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import CodexBridgeNode from "./CodexBridgeNode";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { JsonRpcRequest } from "./bridge-types";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["initial", "replacement"] as const) {
  test(`${mode} bridge recovery runs without holding readiness and cancels on retirement`, async () => {
    const entered = deferred();
    const release = deferred();
    const failures: object[] = [];
    let bridge!: CodexStdioBridge;
    let cancelled = false;
    let available = 0;
    const parent = {
      appServer: {
        send(request: JsonRpcRequest) {
          if (request.method === "initialize") {
            queueMicrotask(() => void bridge.handleUpstreamMessage({ id: request.id, result: {} }));
          }
        },
      },
      attachBridge(value: CodexStdioBridge) { bridge = value; },
      detachBridge: async () => bridge.detachForReload(),
    };
    const registrations = {
      codexAppServer: parent,
      codexMcpGeneration: { bump() {} },
      codexHealth: { start() {} },
      harnesses: { recoverAvailable: async () => { available++; } },
      transcript: { pendingRecoveryThreadIds: ["thread"], cutoverFailure: null },
      transcriptShadowLog: { write(entry: object) { failures.push(entry); } },
    } as unknown as OrchestratorRuntimeObjects;
    const instance = CodexBridgeNode.create({
      createCodexBridgeOptions: () => ({
        appServer: parent.appServer, bridgeUrl: "ws://127.0.0.1:1",
        handleWorkbenchRequest: async () => { throw new Error("unexpected Workbench request"); },
        onNotification() {}, sendToClient() {}, resolveProjectFromCwd: async () => null,
        storageRoot: ".",
      }),
      onCodexBridgeReady: async () => {},
      onCodexBridgeUnavailable() {},
    } as unknown as OrchestratorProcessContext, {
      get: (key) => registrations[key],
      handoffState: undefined, isReplacing: () => false,
      lease: { isCurrent: () => true }, mode,
    });
    bridge.recoverSqliteTranscriptThread = async (_id, signal?: AbortSignal) => {
      entered.resolve();
      signal?.addEventListener("abort", () => { cancelled = true; release.resolve(); }, { once: true });
      await release.promise;
      signal?.throwIfAborted();
    };
    let activation: Promise<void> | undefined;
    try {
      await instance.start();
      if (mode === "initial") {
        await bridge.ensureInitialized({ method: "initialize", params: {} });
      } else {
        let activated = false;
        activation = Promise.resolve(instance.activate?.()).then(() => { activated = true; });
        await entered.promise;
        await Promise.resolve();
        assert.equal(activated, true, "provider recovery must not keep reload activation pending");
      }
      assert.equal(available, mode === "initial" ? 0 : 1, "initialisation must not duplicate process-owned turn recovery");
      await entered.promise;
      const retirement = instance.detachForReload!({ isReplacing: () => false });
      await Promise.resolve();
      assert.equal(cancelled, true, "retirement must cancel recovery before draining the bridge");
      await retirement;
      assert.deepEqual(failures, [], "owned cancellation is not a recording failure");
    } finally {
      release.resolve();
      await activation;
      await instance.dispose();
      await bridge.disposeImmediately();
    }
  });
}
