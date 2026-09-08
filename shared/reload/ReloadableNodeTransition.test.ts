/*
 * Keywords: reload, deadline, detach, activation, retirement, rollback.
 * No exports. Controlled lifecycle hooks prove transition expiry without wall-clock timers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ReloadableNode, { defineReloadableNodeGraph } from "./ReloadableNode";
import ReloadableNodeHost from "./ReloadableNodeHost";
import ReloadableNodeTransition from "./ReloadableNodeTransition";

interface Objects { value: string; extra: string }

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

for (const route of ["atomic", "handoff", "topology", "restore"] as const) {
  test(`${route} startup reports its blocked inner operation`, async () => {
    const entered = signal();
    const finish = signal();
    const deadline = signal();
    const detail = `blocked ${route} dependency`;
    const definition = (replacement: boolean) => new ReloadableNode<null, Objects, never>({
      access: "agent", children: [], description: "test owner", safeAll: true,
      lifecycle: route === "atomic" ? "atomic" : "handoff",
      scope: "server:unit", sources: "unit.ts", requires: [],
      provides: replacement && route === "topology" ? ["value", "extra"] : ["value"],
      create: (_context, build) => ({
        registrations: replacement && route === "topology" ? { value: "new", extra: "new" } : { value: "old" },
        detachForReload: () => ({}),
        dispose: () => undefined,
        start: async (reportPhase?: (phase: string) => void) => {
          if (build.mode === "initial") return;
          if (route === "restore" && build.mode === "replacement") throw new Error("candidate rejected");
          reportPhase?.(detail);
          entered.resolve();
          await finish.promise;
        },
      }),
    });
    const host = new ReloadableNodeHost(null, {
      load: () => defineReloadableNodeGraph([definition(false)]),
      reload: () => defineReloadableNodeGraph([definition(true)]),
    }, {
      topologyScope: "server:topology",
      createRuntimeDrainDeadline: () => ({ cancel: () => undefined, expired: deadline.promise }),
    });
    await host.start();
    const reload = host.reload([route === "topology" ? "server:topology" : "server:unit"]);
    const rejected = assert.rejects(reload, (error: Error) => (
      error.message.includes("server:unit") && error.message.includes(detail)
    ));
    await entered.promise;
    deadline.resolve();
    try {
      await rejected;
    } finally {
      finish.resolve();
    }
  });
}

test("a previous reload's startup reporter cannot replace the current diagnostic", async () => {
  const entered = signal();
  const finish = signal();
  const deadlines: Array<ReturnType<typeof signal>> = [];
  let oldReport: ((phase: string) => void) | undefined;
  let generation = 0;
  const graph = () => defineReloadableNodeGraph([new ReloadableNode<null, Objects, never>({
    access: "agent", children: [], description: "test owner", safeAll: true,
    lifecycle: "atomic", scope: "server:unit", sources: "unit.ts", requires: [], provides: ["value"],
    create: () => {
      const version = generation++;
      return {
        registrations: { value: String(version) },
        dispose: () => undefined,
        start: async (reportPhase?: (phase: string) => void) => {
          if (version === 1) oldReport = reportPhase;
          if (version !== 2) return;
          reportPhase?.("current dependency");
          oldReport?.("retired dependency");
          entered.resolve();
          await finish.promise;
        },
      };
    },
  })]);
  const host = new ReloadableNodeHost(null, { load: graph, reload: graph }, {
    topologyScope: "server:topology",
    createRuntimeDrainDeadline: () => {
      const deadline = signal();
      deadlines.push(deadline);
      return { cancel: () => undefined, expired: deadline.promise };
    },
  });
  await host.start();
  await host.reload(["server:unit"]);
  const rejected = assert.rejects(host.reload(["server:unit"]), (error: Error) => (
    error.message.includes("current dependency") && !error.message.includes("retired dependency")
  ));
  await entered.promise;
  deadlines[1]!.resolve();
  try {
    await rejected;
  } finally {
    finish.resolve();
  }
});

test("failed diagnostics cannot suppress the transition deadline", async () => {
  let expire!: () => void;
  let finishHook!: () => void;
  let reportStarted!: () => void;
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  const finish = new Promise<void>((resolve) => { finishHook = resolve; });
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const transition = new ReloadableNodeTransition(
    { cancel: () => undefined, expired }, 30_000,
    () => { throw new Error("diagnostic owner failed"); }, () => undefined,
  );
  const executing = transition.execute(async () => {
    await transition.step("server:unit: start", async () => { reportStarted(); await finish; });
  });
  const rejected = assert.rejects(executing, /exceeded.*server:unit: start/u);
  await started;
  expire();
  await Promise.resolve();
  finishHook();
  await rejected;
  transition.finish();
});

for (const phase of ["detach", "activate", "dispose", "restore"] as const) {
  test(`topology ${phase} expiry is terminal and names the blocked lifecycle`, async () => {
    let reportEntered!: () => void;
    let finishHook!: () => void;
    let expire!: () => void;
    const entered = new Promise<void>((resolve) => { reportEntered = resolve; });
    const finish = new Promise<void>((resolve) => { finishHook = resolve; });
    const expired = new Promise<void>((resolve) => { expire = resolve; });
    const block = async () => { reportEntered(); await finish; };
    let lateActivation = false;
    const definition = (replacement: boolean) => new ReloadableNode<null, Objects, never>({
      access: "agent", children: [], description: "test owner", safeAll: true,
      lifecycle: "handoff", scope: "server:unit", sources: "unit.ts", requires: [],
      provides: replacement ? ["value", "extra"] : ["value"],
      create: (_context, build) => ({
        registrations: replacement ? { value: "new", extra: "new" } : { value: "old" },
        detachForReload: async () => {
          if (!replacement && build.mode !== "restore" && phase === "detach") await block();
          return {};
        },
        start: async () => {
          if (replacement && phase === "restore") throw new Error("candidate rejected");
          if (build.mode === "restore") await block();
        },
        activate: async () => {
          if (replacement && phase === "activate") await block();
          if (replacement) lateActivation = true;
        },
        dispose: async () => {
          if (!replacement && phase === "dispose") await block();
        },
      }),
    });
    const initial = defineReloadableNodeGraph([definition(false)]);
    const replacement = defineReloadableNodeGraph([definition(true)]);
    const host = new ReloadableNodeHost(null, { load: () => initial, reload: () => replacement }, {
      topologyScope: "server:topology",
      createRuntimeDrainDeadline: () => ({ cancel: () => undefined, expired }),
    });
    await host.start();
    const reload = host.reload(["server:topology"]);
    const rejected = assert.rejects(reload, (error: Error) => (
      /exceeded/u.test(error.message)
      && error.message.includes("server:unit")
      && error.message.includes(phase === "restore" ? "start" : phase)
    ));
    await entered;
    expire();
    await Promise.resolve();
    finishHook();
    await rejected;
    // An already running hook may finish, but the host must not launch a later phase.
    if (phase === "detach" || phase === "restore") assert.equal(lateActivation, false);
    await assert.rejects(host.reload(["server:unit"]), /reload|transition/u);
    if (phase === "dispose") assert.equal(await host.run("value", (value) => value), "new");
    else await assert.rejects(host.run("value", (value) => value), /reload|transition/u);
  });
}
