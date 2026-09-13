/*
 * No production exports. Node tests protect parent-owned topology ordering, shared-child identity, candidate validation, gated topology publication, waiter transfer, and rollback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import ReloadableNode, { defineReloadableNodeGraph, type ReloadableNodeGraph, type ReloadableNodeHandoff } from "./ReloadableNode";
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

function handoff(overrides: Partial<ReloadableNodeHandoff> = {}): ReloadableNodeHandoff {
  return {
    waitForIdle: async () => undefined,
    expire: () => undefined,
    detach: () => undefined,
    resume: () => undefined,
    commit: () => undefined,
    ...overrides,
  };
}

test("terminal shutdown reaches resource owners without waiting for caller leases", async () => {
  let release!: () => void;
  let entered!: () => void;
  let forced = false;
  let disposed = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const graph = defineReloadableNodeGraph([node({
    scope: "server:a", provides: ["a"],
    create: () => ({
      registrations: { a: "value" }, start() {},
      shutdown() { forced = true; },
      dispose() { disposed = true; },
    }),
  })]);
  const host = new ReloadableNodeHost(null, loader(graph, graph));
  await host.start();
  const work = host.run("a", async () => { entered(); await pending; });
  await admitted;
  const closing = host.dispose();
  try {
    assert.equal(forced, true, "Shutdown must request child retirement before awaiting blocked work");
    await closing;
    assert.equal(disposed, true);
    await assert.rejects(host.run("a", value => value), /shutting down/u);
  } finally {
    release();
    await work;
    await closing;
  }
});

test("shutdown cancels initial startup and prevents late activation", async () => {
  let enter!: () => void;
  let release!: () => void;
  let activated = false;
  let startSignal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const graph = defineReloadableNodeGraph([node({
    scope: "server:a",
    create: () => ({
      registrations: {},
      async start(_phase, signal) { startSignal = signal; enter(); await pending; },
      activate() { activated = true; },
      dispose() {},
    }),
  })]);
  const host = new ReloadableNodeHost(null, loader(graph, graph));
  const starting = host.start();
  const settled = starting.then(() => null, error => error);
  await entered;
  const closing = host.dispose();
  try {
    assert.equal(startSignal?.aborted, true, "Closing must cancel the owner that is still starting");
  } finally { release(); }
  assert.ok(await settled instanceof Error);
  await closing;
  assert.equal(activated, false);
});

test("shutdown reaches a replacement owner before its startup publishes the candidate", async () => {
  let enter!: () => void;
  let release!: () => void;
  let forced = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const graph = defineReloadableNodeGraph([node({
    scope: "server:a",
    create: (_context, build) => ({
      registrations: {},
      async start() { if (build.mode === "replacement") { enter(); await pending; } },
      shutdown() { if (build.mode === "replacement") { forced = true; release(); } },
      dispose() {},
    }),
  })]);
  const host = new ReloadableNodeHost(null, loader(graph, graph));
  await host.start();
  const replacing = host.reload(["server:a"]).then(() => null, error => error);
  await entered;
  const closing = host.dispose();
  try {
    assert.equal(forced, true, "A starting candidate must already belong to shutdown");
  } finally { release(); await replacing; await closing; }
});

test("reload publishes without waiting for native retirement but shutdown still owns that generation", async () => {
  let release!: () => void;
  let retired = false;
  let stoppedOldOwner = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let generation = 0;
  const graph = () => {
    const current = generation++;
    return defineReloadableNodeGraph([node({
      scope: "server:a", provides: ["a"], lifecycle: "handoff",
      create: () => ({
        registrations: { a: String(current) },
        start() {}, dispose() {},
        shutdown() { if (current === 0) { stoppedOldOwner = true; release(); } },
        beginHandoff: () => handoff({
          commit: async () => { await pending; retired = true; },
        }),
      }),
    })]);
  };
  const host = new ReloadableNodeHost(null, { load: graph, reload: graph });
  await host.start();
  try {
    await host.reload(["server:a"]);
    assert.equal(await host.run("a", value => value), "1");
    assert.equal(retired, false, "Reload completion cannot be native process cleanup completion");
    await host.dispose();
    assert.equal(stoppedOldOwner, true);
    assert.equal(retired, true);
  } finally { release(); await host.dispose(); }
});

test("failed activation preserves the old branch and permits a later replacement", async () => {
  let oldDisposed = false;
  let rejectActivation = true;
  const initial = defineReloadableNodeGraph([node({
    scope: "server:a",
    provides: ["a"],
    create: () => ({
      registrations: { a: "old" },
      start: () => undefined,
      dispose: () => { oldDisposed = true; },
    }),
  })]);
  const replacement = () => defineReloadableNodeGraph([node({
    scope: "server:a",
    provides: ["a"],
    create: () => ({
      registrations: { a: "replacement" },
      start: () => undefined,
      activate: () => { if (rejectActivation) throw new Error("candidate activation rejected"); },
      dispose: () => undefined,
    }),
  })]);
  const host = new ReloadableNodeHost(null, { load: () => initial, reload: replacement });
  await host.start();
  await assert.rejects(host.reload(["server:a"]), /candidate activation rejected/u);
  assert.equal(oldDisposed, false, "rollback must retain the actual old owner");
  assert.equal(await host.run("a", (value) => value), "old");
  rejectActivation = false;
  await host.reload(["server:a"]);
  assert.equal(await host.run("a", (value) => value), "replacement");
  assert.equal(oldDisposed, true);
  await host.dispose();
});

test("grace expiry retires old work without cancelling replacement or the next reload", async () => {
  let enter!: () => void;
  let release!: () => void;
  let beginDrain!: () => void;
  let expire!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const draining = new Promise<void>((resolve) => { beginDrain = resolve; });
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  let generation = 0;
  let forced = 0;
  const graph = () => {
    const version = generation++;
    return defineReloadableNodeGraph([node({
      scope: "server:a",
      provides: ["a"],
      create: () => ({
        registrations: { a: String(version) },
        start: () => undefined,
        beginRuntimeDrain: () => { if (version === 0) beginDrain(); },
        expireRuntimeDrain: () => { if (version === 0) forced += 1; },
        dispose: () => undefined,
      }),
    })]);
  };
  const host = new ReloadableNodeHost(null, { load: graph, reload: graph }, {
    createRuntimeDrainDeadline: () => ({ cancel: () => undefined, expired }),
  });
  await host.start();
  const oldWork = host.run("a", async () => { enter(); await pending; });
  await entered;
  const replacing = host.reload(["server:a"]);
  try {
    await draining;
    expire();
    await replacing;
    assert.equal(forced, 1);
    assert.equal(await host.run("a", (value) => value), "1");
    await host.reload(["server:a"]);
    assert.equal(await host.run("a", (value) => value), "2");
  } finally {
    release();
    await oldWork;
  }
});

test("a rolled-back owner expires fresh work again on the next replacement attempt", async () => {
  let forced = 0;
  let fail = true;
  const graph = defineReloadableNodeGraph([node({
    scope: "server:a", provides: ["a"], lifecycle: "handoff",
    create: (_context, build) => ({
      registrations: { a: build.mode },
      start: () => { if (build.mode === "replacement" && fail) throw new Error("candidate rejected"); },
      beginHandoff: () => handoff({
        waitForIdle: () => new Promise<void>(() => {}),
        expire: () => { forced++; },
      }),
      dispose: () => {},
    }),
  })]);
  const host = new ReloadableNodeHost(null, loader(graph, graph), {
    createRuntimeDrainDeadline: () => ({ cancel() {}, expired: Promise.resolve() }),
  });
  await host.start();
  try {
    await assert.rejects(host.reload(["server:a"]), /candidate rejected/);
    assert.equal(await host.run("a", value => value), "initial");
    fail = false;
    await host.reload(["server:a"]);
    assert.equal(forced, 2);
    assert.equal(await host.run("a", value => value), "replacement");
  } finally { await host.dispose(); }
});

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
  assert.deepEqual(events, ["start new parent", "start new child", "dispose old child", "dispose old parent"]);
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

test("topology replacement keeps candidates private until the complete branch is ready", async () => {
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
      start: () => { assert.equal(host.get("a"), "live"); },
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
  assert.equal(host.get("a"), "live");
  assert.throws(() => host.get("child"), /unavailable/u);
  assert.equal(await host.run("a", (value) => value), "live");

  finishChildStart();
  await reload;
  assert.equal(await host.run("child", (value) => value), "candidate child");
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
        beginHandoff: () => handoff({
          detach: async () => {
            reportLiveDetach();
            await liveCanDetach;
            detached = true;
            return state;
          },
          resume: () => { detached = false; },
          commit: () => { assert.equal(detached, true); },
        }),
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
        beginHandoff: () => handoff({ detach: () => state }),
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

test("an issued durability barrier survives grace expiry without cancelling the active candidate", async () => {
  let expireRetirement!: () => void;
  let finishLiveDisposal!: () => void;
  let reportLiveDisposal!: () => void;
  const liveDisposalFinished = new Promise<void>((resolve) => { finishLiveDisposal = resolve; });
  const liveDisposalStarted = new Promise<void>((resolve) => { reportLiveDisposal = resolve; });
  const deadlines: Array<{ cancel(): void; expire(): void; expired: Promise<void> }> = [];
  const child = (value: string) => node({
    create: () => ({
      beginHandoff: () => handoff({ detach: () => ({ value }) }),
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
  expireRetirement();

  assert.equal(host.get("a"), "candidate");
  assert.equal(host.get("child"), "candidate child");

  finishLiveDisposal();
  await reload;
  await host.dispose();
});

test("failed topology startup resumes the retained owner before releasing its waiters", async () => {
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
    create: () => {
      let detached = false;
      return {
        beginHandoff: () => handoff({
          detach: () => {
            detached = true;
            state.transfers += 1;
            return state;
          },
          resume: async () => {
            assert.equal(host.get("a"), "live");
            reportRestoredStart();
            await restoredCanFinish;
            detached = false;
          },
        }),
        dispose: () => { if (!detached) state.destroyed = true; },
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
        beginHandoff: () => handoff({ detach: () => state }),
        dispose: () => undefined,
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
  assert.equal(await waiter, "live");
  assert.equal(state.destroyed, false);
  assert.equal(state.transfers, 1);
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

test("topology replacement activates the successor before retiring live atomic owners", async () => {
  let executor = "live";
  const events: string[] = [];
  const live = node({
    create: () => ({
      dispose: () => { events.push("retire"); assert.equal(executor, "candidate"); },
      registrations: { a: "live" },
      start: () => undefined,
    }),
    provides: ["a"],
    scope: "server:a",
  });
  const candidate = node({
    create: () => ({
      activate: () => { executor = "candidate"; events.push("activate"); },
      dispose: () => undefined,
      registrations: { a: "candidate", b: "extra" },
      start: () => { assert.equal(executor, "live"); },
    }),
    provides: ["a", "b"],
    scope: "server:a",
  });
  const host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([live]), defineReloadableNodeGraph([candidate]),
  ));
  await host.start();
  await host.reload(["server:topology"]);
  assert.deepEqual(events, ["activate", "retire"]);
  await host.dispose();
});

for (const mode of ["atomic", "handoff", "topology"] as const) {
  test(`${mode} startup failure retains the old branch and permits retry`, async () => {
    let failStartup = true;
    let oldDisposed = false;
    let activated = false;
    const live = node({
      create: () => ({
        beginHandoff: () => handoff({ commit: () => { oldDisposed = true; } }),
        dispose: () => { oldDisposed = true; },
        registrations: { a: "live" },
        start: () => undefined,
      }),
      lifecycle: mode === "handoff" ? "handoff" : "atomic",
      provides: ["a"],
      scope: "server:a",
    });
    const candidate = node({
      create: () => ({
        activate: () => { activated = true; },
        beginHandoff: () => handoff(),
        dispose: () => undefined,
        registrations: mode === "topology" ? { a: "candidate", b: "extra" } : { a: "candidate" },
        start: () => { if (failStartup) throw new Error("candidate startup rejected"); },
      }),
      lifecycle: mode === "handoff" ? "handoff" : "atomic",
      provides: mode === "topology" ? ["a", "b"] : ["a"],
      scope: "server:a",
    });
    const host = new ReloadableNodeHost(null, loader(
      defineReloadableNodeGraph([live]), defineReloadableNodeGraph([candidate]),
    ));
    await host.start();
    const reload = host.reload([mode === "topology" ? "server:topology" : "server:a"]);
    await assert.rejects(reload, /candidate startup rejected/u);
    assert.equal(activated, false);
    assert.equal(oldDisposed, false);
    assert.equal(await host.run("a", (value) => value), "live");
    failStartup = false;
    await host.reload([mode === "topology" ? "server:topology" : "server:a"]);
    assert.equal(await host.run("a", (value) => value), "candidate");
    assert.equal(oldDisposed, true);
    await host.dispose();
  });
}

test("expiry before detach forces handoff and leaves the next reload available", async () => {
  let finishWork!: () => void;
  let expire!: () => void;
  let reportWork!: () => void;
  let reportDrain!: () => void;
  const workFinished = new Promise<void>((resolve) => { finishWork = resolve; });
  const workStarted = new Promise<void>((resolve) => { reportWork = resolve; });
  const drainStarted = new Promise<void>((resolve) => { reportDrain = resolve; });
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  let generation = 0;
  let forced = 0;
  const parent = node({
    create: () => ({
      beginHandoff: () => handoff({
        waitForIdle: async () => { reportDrain(); await workFinished; },
        expire: () => { forced += 1; },
      }),
      dispose: () => undefined,
      registrations: { a: String(++generation) }, start: () => undefined,
    }),
    lifecycle: "handoff", provides: ["a"], scope: "server:a",
  });
  const graph = defineReloadableNodeGraph([parent]);
  const host = new ReloadableNodeHost(null, loader(graph, graph), {
    createRuntimeDrainDeadline: () => ({ cancel: () => undefined, expired }),
  });
  await host.start();
  const work = host.run("a", async () => { reportWork(); await workFinished; });
  await workStarted;
  const reload = host.reload(["server:a"]);
  try {
    await drainStarted;
    expire();
    await reload;
    assert.equal(forced, 1);
    assert.equal(await host.run("a", (value) => value), "2");
    await host.reload(["server:a"]);
    assert.equal(await host.run("a", (value) => value), "3");
  } finally {
    finishWork();
    await work;
  }
});

test("failed retirement is reported without poisoning the committed graph or a later reload", async () => {
  const failure = new Error("retired resource did not close");
  const logs: string[] = [];
  const live = node({
    create: () => ({
      dispose: () => { throw failure; }, registrations: { a: "old" }, start: () => undefined,
    }),
    provides: ["a"], scope: "server:a",
  });
  const replacement = node({
    create: () => ({
      dispose: () => undefined, registrations: { a: "new" }, start: () => undefined,
    }),
    provides: ["a"], scope: "server:a",
  });
  const host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([live]), defineReloadableNodeGraph([replacement]),
  ), { logError: (message) => { logs.push(message); } });
  await host.start();
  await host.reload(["server:a"]);
  assert.equal(await host.run("a", (value) => value), "new");
  assert.ok(logs.some((message) => message.includes(failure.message)));
  await host.reload(["server:a"]);
  assert.equal(await host.run("a", (value) => value), "new");
});

test("a gated request follows its registration when topology changes its owner", async () => {
  let reportDetach!: () => void;
  let finishDetach!: () => void;
  const detaching = new Promise<void>((resolve) => { reportDetach = resolve; });
  const detached = new Promise<void>((resolve) => { finishDetach = resolve; });
  const live = node({
    create: () => ({
      beginHandoff: () => handoff({ detach: async () => { reportDetach(); await detached; return {}; } }),
      dispose: () => undefined, registrations: { a: "old" }, start: () => undefined,
    }),
    lifecycle: "handoff", provides: ["a"], scope: "server:a",
  });
  const replacement = node({
    create: () => ({
      dispose: () => undefined, registrations: { a: "new" }, start: () => undefined,
    }),
    provides: ["a"], scope: "server:b",
  });
  const host = new ReloadableNodeHost(null, loader(
    defineReloadableNodeGraph([live]), defineReloadableNodeGraph([replacement]),
  ));
  await host.start();
  const reload = host.reload(["server:topology"]);
  await detaching;
  const request = host.run("a", (value) => value);
  finishDetach();
  await reload;
  assert.equal(await request, "new");
  await host.dispose();
});
