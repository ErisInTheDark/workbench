/*
 * No production exports. Node tests protect parent-owned topology ordering, shared-child identity, candidate validation, topology replacement, and rollback. Keywords: graph, topology, reload, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import ReloadableNode, { defineReloadableNodeGraph, type ReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost from "./ReloadableNodeHost";

interface Objects {
  a: string;
  b: string;
  child: string;
  extra: string;
}

type Graph = ReloadableNodeGraph<null, Objects, never>;

function node(options: {
  children?: readonly ReloadableNode<null, Objects, never>[];
  create?: ReloadableNode<null, Objects, never>["create"];
  lifecycle?: "atomic" | "handoff";
  provides?: readonly (keyof Objects)[];
  requires?: readonly (keyof Objects)[];
  scope: string;
}) {
  return new ReloadableNode<null, Objects, never>({
    access: "agent",
    children: options.children ?? [],
    create: options.create ?? (() => ({ dispose: () => undefined, registrations: {}, start: () => undefined })),
    description: options.scope,
    lifecycle: options.lifecycle ?? "atomic",
    provides: options.provides ?? [],
    requires: options.requires ?? [],
    safeAll: true,
    scope: options.scope,
    sources: `${options.scope}.ts`,
  });
}

function loader(initial: Graph, replacement: Graph) {
  return { load: () => initial, reload: () => replacement };
}

test("shared children initialize once after every parent and dispose before every parent", async () => {
  const events: string[] = [];
  let childCreates = 0;
  const child = node({
    create: (_context, build) => {
      childCreates += 1;
      assert.equal(build.get("a"), "a");
      assert.equal(build.get("b"), "b");
      return {
        dispose: () => { events.push("dispose child"); },
        registrations: { child: "child" },
        start: () => { events.push("start child"); },
      };
    },
    provides: ["child"],
    requires: ["a", "b"],
    scope: "server:child",
  });
  const parent = (scope: "server:a" | "server:b", key: "a" | "b") => node({
    children: [child],
    create: () => ({
      dispose: () => { events.push(`dispose ${key}`); },
      registrations: { [key]: key },
      start: () => { events.push(`start ${key}`); },
    }),
    provides: [key],
    scope,
  });
  const graph = defineReloadableNodeGraph([parent("server:a", "a"), parent("server:b", "b")]);
  const host = new ReloadableNodeHost(null, loader(graph, graph));

  await host.start();
  assert.equal(childCreates, 1);
  assert.deepEqual(events, ["start a", "start b", "start child"]);
  await host.dispose();
  assert.deepEqual(events.slice(3), ["dispose child", "dispose b", "dispose a"]);
});

test("an invalid candidate topology changes no live registration or lifecycle", async () => {
  const events: string[] = [];
  const parent = node({
    create: () => ({ dispose: () => { events.push("dispose live"); }, registrations: { a: "live" }, start: () => { events.push("start live"); } }),
    provides: ["a"],
    scope: "server:a",
  });
  const invalidChild = node({ provides: ["child"], requires: ["b"], scope: "server:child" });
  const initial = defineReloadableNodeGraph([parent]);
  const invalid = defineReloadableNodeGraph([node({ children: [invalidChild], provides: ["a"], scope: "server:a" })]);
  const host = new ReloadableNodeHost(null, loader(initial, invalid));
  await host.start();

  await assert.rejects(host.reload(["server:topology"]), /without a direct parent provider/u);
  assert.equal(host.get("a"), "live");
  assert.deepEqual(events, ["start live"]);
});

test("a candidate missing a process-required registration changes no live state", async () => {
  const events: string[] = [];
  const topology = node({ scope: "server:topology" });
  const live = node({
    create: () => ({ dispose: () => { events.push("dispose live"); }, registrations: { a: "live" }, start: () => { events.push("start live"); } }),
    provides: ["a"],
    scope: "server:a",
  });
  const initial = defineReloadableNodeGraph([topology, live]);
  const invalid = defineReloadableNodeGraph([topology]);
  const host = new ReloadableNodeHost(null, loader(initial, invalid), {
    requiredRegistrations: ["a"],
    requiredScopes: ["server:topology"],
  });
  await host.start();

  await assert.rejects(host.reload(["server:topology"]), /missing process-required registration a/u);
  assert.equal(host.get("a"), "live");
  assert.deepEqual(events, ["start live"]);
});

test("a candidate missing the process-required topology scope changes no live state", async () => {
  const events: string[] = [];
  const topology = node({ scope: "server:topology" });
  const live = node({
    create: () => ({ dispose: () => { events.push("dispose live"); }, registrations: { a: "live" }, start: () => { events.push("start live"); } }),
    provides: ["a"],
    scope: "server:a",
  });
  const initial = defineReloadableNodeGraph([topology, live]);
  const invalid = defineReloadableNodeGraph([live]);
  const host = new ReloadableNodeHost(null, loader(initial, invalid), {
    requiredRegistrations: ["a"],
    requiredScopes: ["server:topology"],
  });
  await host.start();

  await assert.rejects(host.reload(["server:topology"]), /missing process-required scope server:topology/u);
  assert.equal(host.get("a"), "live");
  assert.deepEqual(events, ["start live"]);
});

test("a candidate with duplicate registration owners changes no live state", async () => {
  const events: string[] = [];
  const live = node({
    create: () => ({ dispose: () => { events.push("dispose live"); }, registrations: { a: "live" }, start: () => { events.push("start live"); } }),
    provides: ["a"],
    scope: "server:a",
  });
  const initial = defineReloadableNodeGraph([live]);
  const invalid = defineReloadableNodeGraph([
    node({ provides: ["a"], scope: "server:a" }),
    node({ provides: ["a"], scope: "server:b" }),
  ]);
  const host = new ReloadableNodeHost(null, loader(initial, invalid));
  await host.start();

  await assert.rejects(host.reload(["server:topology"]), /registration a is declared by both server:a and server:b/u);
  assert.equal(host.get("a"), "live");
  assert.deepEqual(events, ["start live"]);
});

test("topology reload adds and reparents nodes from the fresh parent declarations", async () => {
  const events: string[] = [];
  const oldChild = node({
    create: () => ({ dispose: () => { events.push("dispose old child"); }, registrations: { child: "old" }, start: () => undefined }),
    provides: ["child"],
    scope: "server:child",
  });
  const oldParent = node({
    children: [oldChild],
    create: () => ({ dispose: () => { events.push("dispose old parent"); }, registrations: { a: "old parent" }, start: () => undefined }),
    provides: ["a"],
    scope: "server:a",
  });
  const newChild = node({
    create: (_context, build) => ({
      dispose: () => undefined,
      registrations: { child: `${build.get("b")}:child` },
      start: () => { events.push("start new child"); },
    }),
    provides: ["child"],
    requires: ["b"],
    scope: "server:child",
  });
  const newParent = node({
    children: [newChild],
    create: () => ({ dispose: () => undefined, registrations: { b: "new parent" }, start: () => { events.push("start new parent"); } }),
    provides: ["b"],
    scope: "server:b",
  });
  const initial = defineReloadableNodeGraph([oldParent]);
  const replacement = defineReloadableNodeGraph([newParent]);
  const host = new ReloadableNodeHost(null, loader(initial, replacement));
  await host.start();
  await host.reload(["server:topology"]);

  assert.equal(host.get("child"), "new parent:child");
  assert.deepEqual(events, ["dispose old child", "dispose old parent", "start new parent", "start new child"]);
});

test("failed topology startup restores the previous graph and registrations", async () => {
  const oldParent = node({
    create: () => ({ dispose: () => undefined, registrations: { a: "restored" }, start: () => undefined }),
    provides: ["a"],
    scope: "server:a",
  });
  const failingChild = node({
    create: () => ({ dispose: () => undefined, registrations: { extra: "candidate" }, start: () => { throw new Error("candidate start failed"); } }),
    provides: ["extra"],
    scope: "server:extra",
  });
  const replacementParent = node({
    children: [failingChild],
    create: () => ({ dispose: () => undefined, registrations: { a: "candidate" }, start: () => undefined }),
    provides: ["a"],
    scope: "server:a",
  });
  const initial = defineReloadableNodeGraph([oldParent]);
  const replacement = defineReloadableNodeGraph([replacementParent]);
  const host = new ReloadableNodeHost(null, loader(initial, replacement));
  await host.start();

  await assert.rejects(host.reload(["server:topology"]), /candidate start failed/u);
  assert.equal(host.get("a"), "restored");
  assert.throws(() => host.get("extra"), /unavailable/u);
});

test("path projection includes node-owned sources and the stable process kernel", () => {
  const graph = defineReloadableNodeGraph([node({ scope: "server:a" })]);
  const host = new ReloadableNodeHost(null, loader(graph, graph));
  assert.deepEqual(host.getReloadScopesForPaths(["server:a.ts"]), ["server:a"]);
  assert.deepEqual(host.getReloadScopesForPaths(["webapp/orchestrator/index.ts"]), ["server:process"]);
});
