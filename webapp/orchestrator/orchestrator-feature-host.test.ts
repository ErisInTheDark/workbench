/* No production exports. Tests protect atomic reload, rollback, generation drain policy, hard shutdown, deadline diagnostics, disposal, and fencing. */
import assert from "node:assert/strict";
import test from "node:test";

import OrchestratorFeatureHost, { type OrchestratorFeatureModule } from "./OrchestratorFeatureHost";
import { createOrchestratorFeatureModuleLoader } from "./orchestrator-feature-loader";
import type { OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification } from "./orchestrator-feature-registry";

interface Features { value: { label: string } }
interface Context { effects: string[] }
type Notification = { value: string };

function deferred<TValue = void>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value?: TValue | PromiseLike<TValue>) => void;
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    reject = nextReject;
    resolve = nextResolve as (value?: TValue | PromiseLike<TValue>) => void;
  });
  return { promise, reject, resolve };
}

function deadlineHarness() {
  const deadlines: Array<ReturnType<typeof deferred>> = [];
  const ready = deferred();
  return {
    create: () => {
      const deadline = deferred();
      deadlines.push(deadline);
      ready.resolve();
      return { cancel: () => undefined, expired: deadline.promise };
    },
    expire: (index = 0) => deadlines[index]?.resolve(),
    ready: ready.promise,
  };
}

function moduleFor(label: string, options: {
  dispose?: (reportPhase: (phase: string) => void) => Promise<void> | void;
  failStart?: boolean;
  onStart?: () => void;
  pending?: () => Array<{ ageMs: number; label: string }>;
} = {}): OrchestratorFeatureModule<Context, Features, Notification> {
  return {
    createOrchestratorFeatureGeneration: (context, lease) => ({
      beginRuntimeDrain: () => { context.effects.push(`begin-drain:${label}`); },
      dispose: async (reportPhase = () => undefined) => {
        context.effects.push(`dispose:${label}`);
        await options.dispose?.(reportPhase);
      },
      expireRuntimeDrain: () => { context.effects.push(`expire-drain:${label}`); },
      get: () => ({ label }),
      listRuntimeDrainPending: options.pending,
      observeProviderNotification: ({ value }) => {
        if (lease.isCurrent()) context.effects.push(`${label}:${value}`);
      },
      start: () => {
        context.effects.push(`start:${label}`);
        options.onStart?.();
        if (options.failStart) throw new Error("candidate failed");
      },
    }),
  };
}

test("failed candidate start preserves the current generation", async () => {
  const context: Context = { effects: [] };
  const modules = [moduleFor("old"), moduleFor("bad", { failStart: true })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  await assert.rejects(host.reload(), /candidate failed/u);
  assert.equal(host.get("value").label, "old");
  await host.observeProviderNotification({ value: "event" });
  assert.deepEqual(context.effects, ["start:old", "start:bad", "dispose:bad", "old:event"]);
  await host.dispose();
});

test("successful reload swaps before draining and fences old generation effects", async () => {
  const context: Context = { effects: [] };
  const newStarted = deferred();
  const modules = [moduleFor("old"), moduleFor("new", { onStart: () => newStarted.resolve() })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  const release = deferred();
  const held = host.run("value", async ({ label }) => {
    await release.promise;
    context.effects.push(`held:${label}`);
  }, "held harness request");
  const reloading = host.reload();
  await newStarted.promise;
  assert.equal(host.get("value").label, "new");
  await host.observeProviderNotification({ value: "event" });
  release.resolve();
  await Promise.all([held, reloading]);
  assert.deepEqual(context.effects, ["start:old", "start:new", "new:event", "begin-drain:old", "held:old", "dispose:old"]);
  await host.dispose();
});

test("runtime-drain deadline aborts deadline policies and reports exact pending owners", async () => {
  let now = 100;
  const context: Context = { effects: [] };
  const deadline = deadlineHarness();
  const newStarted = deferred();
  const modules = [
    moduleFor("old", { pending: () => [{ ageMs: 31_000, label: "mcp subagent_wait" }] }),
    moduleFor("new", { onStart: () => newStarted.resolve() }),
  ];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! }, {
    createRuntimeDrainDeadline: deadline.create,
    now: () => now,
    runtimeDrainTimeoutMs: 30_000,
  });
  await host.start();
  const release = deferred();
  const held = host.run("value", async () => await release.promise, "harnesses: codex workbench/subagent/wait");
  const reloading = host.reload();
  await newStarted.promise;
  await deadline.ready;
  now = 31_100;
  deadline.expire();
  await assert.rejects(reloading, (error: Error) => {
    assert.match(error.message, /new feature generation is active/iu);
    assert.match(error.message, /harnesses: codex workbench\/subagent\/wait \(31000ms\)/u);
    assert.match(error.message, /mcp subagent_wait \(31000ms MCP context\)/u);
    return true;
  });
  assert.ok(context.effects.includes("expire-drain:old"));
  await assert.rejects(host.reload(), /previous feature generation still has timed-out runtime retirement/u);
  release.resolve();
  await held;
});

test("runtime-drain deadline reports the exact disposal phase", async () => {
  const context: Context = { effects: [] };
  const deadline = deadlineHarness();
  const disposalStarted = deferred();
  const releaseDisposal = deferred();
  const modules = [
    moduleFor("old", {
      dispose: async (reportPhase) => {
        reportPhase("thread-state disposal");
        disposalStarted.resolve();
        await releaseDisposal.promise;
      },
    }),
    moduleFor("new"),
  ];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! }, {
    createRuntimeDrainDeadline: deadline.create,
    runtimeDrainTimeoutMs: 30_000,
  });
  await host.start();
  const reloading = host.reload();
  await disposalStarted.promise;
  await deadline.ready;
  deadline.expire();
  await assert.rejects(reloading, /thread-state disposal/u);
  releaseDisposal.resolve();
});

test("hard shutdown cancels the current generation without waiting for a stuck reload", async () => {
  const context: Context = { effects: [] };
  const modules = [moduleFor("old"), moduleFor("new")];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  const releaseOld = deferred();
  const held = host.run("value", async () => await releaseOld.promise, "held old-generation request");
  const reloading = host.reload();
  while (!context.effects.includes("begin-drain:old")) await Promise.resolve();

  const hardShutdown = host.beginHardShutdown();
  assert.ok(context.effects.includes("begin-drain:new"));
  assert.ok(context.effects.includes("expire-drain:new"));

  releaseOld.resolve();
  await Promise.all([held, reloading, hardShutdown]);
  assert.ok(context.effects.includes("dispose:new"));
});

test("feature loader invalidates the registry root as one project-local subtree", () => {
  const loader = createOrchestratorFeatureModuleLoader<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>();
  const first = loader.load();
  const second = loader.reload();
  assert.notEqual(first, second);
  assert.equal(typeof second.createOrchestratorFeatureGeneration, "function");
});
