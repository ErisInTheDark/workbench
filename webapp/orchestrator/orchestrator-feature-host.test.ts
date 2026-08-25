/* No production exports. Tests protect graph validation, dependant closure, node leases, atomic rollback, handoff rollback, hard shutdown, drain diagnostics, and loader freshness. */
import assert from "node:assert/strict";
import test from "node:test";

import OrchestratorFeatureHost, {
  type OrchestratorFeatureModule,
  type OrchestratorFeatureNodeDefinition,
} from "./OrchestratorFeatureHost";
import { createOrchestratorFeatureModuleLoader } from "./orchestrator-feature-loader";
import type { OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification } from "./orchestrator-feature-registry";

type Value = { label: string };
interface Features { codex: Value; core: Value; mcp: Value; unrelated: Value }
interface Context { effects: string[] }
type Notification = { value: string };

function deferred<TValue = void>() {
  let resolve!: (value?: TValue | PromiseLike<TValue>) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve as typeof resolve; });
  return { promise, resolve };
}

function node(
  id: string,
  scope: string,
  key: keyof Features,
  label: string,
  options: {
    dependencies?: string[];
    failActivate?: boolean;
    failDetach?: boolean;
    failDispose?: boolean;
    failStart?: boolean;
    lifecycle?: "atomic" | "handoff";
    onExpire?: () => void;
    onStart?: () => Promise<void> | void;
    pending?: () => Array<{ ageMs: number; label: string }>;
  } = {},
): OrchestratorFeatureNodeDefinition<Context, Features, Notification> {
  return {
    create: (context, { handoffState, lease, mode }) => ({
      activate: () => {
        context.effects.push(`activate:${label}`);
        if (options.failActivate) throw new Error(`candidate ${label} activation failed`);
      },
      detachForReload: options.lifecycle === "handoff" ? () => {
        context.effects.push(`detach:${label}`);
        if (options.failDetach) throw new Error(`detach ${label} failed`);
        return { label };
      } : undefined,
      dispose: () => {
        context.effects.push(`dispose:${label}`);
        if (options.failDispose) throw new Error(`dispose ${label} failed`);
      },
      features: { [key]: { label: mode === "restore" && handoffState ? `${label}:restored` : label } },
      expireRuntimeDrain: () => {
        context.effects.push(`expire:${label}`);
        options.onExpire?.();
      },
      listRuntimeDrainPending: options.pending,
      observeProviderNotification: ({ value }) => {
        if (lease.isCurrent()) context.effects.push(`notify:${label}:${value}`);
      },
      start: async () => {
        context.effects.push(`start:${label}`);
        await options.onStart?.();
        if (options.failStart) throw new Error(`candidate ${label} failed`);
      },
    }),
    dependencies: options.dependencies ?? [],
    featureKeys: [key],
    id,
    lifecycle: options.lifecycle ?? "atomic",
    scope,
  };
}

function graph(label: string, options: { failCodex?: boolean; failCodexActivate?: boolean; failMcp?: boolean; onCoreStart?: () => void; pendingCore?: () => Array<{ ageMs: number; label: string }> } = {}): OrchestratorFeatureModule<Context, Features, Notification> {
  return {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", `${label}:core`, { onStart: options.onCoreStart, pending: options.pendingCore }),
      node("mcp", "server:mcp", "mcp", `${label}:mcp`, { dependencies: ["core"], failStart: options.failMcp }),
      node("codex", "server:codex", "codex", `${label}:codex`, { dependencies: ["core"], failActivate: options.failCodexActivate, failStart: options.failCodex, lifecycle: "handoff" }),
      node("unrelated", "server:other", "unrelated", `${label}:unrelated`),
    ],
  };
}

test("candidate cleanup preserves the startup failure and disposes every node", async () => {
  const context: Context = { effects: [] };
  const old = graph("old");
  const bad: OrchestratorFeatureModule<Context, Features, Notification> = {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", "bad:core"),
      node("mcp", "server:mcp", "mcp", "bad:mcp", { dependencies: ["core"], failDispose: true, failStart: true }),
      node("codex", "server:codex", "codex", "bad:codex", { dependencies: ["core"], lifecycle: "handoff" }),
      node("unrelated", "server:other", "unrelated", "bad:unrelated"),
    ],
  };
  const host = new OrchestratorFeatureHost(context, { load: () => old, reload: () => bad });
  await host.start();

  await assert.rejects(host.reload(["server:core"]), (error: AggregateError) => {
    assert.match(error.message, /startup and cleanup both failed/u);
    assert.match(String(error.errors[0]), /candidate bad:mcp failed/u);
    assert.match(String(error.errors[1]), /dispose bad:mcp failed/u);
    return true;
  });

  assert.ok(context.effects.indexOf("dispose:bad:mcp") < context.effects.indexOf("dispose:bad:core"));
  assert.equal(host.get("core").label, "old:core");
  await host.dispose();
});

test("validates unknown dependencies, duplicate ownership, and cycles before startup", () => {
  const context: Context = { effects: [] };
  const hostFor = (nodes: OrchestratorFeatureNodeDefinition<Context, Features, Notification>[]) => (
    () => new OrchestratorFeatureHost(context, { load: () => ({ createOrchestratorFeatureNodes: () => nodes }), reload: () => graph("unused") })
  );
  assert.throws(hostFor([node("bad", "server:bad", "core", "bad", { dependencies: ["missing"] })]), /unknown node missing/u);
  assert.throws(hostFor([
    node("left", "server:left", "core", "left", { dependencies: ["right"] }),
    node("right", "server:right", "mcp", "right", { dependencies: ["left"] }),
  ]), /cycle: left -> right -> left/u);
  assert.throws(hostFor([
    node("left", "server:left", "core", "left"),
    node("right", "server:right", "core", "right"),
  ]), /owned by both left and right/u);
});

test("a parent scope replaces every transitive dependant exactly once and preserves unrelated identity", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("new")];
  const swaps: string[][] = [];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! }, {
    onSwap: (ids) => { swaps.push([...ids]); },
  });
  await host.start();
  const unrelated = host.get("unrelated");
  await host.reload(["server:core"]);
  assert.equal(host.get("core").label, "new:core");
  assert.equal(host.get("mcp").label, "new:mcp");
  assert.equal(host.get("codex").label, "new:codex");
  assert.equal(host.get("unrelated"), unrelated);
  assert.deepEqual(swaps, [["core", "mcp", "codex"]]);
  assert.equal(context.effects.filter((effect) => effect === "start:new:core").length, 1);
  assert.equal(context.effects.filter((effect) => effect === "start:new:mcp").length, 1);
  assert.equal(context.effects.filter((effect) => effect === "start:new:codex").length, 1);
  await host.dispose();
});

test("a dependant operation leases its parent and delays a handoff replacement", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("new")];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  const release = deferred();
  const held = host.run("codex", async ({ label }) => {
    context.effects.push(`held:${label}`);
    await release.promise;
  }, "held Codex request");
  while (!context.effects.includes("held:old:codex")) await Promise.resolve();
  const reloading = host.reload(["server:core"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(context.effects.includes("detach:old:codex"), false);
  release.resolve();
  await Promise.all([held, reloading]);
  assert.ok(context.effects.indexOf("held:old:codex") < context.effects.indexOf("detach:old:codex"));
  await host.dispose();
});

test("failed atomic candidate start leaves the current nodes untouched", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("bad", { failMcp: true })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  await assert.rejects(host.reload(["server:mcp"]), /candidate bad:mcp failed/u);
  assert.equal(host.get("mcp").label, "old:mcp");
  assert.equal(host.get("core").label, "old:core");
  await host.observeProviderNotification({ value: "event" });
  assert.ok(context.effects.includes("notify:old:mcp:event"));
  await host.dispose();
});

test("failed handoff candidate reconstructs the old branch from captured state", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("bad", { failCodex: true })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  await assert.rejects(host.reload(["server:codex"]), /candidate bad:codex failed/u);
  assert.equal(host.get("codex").label, "old:codex:restored");
  assert.equal(host.get("core").label, "old:core");
  assert.ok(context.effects.indexOf("dispose:bad:codex") < context.effects.lastIndexOf("start:old:codex"));
  assert.ok(context.effects.includes("activate:old:codex"));
  await host.dispose();
});

test("a partial handoff detach restores each node that already detached", async () => {
  const context: Context = { effects: [] };
  const old: OrchestratorFeatureModule<Context, Features, Notification> = {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", "old:core", { failDetach: true, lifecycle: "handoff" }),
      node("codex", "server:codex", "codex", "old:codex", { dependencies: ["core"], lifecycle: "handoff" }),
      node("mcp", "server:mcp", "mcp", "old:mcp"),
      node("unrelated", "server:other", "unrelated", "old:unrelated"),
    ],
  };
  const replacement: OrchestratorFeatureModule<Context, Features, Notification> = {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", "new:core", { lifecycle: "handoff" }),
      node("codex", "server:codex", "codex", "new:codex", { dependencies: ["core"], lifecycle: "handoff" }),
      node("mcp", "server:mcp", "mcp", "new:mcp"),
      node("unrelated", "server:other", "unrelated", "new:unrelated"),
    ],
  };
  const host = new OrchestratorFeatureHost(context, { load: () => old, reload: () => replacement });
  await host.start();

  await assert.rejects(host.reload(["server:core"]), /detach old:core failed/u);

  assert.equal(host.get("core").label, "old:core");
  assert.equal(host.get("codex").label, "old:codex:restored");
  assert.ok(context.effects.includes("detach:old:codex"));
  assert.ok(context.effects.includes("start:old:codex"));
  assert.ok(context.effects.includes("activate:old:codex"));
  await host.dispose();
});

test("post-commit activation failure keeps the committed candidate and retires the old handoff node", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("new", { failCodexActivate: true })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  await assert.rejects(host.reload(["server:codex"]), /candidate new:codex activation failed/u);
  assert.equal(host.get("codex").label, "new:codex");
  assert.ok(context.effects.includes("dispose:old:codex"));
  await host.dispose();
});

test("combined scopes use one union transaction and reject unknown scopes", async () => {
  const context: Context = { effects: [] };
  const modules = [graph("old"), graph("new")];
  const swaps: string[][] = [];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! }, { onSwap: (ids) => { swaps.push([...ids]); } });
  await host.start();
  await host.reload(["server:mcp", "server:codex"]);
  assert.deepEqual(swaps, [["mcp", "codex"]]);
  assert.equal(context.effects.filter((effect) => effect === "start:new:mcp").length, 1);
  await assert.rejects(host.reload(["server:missing"]), /unknown orchestrator feature reload scope/iu);
  await host.dispose();
});

test("runtime-drain deadline reports the exact node and operation owner", async () => {
  let expire!: () => void;
  let now = 100;
  const context: Context = { effects: [] };
  const modules = [graph("old", { pendingCore: () => [{ ageMs: 31_000, label: "mcp subagent_wait" }] }), graph("new")];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! }, {
    createRuntimeDrainDeadline: () => ({
      cancel: () => undefined,
      expired: new Promise<void>((resolve) => { expire = resolve; }),
    }),
    now: () => now,
  });
  await host.start();
  const release = deferred();
  const held = host.run("core", async () => await release.promise, "held core request");
  const reloading = host.reload(["server:core"]);
  while (!expire) await Promise.resolve();
  now = 31_100;
  expire();
  await assert.rejects(reloading, (error: Error) => {
    assert.match(error.message, /core: held core request \(31000ms\)/u);
    assert.match(error.message, /core: mcp subagent_wait \(31000ms runtime context\)/u);
    return true;
  });
  release.resolve();
  await held;
});

test("hard shutdown invalidates leases and expires node-owned runtime work before disposal", async () => {
  const context: Context = { effects: [] };
  const release = deferred();
  const initial: OrchestratorFeatureModule<Context, Features, Notification> = {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", "old:core", { onExpire: release.resolve }),
      node("mcp", "server:mcp", "mcp", "old:mcp", { dependencies: ["core"] }),
      node("codex", "server:codex", "codex", "old:codex", { dependencies: ["core"], lifecycle: "handoff" }),
      node("unrelated", "server:other", "unrelated", "old:unrelated"),
    ],
  };
  const host = new OrchestratorFeatureHost(context, { load: () => initial, reload: () => graph("unused") });
  await host.start();
  const operationStarted = deferred();
  const held = host.run("core", async () => {
    operationStarted.resolve();
    await release.promise;
  }, "held hard-shutdown operation");
  await operationStarted.promise;

  const shutdown = host.beginHardShutdown();
  await host.observeProviderNotification({ value: "late" });
  await assert.rejects(host.run("core", () => undefined), /hard shutting down/u);
  await assert.rejects(host.reload(["server:core"]), /hard shutting down/u);
  await Promise.all([held, shutdown]);

  assert.ok(context.effects.includes("expire:old:core"));
  assert.equal(context.effects.some((effect) => effect.endsWith(":late")), false);
  assert.ok(context.effects.includes("dispose:old:core"));
});

test("hard shutdown aborts an in-flight handoff candidate and disposes the restored current graph", async () => {
  const context: Context = { effects: [] };
  const candidateStarted = deferred();
  const releaseCandidate = deferred();
  const old = graph("old");
  const replacement: OrchestratorFeatureModule<Context, Features, Notification> = {
    createOrchestratorFeatureNodes: () => [
      node("core", "server:core", "core", "new:core"),
      node("mcp", "server:mcp", "mcp", "new:mcp", { dependencies: ["core"] }),
      node("codex", "server:codex", "codex", "new:codex", {
        dependencies: ["core"],
        lifecycle: "handoff",
        onStart: async () => {
          candidateStarted.resolve();
          await releaseCandidate.promise;
        },
      }),
      node("unrelated", "server:other", "unrelated", "new:unrelated"),
    ],
  };
  const host = new OrchestratorFeatureHost(context, { load: () => old, reload: () => replacement });
  await host.start();

  const reloading = host.reload(["server:codex"]);
  await candidateStarted.promise;
  const shutdown = host.beginHardShutdown();
  releaseCandidate.resolve();

  await assert.rejects(reloading, /hard shutting down/u);
  await shutdown;

  assert.ok(context.effects.includes("dispose:new:codex"));
  assert.equal(context.effects.includes("activate:new:codex"), false);
  assert.ok(context.effects.includes("activate:old:codex"));
  assert.equal(context.effects.filter((effect) => effect === "dispose:old:codex").length, 1);
});

test("feature loader invalidates the registry root as one project-local subtree", () => {
  const loader = createOrchestratorFeatureModuleLoader<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>();
  const first = loader.load();
  const second = loader.reload();
  assert.notEqual(first, second);
  assert.equal(typeof second.createOrchestratorFeatureNodes, "function");
});
