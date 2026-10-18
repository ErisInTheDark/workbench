/* No exports. Tests protect restart intent across rollback and service restarts that never block a reload. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import OpenCodeServiceNode from "./OpenCodeServiceNode";
import OpenCodeServiceController from "./OpenCodeServiceController";
import ReloadableNode, { defineReloadableNodeGraph } from "workbench-shared/reload/ReloadableNode";
import ReloadableNodeHost from "workbench-shared/reload/ReloadableNodeHost";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";

/** Restart failures are reported, not thrown; capture them so tests can assert the report. */
function captureErrors(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function graphHost(options: { failUnrelated: () => boolean }) {
  const node = ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>();
  const graph = () => defineReloadableNodeGraph([
    node({ ...OpenCodeServiceNode, children: [] }),
    node({
      scope: "server:unrelated", provides: ["openCodeModelCatalog"], requires: [], children: [],
      access: "agent", lifecycle: "atomic", safeAll: true, description: "unrelated fixture",
      create: () => ({
        registrations: { openCodeModelCatalog: { read: async () => ({ models: [], defaultModel: null }) } },
        start() { if (options.failUnrelated()) throw new Error("unrelated cannot start"); },
        dispose() {},
      }),
    }),
  ]);
  return new ReloadableNodeHost({} as DaemonProcessContext, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
  });
}

test("rollback un-suspends the retained service before restarting it, even after a failed detach", async t => {
  const calls: string[] = [];
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async () => { throw new Error("stop failed"); });
  t.mock.method(OpenCodeServiceController.prototype, "resume", () => { calls.push("resume"); });
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async () => { calls.push("acquire"); return {} as never; });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async () => {});
  const instance = OpenCodeServiceNode.create({} as never, { handoffState: undefined } as never);
  const handoff = instance.beginHandoff!({ isReplacing: () => true });
  try {
    await assert.rejects(Promise.resolve().then(() => handoff.detach()), /stop failed/u);
    await handoff.resume();
    assert.deepEqual(calls, ["resume", "acquire"]);
  } finally { await instance.dispose(); }
});

// The companion plugin calls back into Workbench while it loads, so a restart awaited inside the reload waits on its own gate.
test("a reload commits before its service restart calls back into the replaced owner", { timeout: 10_000 }, async t => {
  let host!: ReloadableNodeHost<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>;
  let old: OpenCodeServiceController | null = null;
  const restarted = deferred();
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async () => true);
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async function (this: OpenCodeServiceController) {
    if (this !== old) {
      await host.run("openCodeService", service => service);
      restarted.resolve();
    }
    return {} as never;
  });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async () => {});
  host = graphHost({ failUnrelated: () => false });
  await host.start();
  old = host.get("openCodeService");
  try {
    await host.reload(["harness:opencode"]);
    await restarted.promise;
    assert.notEqual(host.get("openCodeService"), old);
  } finally { await host.dispose(); }
});

test("a service that cannot restart leaves its owner usable instead of failing the reload or rollback", async t => {
  const active = new Set<OpenCodeServiceController>();
  let old: OpenCodeServiceController;
  let failServices = false;
  let failUnrelated = false;
  const attempts: OpenCodeServiceController[] = [];
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async function (this: OpenCodeServiceController) {
    return active.delete(this);
  });
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async function (this: OpenCodeServiceController) {
    attempts.push(this);
    if (failServices) throw new Error("service cannot start");
    active.add(this);
    return {} as never;
  });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async function (this: OpenCodeServiceController) {
    active.delete(this);
  });
  const errors = captureErrors(t);
  const host = graphHost({ failUnrelated: () => failUnrelated });
  await host.start();
  old = host.get("openCodeService");
  try {
    await old.acquire();
    failServices = failUnrelated = true;
    // The unrelated failure rolls back, and the old service's failed restart must not strand its owner.
    await assert.rejects(host.reload(["harness:opencode", "server:unrelated"]), /unrelated cannot start/u);
    assert.equal(host.get("openCodeService"), old);
    await host.run("openCodeService", service => service);
    failUnrelated = false;
    // The replacement commits even though its restart fails; a later on-demand acquire starts it.
    await host.reload(["harness:opencode"]);
    const fresh = host.get("openCodeService");
    assert.notEqual(fresh, old);
    assert.equal(attempts.at(-1), fresh);
    failServices = false;
    await host.run("openCodeService", service => service.acquire());
    assert.equal(active.has(fresh), true);
    assert.equal(errors.filter(line => /restart failed: service cannot start/u.test(line)).length, 2);
  } finally { await host.dispose(); }
});

test("restart intent survives a retried detach after the old service could not restart", async t => {
  let suspends = 0;
  const acquired: string[] = [];
  t.mock.method(OpenCodeServiceController.prototype, "suspend", async () => ++suspends === 1);
  t.mock.method(OpenCodeServiceController.prototype, "acquire", async () => {
    acquired.push(acquired.length ? "fresh" : "old");
    if (acquired.length === 1) throw new Error("old service cannot start");
    return {} as never;
  });
  t.mock.method(OpenCodeServiceController.prototype, "dispose", async () => {});
  const errors = captureErrors(t);
  const old = OpenCodeServiceNode.create({} as never, { handoffState: undefined } as never);
  const handoff = old.beginHandoff!({ isReplacing: () => true });
  try {
    await handoff.detach();
    await handoff.resume();
    const state = await handoff.retryDetach!();
    const fresh = OpenCodeServiceNode.create({} as never, { handoffState: state } as never);
    try {
      await fresh.start(() => undefined, new AbortController().signal);
      fresh.afterCommit?.();
      assert.deepEqual(acquired, ["old", "fresh"]);
      assert.ok(errors.some(line => /restart failed: old service cannot start/u.test(line)));
    } finally { await fresh.dispose(); }
  } finally { await old.dispose(); }
});
