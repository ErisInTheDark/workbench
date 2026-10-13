/* No exports. Tests protect restart intent across failed rollback and fresh service replacement. */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeServiceNode from "./OpenCodeServiceNode";
import OpenCodeServiceController from "./OpenCodeServiceController";
import ReloadableNode, { defineReloadableNodeGraph } from "workbench-shared/reload/ReloadableNode";
import ReloadableNodeHost from "workbench-shared/reload/ReloadableNodeHost";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";

test("failed detach still attempts rollback instead of reporting a suspended service as restored", async t => {
  let resumed = false;
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async () => { throw new Error("stop failed"); });
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async () => { resumed = true; return {} as never; });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async () => {});
  const instance = OpenCodeServiceNode.create({} as never, { handoffState: undefined } as never);
  const handoff = instance.beginHandoff!({ isReplacing: () => true });
  try {
    await assert.rejects(Promise.resolve().then(() => handoff.detach()), /stop failed/u);
    await handoff.resume();
    assert.equal(resumed, true);
  } finally { await instance.dispose(); }
});

test("the graph can replace the real OpenCode node while the retained service cannot restart", async t => {
  const active = new Set<OpenCodeServiceController>();
  let old: OpenCodeServiceController;
  let failCandidate = false;
  let failOld = false;
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async function () {
    return active.delete(this);
  });
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async function () {
    if ((this === old && failOld) || (this !== old && failCandidate)) throw new Error("service cannot start");
    active.add(this);
    return {} as never;
  });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async function () { active.delete(this); });
  const node = ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>();
  const graph = () => defineReloadableNodeGraph([
    node({ ...OpenCodeServiceNode, children: [] }),
    node({
      scope: "server:unrelated", provides: ["openCodeModelCatalog"], requires: [], children: [],
      access: "agent", lifecycle: "atomic", safeAll: true, description: "unrelated fixture",
      create: () => ({
        registrations: { openCodeModelCatalog: { read: async () => ({ models: [], defaultModel: null }) } },
        start() {}, dispose() {},
      }),
    }),
  ]);
  const host = new ReloadableNodeHost({} as DaemonProcessContext, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
  });
  await host.start();
  old = host.get("openCodeService");
  try {
    await old.acquire();
    failCandidate = failOld = true;
    await assert.rejects(host.reload(["harness:opencode", "server:unrelated"]));
    await host.run("openCodeModelCatalog", value => value.read());
    failCandidate = false;
    await host.reload(["harness:opencode"]);
    const fresh = host.get("openCodeService");
    assert.notEqual(fresh, old);
    assert.equal(active.has(fresh), true);
    assert.equal(active.has(old), false);
    await host.run("openCodeService", service => service.acquire());
  } finally { await host.dispose(); }
});

test("repair retains restart intent after the old service can no longer resume", async t => {
  let suspends = 0;
  let starts = 0;
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async () => ++suspends === 1);
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async () => {
    if (++starts === 1) throw new Error("old service cannot start");
    return {} as never;
  });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async () => {});
  const old = OpenCodeServiceNode.create({} as never, { handoffState: undefined } as never);
  const handoff = old.beginHandoff!({ isReplacing: () => true });
  try {
    await handoff.detach();
    await assert.rejects(Promise.resolve().then(() => handoff.resume()), /old service/u);
    assert.ok(handoff.retryDetach);
    const state = await handoff.retryDetach();
    const fresh = OpenCodeServiceNode.create({} as never, { handoffState: state } as never);
    try {
      await fresh.start();
      assert.equal(starts, 2);
    } finally { await fresh.dispose(); }
  } finally { await old.dispose(); }
});
