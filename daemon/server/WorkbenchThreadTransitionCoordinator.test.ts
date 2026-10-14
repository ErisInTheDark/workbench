/* No production exports. Tests protect keyed transition serialization, cross-key concurrency, failure recovery, queue cleanup, reentrancy, and deadlock refusal. */
import assert from "node:assert/strict";
import test from "node:test";

import { createWorktreeGitTransitions } from "./worktree-git-transitions";
import WorkbenchThreadTransitionCoordinator, {
  TransitionLeaseDeadlockError,
  TransitionLeaseUpgradeError,
} from "./WorkbenchThreadTransitionCoordinator";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
}

/** Lets queued acquisitions reach the coordinator before the test inspects it. */
async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

test("normalizes one canonical worktree Git transition key before persistent coordination", async () => {
  const keys: string[] = [];
  const transitions = createWorktreeGitTransitions({
    read: async (key, operation) => {
      keys.push(`read:${key}`);
      return await operation();
    },
    readMany: async (readKeys, operation) => {
      keys.push(`readMany:${readKeys.join(",")}`);
      return await operation();
    },
    run: async (key, operation) => {
      keys.push(`run:${key}`);
      return await operation();
    },
    runMany: async (writeKeys, operation) => {
      keys.push(`runMany:${writeKeys.join(",")}`);
      return await operation();
    },
  }, "win32");
  await transitions.read(" C:\\Git\\Project\\ ", async () => undefined);
  await transitions.run(" C:\\Git\\Project\\ ", async () => undefined);
  await transitions.readMany(["c:/git/project", "C:\\Git\\Other"], async () => undefined);
  await transitions.runMany(["c:/git/project", "C:\\Git\\Other"], async () => undefined);
  assert.deepEqual(keys, [
    "read:git-worktree\0c:/git/project",
    "run:git-worktree\0c:/git/project",
    "readMany:git-worktree\0c:/git/other,git-worktree\0c:/git/project",
    "runMany:git-worktree\0c:/git/other,git-worktree\0c:/git/project",
  ]);
  await assert.rejects(transitions.run("  ", async () => undefined), /worktree path is required/u);
});

test("falls back to exclusive reads until the process-stable coordinator restarts", async () => {
  const keys: string[] = [];
  const transitions = createWorktreeGitTransitions({
    run: async (key, operation) => {
      keys.push(`run:${key}`);
      return await operation();
    },
    runMany: async (writeKeys, operation) => {
      keys.push(`runMany:${writeKeys.join(",")}`);
      return await operation();
    },
  }, "win32");

  await transitions.read("C:/Git/Project", async () => undefined);
  await transitions.readMany(["C:/Git/Project"], async () => undefined);
  assert.deepEqual(keys, [
    "run:git-worktree\0c:/git/project",
    "runMany:git-worktree\0c:/git/project",
  ]);
});

test("shares reads, queues writers fairly, and allows unrelated keys to proceed", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const events: string[] = [];
  let releaseReaders = () => undefined;
  const readerGate = new Promise<void>((resolve) => { releaseReaders = resolve; });

  const first = coordinator.read("repo", async () => {
    events.push("read-one:start");
    await readerGate;
    events.push("read-one:end");
  });
  const second = coordinator.read("repo", async () => {
    events.push("read-two:start");
    await readerGate;
    events.push("read-two:end");
  });
  const writer = coordinator.run("repo", async () => {
    events.push("writer");
  });
  const lateReader = coordinator.read("repo", async () => {
    events.push("read-late");
  });
  const unrelated = coordinator.run("other", async () => {
    events.push("unrelated");
  });

  await unrelated;
  assert.deepEqual(events, ["read-one:start", "read-two:start", "unrelated"]);
  releaseReaders();
  await Promise.all([first, second, writer, lateReader]);
  assert.deepEqual(events, [
    "read-one:start", "read-two:start", "unrelated",
    "read-one:end", "read-two:end", "writer", "read-late",
  ]);
});

test("worktree case aliases serialize on Windows and remain independent on Linux", async () => {
  for (const platform of ["win32", "linux"] as const) {
    const transitions = createWorktreeGitTransitions(new WorkbenchThreadTransitionCoordinator(), platform);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = transitions.run("/work/Repo", async () => { entered(); await gate; });
    await started;
    let aliasEntered = false;
    const alias = transitions.read("/work/repo", async () => { aliasEntered = true; });
    try {
      await transitions.run("/work/other", async () => undefined);
      assert.equal(aliasEntered, platform === "linux");
    } finally {
      release();
      await Promise.all([held, alias]);
    }
  }
});

test("continues a transition queue after a failed operation", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  await assert.rejects(coordinator.read("thread", async () => {
    throw new Error("failed transition");
  }), /failed transition/u);
  assert.equal(await coordinator.run("thread", async () => "recovered"), "recovered");
});

test("readMany and runMany deduplicate and acquire transition keys in stable order", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const events: string[] = [];
  let releaseA = () => undefined;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const heldA = coordinator.run("a", async () => {
    events.push("a:held");
    await gateA;
  });
  await Promise.resolve();

  const combinedRead = coordinator.readMany(["z", "a", "z"], async () => {
    events.push("combined-read");
  });
  const probeZ = coordinator.run("z", async () => {
    events.push("z:free");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["a:held", "z:free"]);

  releaseA();
  await Promise.all([heldA, combinedRead, probeZ]);
  assert.deepEqual(events, ["a:held", "z:free", "combined-read"]);

  await coordinator.runMany(["z", "a", "z"], async () => {
    events.push("combined-write");
  });
  assert.equal(events.at(-1), "combined-write");
});

test("a flow reenters a key it holds even when a writer queued in between", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const inner = gate();
  const events: string[] = [];
  const outer = coordinator.read("repo", async () => {
    await inner.promise;
    await coordinator.read("repo", async () => { events.push("nested read"); });
    await Promise.all([1, 2].map(async index => await coordinator.read("repo", async () => { events.push(`child ${index}`); })));
  });
  await settle();
  const writer = coordinator.run("repo", async () => { events.push("writer"); });
  await settle();
  inner.open();
  await Promise.all([outer, writer]);
  assert.deepEqual(events, ["nested read", "child 1", "child 2", "writer"]);
  assert.deepEqual(coordinator.snapshot(), []);

  await coordinator.run("repo", async () => {
    await coordinator.run("repo", async () => { events.push("nested write"); });
    await coordinator.read("repo", async () => { events.push("read under write"); });
  });
  assert.deepEqual(events.slice(-2), ["nested write", "read under write"]);
});

test("a reloaded coordinator keeps the retiring generation's leases exclusive and reentrant", async () => {
  const retiring = new WorkbenchThreadTransitionCoordinator();
  const held = gate();
  const inside = gate();
  const events: string[] = [];
  let successor!: WorkbenchThreadTransitionCoordinator;
  const oldWrite = retiring.run("repo", async () => {
    inside.open();
    await held.promise;
    await successor.read("repo", async () => { events.push("old flow reentered through successor"); });
    events.push("old write done");
  });
  await inside.promise;
  successor = new WorkbenchThreadTransitionCoordinator({ initialState: retiring.detachForReload() });
  const newRead = successor.read("repo", async () => { events.push("new read"); });
  await settle();
  assert.deepEqual(events, [], "The successor must wait for the retiring generation's write");
  held.open();
  await Promise.all([oldWrite, newRead]);
  assert.deepEqual(events, ["old flow reentered through successor", "old write done", "new read"]);
  assert.deepEqual(successor.snapshot(), []);
});

test("upgrading a held read to a write fails fast instead of waiting forever", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  await assert.rejects(coordinator.read("repo", async () => {
    await coordinator.run("repo", async () => undefined);
  }), TransitionLeaseUpgradeError);
  assert.equal(await coordinator.run("repo", async () => "free"), "free");
});

test("opposite-order acquisitions refuse the cycle and let the other flow finish", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const both = gate();
  const results = await Promise.allSettled([
    coordinator.run("a", async () => { await both.promise; return await coordinator.exclusive("b", async () => "a then b"); }),
    coordinator.exclusive("b", async () => { await both.promise; return await coordinator.run("a", async () => "b then a"); }),
    (async () => { await settle(); both.open(); })(),
  ]);
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof TransitionLeaseDeadlockError);
  assert.equal(results.filter(result => result.status === "fulfilled" && typeof result.value === "string").length, 1);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("a read that would close a cycle behind a queued writer jumps it, while ordinary reads keep waiting", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const events: string[] = [];
  const queueHeld = gate();
  const leaseHeld = gate();
  // Flow A holds the read lease and waits for the queue key; flow B holds the queue key and needs a read lease.
  const flowA = coordinator.read("repo", async () => {
    leaseHeld.open();
    await queueHeld.promise;
    await coordinator.exclusive("queue", async () => { events.push("A entered queue"); });
  });
  await leaseHeld.promise;
  const writer = coordinator.run("repo", async () => { events.push("writer"); });
  await settle();
  const ordinary = coordinator.read("repo", async () => { events.push("ordinary read"); });
  const flowB = coordinator.exclusive("queue", async () => {
    queueHeld.open();
    await settle();
    await coordinator.read("repo", async () => { events.push("B read"); });
  });
  await Promise.all([flowA, flowB, writer, ordinary]);
  assert.equal(events[0], "B read");
  assert.ok(events.indexOf("writer") < events.indexOf("ordinary read"), "Unrelated reads still wait behind the queued writer");
});

test("a write that would close a cycle with a read holder is refused", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const leaseHeld = gate();
  const queueHeld = gate();
  const flowA = coordinator.read("repo", async () => {
    leaseHeld.open();
    await queueHeld.promise;
    await coordinator.exclusive("queue", async () => undefined);
  });
  await leaseHeld.promise;
  const flowB = coordinator.exclusive("queue", async () => {
    queueHeld.open();
    await settle();
    await coordinator.run("repo", async () => undefined);
  });
  const [a, b] = await Promise.allSettled([flowA, flowB]);
  assert.equal(a.status, "fulfilled");
  assert.ok(b.status === "rejected" && b.reason instanceof TransitionLeaseDeadlockError);
});

test("a long wait is reported once with holder and waiter sites, and keeps waiting", async () => {
  const warnings: string[] = [];
  const scheduled: Array<() => void> = [];
  let now = 0;
  const coordinator = new WorkbenchThreadTransitionCoordinator({
    warn: message => { warnings.push(message); },
    schedule: callback => { scheduled.push(callback); return () => { scheduled.splice(scheduled.indexOf(callback), 1); }; },
    now: () => now,
  });
  const held = gate();
  const holder = coordinator.run("repo", async () => { await held.promise; });
  await settle();
  const waiter = coordinator.read("repo", async () => "granted");
  await settle();
  assert.equal(scheduled.length, 1);
  now = 61_000;
  scheduled[0]!();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /read lease on "repo" has waited 61s/u);
  assert.match(warnings[0]!, /held write for 61s/u);
  held.open();
  assert.equal(await waiter, "granted");
  await holder;
  assert.equal(scheduled.length, 0, "A granted waiter cancels its report");
});
