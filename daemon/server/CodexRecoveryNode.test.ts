/* No production exports. Protect native recovery handoff through the real graph host. */
import assert from "node:assert/strict";
import test from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "../../shared/reload/ReloadableNode";
import ReloadableNodeHost from "../../shared/reload/ReloadableNodeHost";
import CodexRecoveryNode from "./CodexRecoveryNode";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { JsonRpcRequest } from "./bridge-types";

test("queued native recovery survives replacement as captured context, never as a retired callback", async () => {
  const queued: Array<() => Promise<void>> = [];
  const coordinator = new WorkbenchTurnRecoveryController(
    message => assert.fail(message),
    async (_label, task) => new Promise<void>((resolve, reject) => {
      queued.push(async () => { try { await task(); resolve(); } catch (error) { reject(error); } });
    }),
  );
  const requests: JsonRpcRequest[] = [];
  const context = {
    logTurnRecovery: (message: string) => assert.fail(message),
    reportTurnRecoveryFailure: async () => assert.fail("unexpected recovery failure"),
    harnessPorts: { codex: { request: async (request: JsonRpcRequest) => {
      requests.push(request);
      return { id: request.id, result: request.method === "thread/read"
        ? { thread: { turns: [{ id: "native-turn", items: [], status: "interrupted" }] } }
        : { kind: "started" } };
    } } },
  } as unknown as DaemonProcessContext;
  const native = new ReloadableNode({ ...CodexRecoveryNode, children: [] });
  const graph = () => defineReloadableNodeGraph([
    new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
      access: "agent", children: [native], description: "Shared recovery dependencies", lifecycle: "atomic",
      provides: ["turnRecovery", "threadIdentity"], requires: [], safeAll: true,
      scope: "server:test-recovery-parent", sources: "",
      create: () => ({
        registrations: {
          turnRecovery: coordinator,
          threadIdentity: { resolve: async () => ({
            threadId: "wb-thread", bindings: [{ harness: "codex", nativeThreadId: "native-thread" }],
          }) } as unknown as DaemonRuntimeObjects["threadIdentity"],
        },
        start() {}, dispose() {},
      }),
    }),
  ]);
  const host = new ReloadableNodeHost(context, { load: graph, reload: graph }, { topologyScope: "server:test-recovery-parent" });
  await host.start();
  try {
    await host.run("codexRecovery", async owner => {
      owner.observeRequest("codex", { id: "original", method: "turn/start", params: { threadId: "native-thread", cwd: "C:/repo", input: [] } });
      owner.observeNotification("codex", { method: "turn/started", params: { threadId: "native-thread", turn: { id: "native-turn" } } });
      await owner.refresh(WorkbenchThreadIdSchema.parse("wb-thread"));
    });
    assert.equal(queued.length, 1);
    await host.reload(["server:codex/recovery"]);
    await queued.shift()!();
    assert.deepEqual(requests, []);
    await host.run("codexRecovery", owner => owner.refresh(WorkbenchThreadIdSchema.parse("wb-thread")));
    await queued.shift()!();
    await coordinator.waitForIdle();
    assert.deepEqual(requests.map(request => request.method), ["thread/read", "workbench/codex/message/admit"]);
    assert.equal((requests[1].params as { threadId: string }).threadId, "native-thread");
  } finally {
    coordinator.expireRuntimeDrain();
    await host.dispose();
  }
});
