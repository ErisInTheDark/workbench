/*
 * No production exports. Tests protect generic node operation access and nested reload draining.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost from "./ReloadableNodeHost";
import type { ReloadDirtSourceState } from "./ReloadDirtController";

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

test("idleness includes admitted requests, queued reloads and node-owned background work", async () => {
  let background = true;
  const graph = () => defineReloadableNodeGraph([
    ReloadableNode.define<object, { value: number }, never>()({
      access: "agent", children: [], requires: [], provides: ["value"], scope: "server:value",
      lifecycle: "atomic", safeAll: true, sources: "", description: "fixture",
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
  sources: "",
});

function fixture(prefix: "server" | "client") {
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
      lifecycle, safeAll: true, sources: "", description: name, create,
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
        provides: ["readSources"], requires: [], children: [], safeAll: false, sources: "",
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
        provides: [], requires: [], children: [], safeAll: false, sources: "",
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
    processScope: {
      descriptor: { scope: "client:process", access: "operator", description: "process", safeAll: false, destructive: true },
      sources: "shared/reload/**",
    },
  });
  const read = () => host.run("readSources", readSources => readSources());
  const paths = (state: ReloadDirtSourceState) => state.descriptors.find(({ scope }) => scope === "client:owner")?.paths;
  await host.start();
  try {
    assert.deepEqual(paths(await read()), ["shared/first.ts"]);
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
