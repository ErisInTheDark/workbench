/*
 * No production exports. Protect the supervisor's lifetime across child replacement and failed replacement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";
import ReloadableNode, { defineReloadableNodeGraph } from "../../shared/reload/ReloadableNode";
import ReloadableNodeHost from "../../shared/reload/ReloadableNodeHost";
import CodexLifecycleNode from "./CodexLifecycleNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

for (const failFirst of [false, true]) {
  test(`supervision survives ${failFirst ? "failed and retried" : "successful"} child replacement`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    captureTestOutput(context, process.stdout, text => text.startsWith("[codex-recovery] Recovered Codex after:"));
    if (failFirst) {
      captureTestOutput(context, process.stderr, text => text.startsWith("[codex-recovery] Codex recovery attempt 1 failed: native launch failed;"));
    }
    let generation = 0;
    let attempts = 0;
    let shuttingDown = false;
    let replacementReady!: () => void;
    const ready = new Promise<void>(resolve => { replacementReady = resolve; });
    let firstAttemptDone!: () => void;
    const attempted = new Promise<void>(resolve => { firstAttemptDone = resolve; });
    type Node = ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>;
    const bridge: Node = new ReloadableNode({
      access: "agent", children: [], description: "Native readiness fixture", lifecycle: "atomic",
      provides: ["codexBridge"], requires: [], safeAll: true, scope: "server:codex", sources: "",
      create: () => ({
        registrations: {
          codexBridge: { ensureInitialized: async () => { replacementReady(); } } as unknown as DaemonRuntimeObjects["codexBridge"],
        },
        start() {}, dispose() {},
      }),
    });
    const harness: Node = new ReloadableNode({
      access: "cli", children: [bridge], description: "Native process fixture", lifecycle: "atomic",
      provides: [], requires: [], safeAll: false, scope: "harness:codex", sources: "",
      create: () => {
        generation++;
        if (failFirst && generation === 2) throw new Error("native launch failed");
        return { registrations: {}, start() {}, dispose() {} };
      },
    });
    const lifecycle: Node = new ReloadableNode({ ...CodexLifecycleNode, children: [harness, bridge] });
    const graph = () => defineReloadableNodeGraph([lifecycle]);
    let host!: ReloadableNodeHost<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>;
    const processContext = {
      isShuttingDown: () => shuttingDown,
      executeReloadScopes: async scopes => {
        attempts++;
        try { await host.reload(scopes); }
        finally { firstAttemptDone(); }
      },
    } as DaemonProcessContext;
    host = new ReloadableNodeHost(processContext, { load: graph, reload: graph }, { topologyScope: "server:codex/lifecycle" });
    await host.start();
    const owner = host.get("codexLifecycle");
    try {
      owner.requestRecovery("native process exited");
      await attempted;
      for (let index = 0; index < 8; index++) await Promise.resolve();
      if (failFirst) {
        assert.equal(attempts, 1);
        context.mock.timers.tick(4_000);
      }
      await ready;
      assert.equal(host.get("codexLifecycle"), owner);
      assert.equal(attempts, failFirst ? 2 : 1);
      assert.equal(generation, failFirst ? 3 : 2);
    } finally {
      shuttingDown = true;
      await host.dispose();
    }
    owner.requestRecovery("late exit from retired process");
    context.mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(attempts, failFirst ? 2 : 1);
  });
}
