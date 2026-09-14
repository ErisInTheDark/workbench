/* No production exports. Tests protect stable keyed transition serialization, cross-key concurrency, failure recovery, and queue cleanup. */
import assert from "node:assert/strict";
import test from "node:test";

import { createWorktreeGitTransitions } from "./worktree-git-transitions";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

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
