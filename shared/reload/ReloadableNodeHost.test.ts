/*
 * No production exports. Tests protect owner-local recovery, dependency admission, nested draining, and retired-generation collection.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost, { type ReloadableNodeHostOptions } from "./ReloadableNodeHost";
import type { ReloadDirtSourceState } from "./ReloadDirtController";
import type { ReloadableNodeHandoff, ReloadableNodeLease } from "./ReloadableNode";

interface RecoveryOwner {
  generation: number;
  lease: ReloadableNodeLease;
}

function recoveryFixture(restartable = true) {
  type Features = Record<"first" | "second" | "child" | "unrelated", RecoveryOwner>;
  const control = () => ({
    failStart: false, failResume: false, failDetach: false, failActivate: false,
    onStart: null as (() => Promise<void>) | null,
    resumes: 0, repairs: 0, commits: 0,
    state: { retained: Symbol("retained state") },
  });
  const first = control();
  const second = control();
  let generation = 0;
  const node = ReloadableNode.define<object, Features, never>();
  const graph = () => {
    const current = ++generation;
    const leaf = (key: "child" | "unrelated") => node({
      scope: `server:${key}`, provides: [key], requires: [], children: [],
      access: "agent", lifecycle: "atomic", safeAll: true, description: key,
      create: (_context, build) => ({
        registrations: { [key]: { generation: current, lease: build.lease } },
        start() {}, dispose() {},
      }),
    });
    const owner = (key: "first" | "second", state: typeof first) => node({
      scope: `server:${key}`, provides: [key], requires: [],
      children: key === "first" ? [leaf("child")] : [],
      access: "agent", lifecycle: "handoff", safeAll: true, description: key,
      create: (_context, build) => {
        if (build.mode === "replacement") assert.equal(build.handoffState, state.state);
        const handoff = {
          waitForIdle: async () => {},
          expire() {},
          detach: () => state.state,
          ...(restartable ? {
            retryDetach: () => {
              state.repairs++;
              if (state.failDetach) throw new Error(`${key} cleanup failed`);
              return state.state;
            },
          } : {}),
          resume() {
            state.resumes++;
            if (state.failResume) throw new Error(`${key} resume failed`);
          },
          commit() { state.commits++; },
        } satisfies ReloadableNodeHandoff;
        return {
          registrations: { [key]: { generation: current, lease: build.lease } },
          async start() {
            if (state.failStart) throw new Error(`${key} candidate failed`);
            await state.onStart?.();
          },
          activate() { if (state.failActivate) throw new Error(`${key} activation failed`); },
          beginHandoff: () => handoff,
          dispose() {},
        };
      },
    });
    return defineReloadableNodeGraph([owner("first", first), owner("second", second), leaf("unrelated")]);
  };
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, { topologyScope: "server:topology" });
  const fail = async (both = false) => {
    first.failStart = first.failResume = true;
    second.failResume = both;
    await assert.rejects(host.reload(["server:first", "server:second", "server:unrelated"]));
    first.failStart = false;
  };
  return { host, first, second, fail };
}

test("failed handoffs fence only their owners and dependants while unrelated reloads remain usable", async () => {
  const f = recoveryFixture();
  await f.host.start();
  const child = f.host.get("child");
  try {
    await f.fail(true);
    assert.equal(await f.host.run("unrelated", value => value.lease.isCurrent()), true);
    assert.equal(child.lease.isCurrent(), false);
    await assert.rejects(f.host.run("first", () => true), /unavailable/u);
    await assert.rejects(f.host.run("child", () => true), /unavailable/u);
    await f.host.reload(["server:unrelated"]);
    await f.host.reload(["server:first"]);
    assert.equal(await f.host.run("child", value => value.lease.isCurrent()), true);
    await assert.rejects(f.host.run("second", () => true), /unavailable/u);
    assert.equal(f.second.repairs, 0);
    await f.host.reload(["server:second"]);
    assert.equal(await f.host.run("second", value => value.lease.isCurrent()), true);
  } finally { await f.host.dispose(); }
});

test("fresh replacement repairs a restartable owner without requiring the old resume to succeed", async () => {
  const f = recoveryFixture();
  await f.host.start();
  const previous = f.host.get("first");
  try {
    await f.fail();
    const resumes = f.first.resumes;
    await f.host.reload(["server:first"]);
    assert.equal(f.first.resumes, resumes);
    assert.equal(f.first.repairs, 1);
    assert.equal(f.first.commits, 1);
    assert.equal(previous.lease.isCurrent(), false);
    assert.ok(await f.host.run("first", value => value.generation > previous.generation));
  } finally { await f.host.dispose(); }
});

test("repeated repair failures preserve the handoff until cleanup and replacement both succeed", async () => {
  const f = recoveryFixture();
  await f.host.start();
  try {
    await f.fail();
    f.first.failDetach = true;
    await assert.rejects(f.host.reload(["server:first"]));
    f.first.failDetach = false;
    f.first.failStart = true;
    await assert.rejects(f.host.reload(["server:first"]));
    assert.equal(f.first.commits, 0);
    assert.equal(await f.host.run("unrelated", value => value.lease.isCurrent()), true);
    await assert.rejects(f.host.run("child", () => true), /unavailable/u);
    f.first.failStart = false;
    await f.host.reload(["server:first"]);
    assert.equal(f.first.repairs, 3);
    assert.equal(f.first.commits, 1);
    assert.equal(await f.host.run("child", value => value.lease.isCurrent()), true);
  } finally { await f.host.dispose(); }
});

test("transactional owners must resume before replacement and recover independently", async () => {
  const f = recoveryFixture(false);
  await f.host.start();
  try {
    await f.fail(true);
    await assert.rejects(f.host.reload(["server:first"]), /unavailable|resume/u);
    f.first.failResume = false;
    await assert.rejects(f.host.reload(["server:first", "server:second"]));
    assert.equal(await f.host.run("first", value => value.lease.isCurrent()), true);
    const secondResumes = f.second.resumes;
    await f.host.reload(["server:first"]);
    assert.equal(await f.host.run("first", value => value.lease.isCurrent()), true);
    await assert.rejects(f.host.run("second", () => true), /unavailable/u);
    assert.equal(f.second.resumes, secondResumes);
  } finally { await f.host.dispose(); }
});

test("repair remains fenced through candidate startup and failed activation", async () => {
  const f = recoveryFixture();
  await f.host.start();
  const starting = deferred();
  const release = deferred();
  try {
    await f.fail();
    f.first.onStart = async () => { starting.resolve(); await release.promise; };
    f.first.failActivate = true;
    const reload = assert.rejects(f.host.reload(["server:first"]));
    await starting.promise;
    await assert.rejects(f.host.run("first", () => true), /unavailable/u);
    assert.equal(await f.host.run("unrelated", value => value.lease.isCurrent()), true);
    release.resolve();
    await reload;
    await assert.rejects(f.host.run("child", () => true), /unavailable/u);
    f.first.failActivate = false;
    f.first.onStart = null;
    await f.host.reload(["server:first"]);
    assert.equal(await f.host.run("child", value => value.lease.isCurrent()), true);
  } finally { release.resolve(); await f.host.dispose(); }
});

test("a dependant-only reload names the failed parent without expanding destructive scope", async () => {
  const f = recoveryFixture();
  await f.host.start();
  try {
    await f.fail();
    const previous = f.host.get("child");
    await assert.rejects(f.host.reload(["server:child"]), /server:first/u);
    assert.equal(f.host.get("child"), previous);
    assert.equal(f.first.repairs, 0);
  } finally { await f.host.dispose(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Objects {
  consumer: { read(): Promise<number> };
  value: number;
  unrelated: boolean;
}

test("unrelated topology drift rejects a narrow reload without replacing running owners", async () => {
  let changed = false;
  const started: string[] = [];
  const disposed: string[] = [];
  const graph = () => {
    const node = (
      scope: string, provides: (keyof Objects)[], registrations: Partial<Objects>,
      children: ReloadableNode<object, Objects, never>[] = [],
      requires: (keyof Objects)[] = [],
    ) => ReloadableNode.define<object, Objects, never>()({
      scope, provides, requires, children, access: "agent", lifecycle: "atomic",
      safeAll: true, description: scope,
      create: () => ({
        registrations, start() { started.push(scope); }, dispose() { disposed.push(scope); },
      }),
    });
    const consumer = node("server:consumer", ["consumer"], {
      consumer: { read: async () => changed ? 2 : 1 },
    }, [], changed ? ["value"] : []);
    return defineReloadableNodeGraph([
      node("server:value", ["value"], { value: 1 }, [consumer]),
      node("server:commands", ["unrelated"], { unrelated: true }),
    ]);
  };
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
  });
  await host.start();
  try {
    const original = await host.run("consumer", value => value);
    started.length = 0;
    changed = true;
    await assert.rejects(host.reload(["server:commands"]), /topology changed/u);
    assert.deepEqual(started, []);
    assert.deepEqual(disposed, []);
    assert.equal(await host.run("consumer", value => value), original);
    assert.equal(await host.run("unrelated", value => value), true);

    await host.reload(["server:commands", "server:topology"]);
    assert.deepEqual(new Set(started), new Set(["server:commands", "server:consumer"]));
    assert.deepEqual(new Set(disposed), new Set(["server:commands", "server:consumer"]));
    assert.notEqual(await host.run("consumer", value => value), original);
  } finally {
    await host.dispose();
  }
});

test("idleness includes admitted requests, queued reloads and node-owned background work", async () => {
  let background = true;
  const graph = () => defineReloadableNodeGraph([
    ReloadableNode.define<object, { value: number }, never>()({
      access: "agent", children: [], requires: [], provides: ["value"], scope: "server:value",
      lifecycle: "atomic", safeAll: true, description: "fixture",
      create: () => ({ registrations: { value: 1 }, start() {}, dispose() {}, hasPendingWork: () => background }),
    }),
  ]);
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, { topologyScope: "server:topology" });
  assert.equal(host.isIdle(), false);
  await host.start();
  assert.equal(host.isIdle(), false);
  background = false;
  assert.equal(host.isIdle(), true);
  const entered = deferred();
  const release = deferred();
  const running = host.run("value", async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  assert.equal(host.isIdle(), false);
  release.resolve(); await running;
  assert.equal(host.isIdle(), true);
  const reload = host.reload(["server:value"]);
  assert.equal(host.isIdle(), false);
  await reload;
  assert.equal(host.isIdle(), true);
  await host.dispose();
  assert.equal(host.isIdle(), false);
});

void ReloadableNode.define<object, Objects, never>()({
  access: "agent",
  children: [],
  create: (_context, build) => {
    build.get("value");
    // @ts-expect-error Reload nodes may access only their declared parents.
    build.get("unrelated");
    void build.run("consumer", value => value);
    return { registrations: {}, start() {}, dispose() {} };
  },
  description: "type boundary",
  lifecycle: "atomic",
  provides: [],
  requires: ["value"],
  safeAll: true,
  scope: "server:type-boundary",
});

function fixture(prefix: "server" | "client", options: Pick<ReloadableNodeHostOptions, "createRuntimeDrainDeadline"> = {}) {
  let generation = 0;
  let fail = false;
  const draining = deferred();
  const graph = () => {
    const current = ++generation;
    const node = (
      name: string,
      provides: (keyof Objects)[],
      create: ReloadableNode<object, Objects, never>["create"],
      lifecycle: "atomic" | "handoff" = "atomic",
    ) => ReloadableNode.define<object, Objects, never>()({
      scope: `${prefix}:${name}`, access: "agent", children: [], requires: [], provides,
      lifecycle, safeAll: true, description: name, create,
    });
    return defineReloadableNodeGraph([
      node("consumer", ["consumer"], (_context, build) => ({
        registrations: { consumer: { read: () => build.run("value", value => value, "nested read") } },
        start() {}, dispose() {},
      })),
      node("value", ["value"], () => ({
        registrations: { value: current },
        start() { if (fail) throw new Error("candidate failed"); },
        dispose() {},
        beginHandoff: () => ({
          waitForIdle: async () => { draining.resolve(); },
          detach() {}, resume() {}, commit() {}, expire() {},
        }),
      }), "handoff"),
      node("unrelated", ["unrelated"], () => ({
        registrations: { unrelated: true }, start() {}, dispose() {},
      })),
    ]);
  };
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, {
    ...options,
    topologyScope: `${prefix}:topology`,
  });
  return {
    host, draining,
    scopes: [`${prefix}:consumer`, `${prefix}:value`],
    fail: (value: boolean) => { fail = value; },
  };
}

for (const prefix of ["server", "client"] as const) {
  test(`${prefix} nodes receive typed operation access without process-context wiring`, async () => {
    const f = fixture(prefix);
    await f.host.start();
    try {
      assert.equal(await f.host.run("consumer", owner => owner.read()), 1);
      await f.host.reload([`${prefix}:value`]);
      assert.equal(await f.host.run("consumer", owner => owner.read()), 2);
    } finally { await f.host.dispose(); }
  });

  test(`${prefix} admitted nested work finishes a shared drain while fresh work waits`, async () => {
    const f = fixture(prefix);
    await f.host.start();
    const entered = deferred();
    const proceed = deferred();
    try {
      // Check the port before entering the controlled drain.
      assert.equal(await f.host.run("consumer", owner => owner.read()), 1);
      const admitted = f.host.run("consumer", async owner => {
        entered.resolve();
        await proceed.promise;
        return owner.read();
      });
      await entered.promise;
      const reload = f.host.reload(f.scopes);
      await f.draining.promise;
      const fresh = f.host.run("consumer", owner => owner.read());
      const unrelated = f.host.run("unrelated", () => f.host.run("value", value => value));
      proceed.resolve();
      assert.equal(await admitted, 1);
      await reload;
      assert.equal(await fresh, 2);
      assert.equal(await unrelated, 2);
    } finally { proceed.resolve(); await f.host.dispose(); }
  });
}

test("settled async context cannot bypass a later drain gate", async () => {
  const f = fixture("server");
  await f.host.start();
  const entered = deferred();
  const proceed = deferred();
  try {
    const resume = await f.host.run("consumer", () => AsyncLocalStorage.snapshot());
    const admitted = f.host.run("consumer", async owner => {
      entered.resolve();
      await proceed.promise;
      return owner.read();
    });
    await entered.promise;
    const reload = f.host.reload(f.scopes);
    await f.draining.promise;
    const stale = resume(() => f.host.run("value", value => value));
    proceed.resolve();
    assert.equal(await admitted, 1);
    await reload;
    assert.equal(await stale, 2);
  } finally { proceed.resolve(); await f.host.dispose(); }
});

test("work relayed beyond the operations a drain admitted cannot hold that drain open", async () => {
  const f = fixture("server", { createRuntimeDrainDeadline: () => ({ cancel() {}, expired: new Promise<void>(() => undefined) }) });
  await f.host.start();
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  let relaying = true;
  let drainStarted = false;
  let linksDuringDrain = 0;
  const livelocked = deferred();
  const migrated = deferred();
  // Each link outlives the admission of the next one it leaves behind, like a fire-and-forget follow-up.
  const relay = (): Promise<void> => f.host.run("consumer", async owner => {
    const generation = await owner.read();
    if (generation === 2) migrated.resolve();
    if (drainStarted && generation === 1 && ++linksDuringDrain > 20) livelocked.resolve();
    await tick();
    if (relaying) void relay().catch(() => undefined);
    await tick();
  });
  try {
    void relay().catch(() => undefined);
    await tick();
    const reload = f.host.reload(f.scopes);
    await f.draining.promise;
    drainStarted = true;
    const outcome = await Promise.race([reload.then(() => "reloaded"), livelocked.promise.then(() => "livelocked")]);
    assert.equal(outcome, "reloaded");
    await migrated.promise;
  } finally { relaying = false; await f.host.dispose(); }
});

test("nested failure releases the drain and failed replacement restores operation access", async () => {
  const f = fixture("server");
  await f.host.start();
  const entered = deferred();
  const proceed = deferred();
  try {
    assert.equal(await f.host.run("consumer", owner => owner.read()), 1);
    const failure = f.host.run("consumer", async owner => {
      entered.resolve();
      await proceed.promise;
      await owner.read();
      throw new Error("operation failed");
    });
    const rejected = assert.rejects(failure, /operation failed/);
    await entered.promise;
    f.fail(true);
    const reload = assert.rejects(f.host.reload(f.scopes), /candidate failed/);
    await f.draining.promise;
    proceed.resolve();
    await rejected;
    await reload;
    assert.equal(await f.host.run("consumer", owner => owner.read()), 1);
  } finally { proceed.resolve(); await f.host.dispose(); }
});

test("source ownership is published with its successful graph and restored after candidate failure", async () => {
  let source = "shared/first.ts";
  let failure: "start" | "activate" | null = null;
  const starting = deferred();
  const release = deferred();
  type SourceObjects = { readSources: () => ReloadDirtSourceState };
  const graph = () => ({
    ...defineReloadableNodeGraph([
      ReloadableNode.define<object, SourceObjects, never>()({
        scope: "client:owner", access: "operator", description: "owner", lifecycle: "atomic",
        provides: ["readSources"], requires: [], children: [], safeAll: false,
        create: (_context, build) => ({
          registrations: { readSources: () => build.getSourceState() },
          start: async () => {
            if (build.mode === "replacement") { starting.resolve(); await release.promise; }
            if (failure === "start") throw new Error("candidate failed");
          },
          activate: () => {
            if (failure === "activate") {
              assert.deepEqual(build.getSourceState().descriptors.find(({ scope }) => scope === "client:owner")?.paths, ["shared/second.ts"]);
              throw new Error("activation failed");
            }
          },
          dispose() {},
        }),
      }),
      ReloadableNode.define<object, SourceObjects, never>()({
        scope: "client:sibling", access: "operator", description: "sibling", lifecycle: "atomic",
        provides: [], requires: [], children: [], safeAll: false,
        create: () => ({ registrations: {}, start() {}, dispose() {} }),
      }),
    ]),
    sourceMetadata: {
      pathsByScope: new Map([["client:owner", [source]], ["client:sibling", [`sibling/${source}`]]]),
      topologyPaths: ["app/root.ts"],
      processPaths: ["shared/reload/kernel.ts", `process/${source}`],
    },
  });
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, {
    topologyScope: "client:topology",
    processScopes: [{
      descriptor: { scope: "client:process", access: "operator", description: "process", safeAll: false, destructive: true },
      assets: "shared/reload/**",
    }, {
      descriptor: { scope: "client:install", access: "operator", description: "install", safeAll: false, destructive: true },
      assets: "pnpm-lock.yaml",
      sources: "assets",
      subsumesAll: true,
    }],
  });
  const read = () => host.run("readSources", readSources => readSources());
  const paths = (state: ReloadDirtSourceState) => state.descriptors.find(({ scope }) => scope === "client:owner")?.paths;
  await host.start();
  try {
    assert.deepEqual(paths(await read()), ["shared/first.ts"]);
    assert.deepEqual(host.getReloadScopesForPaths(["pnpm-lock.yaml"]), ["client:install"]);
    assert.deepEqual(host.getReloadScopesForPaths(["shared/reload/kernel.ts"]), ["client:process"]);
    assert.deepEqual((await read()).dependantClosure(["client:install"]), host.getReloadScopeCatalog().map(({ scope }) => scope));
    assert.equal((await read()).dependantClosure(["client:process"]).includes("client:install"), false);
    source = "shared/second.ts";
    const reload = host.reload(["client:owner"]);
    await starting.promise;
    assert.deepEqual(paths(await read()), ["shared/first.ts"]);
    release.resolve();
    await reload;
    assert.deepEqual(paths(await read()), ["shared/second.ts"]);
    assert.deepEqual((await read()).descriptors.find(({ scope }) => scope === "client:sibling")?.paths, ["sibling/shared/first.ts"]);
    assert.deepEqual(host.getReloadScopesForPaths(["shared/second.ts"]), ["client:owner"]);
    assert.equal((await read()).descriptors.find(({ scope }) => scope === "client:process")?.paths.includes("shared/reload/kernel.ts"), true);
    failure = "start";
    source = "shared/failed.ts";
    await assert.rejects(host.reload(["client:owner"]), /candidate failed/);
    assert.deepEqual(paths(await read()), ["shared/second.ts"]);
    failure = "activate";
    await assert.rejects(host.reload(["client:owner"]), /activation failed/);
    assert.deepEqual(paths(await read()), ["shared/second.ts"]);
    assert.equal(host.getReloadScopesForPaths(["process/shared/failed.ts"]).includes("client:process"), false);
  } finally { release.resolve(); await host.dispose(); }
});

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

interface PinObjects { consumer: { read(): number }; unrelated: boolean; value: number }

test("a live node's build keeps no replaced sibling reachable", async () => {
  let retired: WeakRef<object> | null = null;
  let siblings = 0;
  const node = ReloadableNode.define<object, PinObjects, never>();
  const graph = () => {
    const consumer = node({
      scope: "server:consumer", provides: ["consumer"], requires: ["value"], children: [],
      access: "agent", lifecycle: "atomic", safeAll: true, description: "consumer",
      // A lazy parent read keeps `build` alive for the node's whole life, as real nodes do.
      create: (_context, build) => ({ registrations: { consumer: { read: () => build.get("value") } }, start() {}, dispose() {} }),
    });
    // The sibling is created before the consumer, so a whole-graph snapshot would include it.
    return defineReloadableNodeGraph([
      node({
        scope: "server:commands", provides: ["unrelated"], requires: [], children: [],
        access: "agent", lifecycle: "atomic", safeAll: true, description: "sibling",
        create: () => {
          const instance = { registrations: { unrelated: true }, start() {}, dispose() {} };
          if (siblings++ === 0) retired = new WeakRef(instance);
          return instance;
        },
      }),
      node({
        scope: "server:value", provides: ["value"], requires: [], children: [consumer],
        access: "agent", lifecycle: "atomic", safeAll: true, description: "value",
        create: () => ({ registrations: { value: 1 }, start() {}, dispose() {} }),
      }),
    ]);
  };
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, { topologyScope: "server:topology" });
  await host.start();
  try {
    await host.reload(["server:commands"]);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    collectGarbage();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(retired!.deref(), undefined);
    assert.equal(await host.run("consumer", consumer => consumer.read()), 1);
  } finally { await host.dispose(); }
});

test("a stalled startup step names its node and phase once, then reports when it finishes", async () => {
  const errors: string[] = [];
  const stall = deferred();
  const released = deferred();
  const graph = () => defineReloadableNodeGraph([ReloadableNode.define<object, { value: number }, never>()({
    access: "agent", children: [], requires: [], provides: ["value"], scope: "server:value",
    lifecycle: "atomic", safeAll: true, description: "fixture",
    create: () => ({
      registrations: { value: 1 },
      async start(reportPhase) { reportPhase?.("opening the store"); await released.promise; },
      dispose() {},
    }),
  })]);
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
    logError: message => errors.push(message),
    // Only the first startup step (start) stalls; activation finishes before its report delay.
    createRuntimeDrainDeadline: () => ({ cancel() {}, expired: deadlines++ === 0 ? stall.promise : new Promise<void>(() => {}) }),
  });
  let deadlines = 0;
  const starting = host.start();
  try {
    stall.resolve();
    await new Promise<void>(resolve => { setImmediate(resolve); });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /still waiting on server:value: start \(opening the store\)/u);
    released.resolve();
    await starting;
    assert.equal(errors.length, 2);
    assert.match(errors[1]!, /finished server:value: start/u);
  } finally {
    released.resolve();
    await starting;
    await host.dispose();
  }
});

test("the retention warning names operations still running on retired nodes", async () => {
  const errors: string[] = [];
  let lastMajorCollectionAt = 0;
  const graph = () => defineReloadableNodeGraph([ReloadableNode.define<object, { value: number }, never>()({
    access: "agent", children: [], requires: [], provides: ["value"], scope: "server:value",
    lifecycle: "atomic", safeAll: true, description: "fixture",
    create: () => ({ registrations: { value: 1 }, start() {}, dispose() {} }),
  })]);
  const host = new ReloadableNodeHost({}, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
    logError: message => errors.push(message),
    retentionLastMajorCollectionAt: () => lastMajorCollectionAt,
    // Drain expires at once, so the held operation keeps running on a retired node.
    createRuntimeDrainDeadline: () => ({ cancel() {}, expired: Promise.resolve() }),
  });
  await host.start();
  const entered = deferred();
  const release = deferred();
  const held = host.run("value", async () => { entered.resolve(); await release.promise; }, "held shell");
  try {
    await entered.promise;
    await host.reload(["server:value"]);
    lastMajorCollectionAt = Number.POSITIVE_INFINITY;
    await host.reload(["server:value"]);
    const report = errors.filter(message => message.includes("survived a later major garbage collection")).at(-1) ?? "";
    assert.match(report, /Still running on retired nodes: server:value: held shell \(/u);
    release.resolve();
    await held;
    errors.length = 0;
    for (let reload = 0; reload < 3; reload += 1) await host.reload(["server:value"]);
    assert.doesNotMatch(errors.join("\n"), /held shell/u);
  } finally {
    release.resolve();
    await host.dispose();
  }
});
