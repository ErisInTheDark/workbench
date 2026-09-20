/*
 * No exports. Tests protect live-provider allowlisting, single-run ownership, bounded output, and cancellation.
 */
import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";

import WorkbenchAgentCommandLiveTestController from "./WorkbenchAgentCommandControllerLiveTest";

function child() {
  const process = new ChildProcess();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  Object.defineProperty(process, "pid", { configurable: true, value: 42 });
  return process;
}

test("runs one exact provider scenario and rejects overlap", async () => {
  const spawned: Array<{ args: string[]; command: string; options: SpawnOptions }> = [];
  const running = child();
  let didSpawn!: () => void;
  const spawnedChild = new Promise<void>(resolve => { didSpawn = resolve; });
  const controller = new WorkbenchAgentCommandLiveTestController("C:/git/web/workbench", {
    realpath: async value => value,
    spawnProcess: (command, args, options) => {
      spawned.push({ args, command, options });
      didSpawn();
      return running;
    },
  });
  const execution = controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/opencode.scenario.test.ts",
    provider: "opencode",
  }, new AbortController().signal);

  await spawnedChild;
  await assert.rejects(controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/codex.scenario.test.ts",
    provider: "codex",
  }, new AbortController().signal), /already running/u);

  (running.stdout as PassThrough | null)?.write("journey\n");
  running.emit("close", 0, null);
  assert.equal(await (await execution).text(), "journey\n");
  assert.deepEqual(spawned[0]?.args.slice(-2), ["opencode", "test/scenarios/opencode.scenario.test.ts"]);
});

test("cancellation retires the exact owned child", async () => {
  const running = child();
  const retired: number[] = [];
  let spawned!: () => void;
  const didSpawn = new Promise<void>(resolve => { spawned = resolve; });
  const controller = new WorkbenchAgentCommandLiveTestController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async pid => { if (pid) retired.push(pid); },
    spawnProcess: () => {
      spawned();
      return running;
    },
  });
  const abort = new AbortController();
  const execution = controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/codex.scenario.test.ts",
    provider: "codex",
  }, abort.signal);

  await didSpawn;
  abort.abort(new Error("caller left"));
  running.emit("close", null, "SIGTERM");
  await assert.rejects(execution, /caller left/u);
  assert.deepEqual(retired, [42]);
});

test("explicit cancellation retires the active child", async () => {
  const running = child();
  const retired: number[] = [];
  let spawned!: () => void;
  const didSpawn = new Promise<void>(resolve => { spawned = resolve; });
  const controller = new WorkbenchAgentCommandLiveTestController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async pid => { if (pid) retired.push(pid); },
    spawnProcess: () => {
      spawned();
      return running;
    },
  });
  const execution = controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/opencode.scenario.test.ts",
    provider: "opencode",
  }, new AbortController().signal);

  await didSpawn;
  assert.equal(controller.cancel(), true);
  running.emit("close", null, "SIGTERM");
  await assert.rejects(execution, /cancelled/u);
  assert.deepEqual(retired, [42]);
  assert.equal(controller.cancel(), false);
});

test("cancellation during spawn still retires the child", async () => {
  const running = child();
  const retired: number[] = [];
  const abort = new AbortController();
  const controller = new WorkbenchAgentCommandLiveTestController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async pid => { if (pid) retired.push(pid); },
    spawnProcess: () => {
      abort.abort(new Error("cancelled while spawning"));
      queueMicrotask(() => running.emit("close", null, "SIGTERM"));
      return running;
    },
  });

  await assert.rejects(controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/opencode.scenario.test.ts",
    provider: "opencode",
  }, abort.signal), /cancelled while spawning/u);
  assert.deepEqual(retired, [42]);
});
