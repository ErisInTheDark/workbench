/*
 * No production exports. Node tests protect parent-owned topology ordering, shared-child identity, candidate validation, gated topology publication, waiter transfer, and rollback. Keywords: graph, topology, reload, gate, handoff, test.
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

test("server topology migration preserves independent harness roots", async () => {
  const harnessCreates = new Map<string, number>();
  const harnessDisposes = new Map<string, number>();
  const harness = (scope: "harness:codex" | "harness:opencode") => node({
    create: () => {
      harnessCreates.set(scope, (harnessCreates.get(scope) ?? 0) + 1);
      return {
        dispose: () => { harnessDisposes.set(scope, (harnessDisposes.get(scope) ?? 0) + 1); },
        registrations: {},
        start: () => undefined,
      };
    },
    scope,
  });
  const initial = defineReloadableNodeGraph([
    node({ children: [node({ scope: "server:core" })], scope: "server:turns" }),
    harness("harness:codex"),
    harness("harness:opencode"),
  ]);
  const replacement = defineReloadableNodeGraph([
    node({ children: [node({ scope: "server:core" }), node({ scope: "server:added" })], scope: "server:turns" }),
    harness("harness:codex"),
    harness("harness:opencode"),
  ]);
  const host = new ReloadableNodeHost(null, loader(initial, replacement));
  await host.start();
  await host.reload(["server:topology"]);

  assert.deepEqual(Object.fromEntries(harnessCreates), { "harness:codex": 1, "harness:opencode": 1 });
  assert.deepEqual(Object.fromEntries(harnessDisposes), {});
  await host.dispose();
});

test("topology replacement publishes complete candidates and gates new work until its owner starts", async () => {
  let finishChildStart!: () => void;
  let reportChildStart!: () => void;
  const childCanFinish = new Promise<void>((resolve) => { finishChildStart = resolve; });
  const childStarted = new Promise<void>((resolve) => { reportChildStart = resolve; });
  let host!: ReloadableNodeHost<null, Objects, never>;
  const liveParent = node({
    create: () => ({ dispose: () => undefined, registrations: { a: "live" }, start: () => undefined }),
    provides: ["a"],
    scope: "server:a",
  });
  const candidateChild = node({
    create: () => ({
      dispose: () => undefined,
      registrations: { child: "candidate child" },
      start: async () => {
        reportChildStart();
        await childCanFinish;
      },
    }),
    provides: ["child"],
    scope: "server:child",
  });
  const candidateParent = node({
    children: [candidateChild],
    create: () => ({
      dispose: () => undefined,
      registrations: { a: "candidate", b: "candidate parent" },
      start: () => { assert.equal(host.get("a"), "candidate"); },
    }),
    provides: ["a", "b"],
    scope: "server:a",
  });
  host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([liveParent]),
    defineReloadableNodeGraph([candidateParent]),
  ));
  await host.start();

  const reload = host.reload(["server:topology"]);
  await childStarted;
  assert.equal(host.get("a"), "candidate");
  let operationSettled = false;
  const operation = host.run("child", (value) => value).finally(() => { operationSettled = true; });
  await Promise.resolve();
  assert.equal(operationSettled, false);

  finishChildStart();
  await reload;
  assert.equal(await operation, "candidate child");
});

test("topology replacement releases retired waiters only after the complete candidate starts", async () => {
  let finishCandidateStart!: () => void;
  let finishLiveDetach!: () => void;
  let reportCandidateStart!: () => void;
  let reportLiveDetach!: () => void;
  const candidateCanFinish = new Promise<void>((resolve) => { finishCandidateStart = resolve; });
  const candidateStarted = new Promise<void>((resolve) => { reportCandidateStart = resolve; });
  const liveCanDetach = new Promise<void>((resolve) => { finishLiveDetach = resolve; });
  const liveDetachStarted = new Promise<void>((resolve) => { reportLiveDetach = resolve; });
  const state = { value: "transferred" };
  const liveParent = node({
    create: () => {
      let detached = false;
      return {
        detachForReload: async () => {
          reportLiveDetach();
          await liveCanDetach;
          detached = true;
          return state;
        },
        dispose: () => { assert.equal(detached, true); },
        registrations: { a: "live" },
        start: () => undefined,
      };
    },
    lifecycle: "handoff",
    provides: ["a"],
    scope: "server:a",
  });
  const candidateParent = node({
    create: (_context, build) => {
      assert.equal(build.handoffState, state);
      return {
        detachForReload: () => state,
        dispose: () => undefined,
        registrations: { a: "candidate", b: "candidate parent" },
        start: async () => {
          reportCandidateStart();
          await candidateCanFinish;
        },
      };
    },
    lifecycle: "handoff",
    provides: ["a", "b"],
    scope: "server:a",
  });
  const host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([liveParent]),
    defineReloadableNodeGraph([candidateParent]),
  ));
  await host.start();

  const reload = host.reload(["server:topology"]);
  await liveDetachStarted;
  let waiterSettled = false;
  const waiter = host.run("a", (value) => value).finally(() => { waiterSettled = true; });
  finishLiveDetach();
  await candidateStarted;
  await Promise.resolve();
  assert.equal(waiterSettled, false);

  finishCandidateStart();
  await reload;
  assert.equal(await waiter, "candidate");
});

test("handoff replacement bounds retired disposal while keeping the candidate graph active", async () => {
  let expireRetirement!: () => void;
  let finishLiveDisposal!: () => void;
  let reportLiveDisposal!: () => void;
  const liveDisposalFinished = new Promise<void>((resolve) => { finishLiveDisposal = resolve; });
  const liveDisposalStarted = new Promise<void>((resolve) => { reportLiveDisposal = resolve; });
  const deadlines: Array<{ cancel(): void; expire(): void; expired: Promise<void> }> = [];
  const child = (value: string) => node({
    create: () => ({
      detachForReload: () => ({ value }),
      dispose: () => undefined,
      registrations: { child: value },
      start: () => undefined,
    }),
    lifecycle: "handoff",
    provides: ["child"],
    scope: "server:child",
  });
  const liveParent = node({
    children: [child("live child")],
    create: () => ({
      dispose: async (reportPhase) => {
        reportPhase("thread-state disposal");
        reportLiveDisposal();
        await liveDisposalFinished;
      },
      registrations: { a: "live" },
      start: () => undefined,
    }),
    provides: ["a"],
    scope: "server:a",
  });
  const candidateParent = node({
    children: [child("candidate child")],
    create: () => ({
      dispose: () => undefined,
      registrations: { a: "candidate" },
      start: () => undefined,
    }),
    provides: ["a"],
    scope: "server:a",
  });
  const host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([liveParent]),
    defineReloadableNodeGraph([candidateParent]),
  ), {
    createRuntimeDrainDeadline: () => {
      let expire!: () => void;
      const expired = new Promise<void>((resolve) => { expire = resolve; });
      const deadline = { cancel: () => undefined, expire, expired };
      deadlines.push(deadline);
      expireRetirement = expire;
      return deadline;
    },
    runtimeDrainTimeoutMs: 30_000,
  });
  await host.start();

  const reload = host.reload(["server:a"]);
  await liveDisposalStarted;
  assert.equal(deadlines.length, 2);
  expireRetirement();

  await assert.rejects(
    reload,
    /New feature nodes are active, but runtime drain exceeded 30000ms.*server:a: thread-state disposal/u,
  );
  assert.equal(host.get("a"), "candidate");
  assert.equal(host.get("child"), "candidate child");

  finishLiveDisposal();
  await Promise.resolve();
  await host.dispose();
});

test("failed topology startup preserves handoff state and releases waiters after restoration starts", async () => {
  let finishCandidateStart!: () => void;
  let finishRestoredStart!: () => void;
  let reportCandidateStart!: () => void;
  let reportRestoredStart!: () => void;
  const candidateCanFail = new Promise<void>((resolve) => { finishCandidateStart = resolve; });
  const candidateStarted = new Promise<void>((resolve) => { reportCandidateStart = resolve; });
  const restoredCanFinish = new Promise<void>((resolve) => { finishRestoredStart = resolve; });
  const restoredStarted = new Promise<void>((resolve) => { reportRestoredStart = resolve; });
  const startupFailure = new Error("candidate start failed");
  const state = { destroyed: false, transfers: 0 };
  let host!: ReloadableNodeHost<null, Objects, never>;
  const liveParent = node({
    create: (_context, build) => {
      const restored = build.mode === "restore";
      let detached = false;
      return {
        detachForReload: () => {
          detached = true;
          state.transfers += 1;
          return state;
        },
        dispose: () => { if (!detached) state.destroyed = true; },
        registrations: { a: restored ? "restored" : "live" },
        start: async () => {
          if (!restored) return;
          assert.equal(build.handoffState, state);
          assert.equal(host.get("a"), "restored");
          reportRestoredStart();
          await restoredCanFinish;
        },
      };
    },
    lifecycle: "handoff",
    provides: ["a"],
    scope: "server:a",
  });
  const candidateParent = node({
    create: (_context, build) => {
      assert.equal(build.handoffState, state);
      let detached = false;
      return {
        detachForReload: () => {
          detached = true;
          state.transfers += 1;
          return state;
        },
        dispose: () => { if (!detached) state.destroyed = true; },
        registrations: { a: "candidate", b: "candidate parent" },
        start: async () => {
          reportCandidateStart();
          await candidateCanFail;
          throw startupFailure;
        },
      };
    },
    lifecycle: "handoff",
    provides: ["a", "b"],
    scope: "server:a",
  });
  host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([liveParent]),
    defineReloadableNodeGraph([candidateParent]),
  ));
  await host.start();

  const reload = host.reload(["server:topology"]);
  await candidateStarted;
  let waiterSettled = false;
  const waiter = host.run("a", (value) => value).finally(() => { waiterSettled = true; });
  await Promise.resolve();
  assert.equal(waiterSettled, false);

  finishCandidateStart();
  await restoredStarted;
  await Promise.resolve();
  assert.equal(waiterSettled, false);

  finishRestoredStart();
  await assert.rejects(reload, (error) => error === startupFailure);
  assert.equal(await waiter, "restored");
  assert.equal(state.destroyed, false);
  assert.equal(state.transfers, 2);
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
  assert.deepEqual(host.getReloadScopesForPaths(["daemon/orchestrator/index.ts"]), ["server:process"]);
});
