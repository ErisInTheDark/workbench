/*
 * No production exports. Tests protect generic node operation access and nested reload draining.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost from "./ReloadableNodeHost";

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
    ) => new ReloadableNode<object, Objects, never>({
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
