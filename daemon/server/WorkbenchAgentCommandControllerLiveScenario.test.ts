/*
 * No exports. Tests protect live scenario allowlisting, single-run ownership, bounded output, and cancellation.
 */
import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import fs from "node:fs/promises";

import WorkbenchAgentCommandLiveScenarioController from "./WorkbenchAgentCommandControllerLiveScenario";
import WorkbenchTestProcessResources from "./WorkbenchTestProcessResources";

function child() {
  const process = new ChildProcess();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  Object.defineProperty(process, "pid", { configurable: true, value: 42 });
  return process;
}

test("runs one exact provider selection and rejects overlap", async () => {
  const spawned: Array<{ args: string[]; command: string; options: SpawnOptions }> = [];
  const running = child();
  let didSpawn!: () => void;
  const spawnedChild = new Promise<void>(resolve => { didSpawn = resolve; });
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    spawnProcess: (command, args, options) => {
      spawned.push({ args, command, options });
      didSpawn();
      return running;
    },
  });
  const execution = controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { opencode: "fake" },
  }, new AbortController().signal);

  await spawnedChild;
  await assert.rejects(controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { codex: "paid" },
  }, new AbortController().signal), /already running/u);

  (running.stdout as PassThrough | null)?.write("journey\n");
  running.emit("close", 0, null);
  assert.equal(await (await execution).text(), "journey\n");
  assert.deepEqual(spawned[0]?.args.slice(-2), ["--opencode=fake", "test/scenarios/thread.scenario.test.ts"]);
});

test("the installer scenario runs its own entry with no provider modes", async () => {
  const running = child();
  const spawned: string[][] = [];
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    spawnProcess: (_command, args) => {
      spawned.push(args);
      queueMicrotask(() => running.emit("close", 0, null));
      return running;
    },
  });
  await controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/install/InstallSandbox.scenario.test.ts",
  }, new AbortController().signal);
  const args = spawned[0]!;
  assert.match(args.at(-2)!, /run-live-install-test\.mjs$/u);
  assert.equal(args.at(-1), "test/install/InstallSandbox.scenario.test.ts");
  await assert.rejects(controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/install/InstallSandbox.scenario.test.ts",
    providers: { codex: "fake" },
  }, new AbortController().signal));
});

test("cancellation retires the exact owned child", async () => {
  const running = child();
  const retired: number[] = [];
  let spawned!: () => void;
  const didSpawn = new Promise<void>(resolve => { spawned = resolve; });
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
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
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { codex: "paid" },
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
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async pid => { if (pid) retired.push(pid); },
    spawnProcess: () => {
      spawned();
      return running;
    },
  });
  const execution = controller.execute({
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { opencode: "fake" },
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
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
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
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { opencode: "paid" },
  }, abort.signal), /cancelled while spawning/u);
  assert.deepEqual(retired, [42]);
});

test("cancellation remains owned until the detached service cleanup finishes", async context => {
  const running = child();
  const spawned = Promise.withResolvers<NodeJS.ProcessEnv>();
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  context.mock.method(WorkbenchTestProcessResources, "retireService", async (file: string) => {
    assert.equal(file, "owned-service-record");
    cleanupStarted.resolve();
    await cleanupFinished.promise;
  });
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async () => {},
    spawnProcess: (_command, _args, options) => {
      spawned.resolve(options.env!);
      return running;
    },
  });
  const request = {
    cwd: "C:/git/web/workbench",
    file: "test/scenarios/thread.scenario.test.ts",
    providers: { opencode: "paid" },
  };
  const execution = controller.execute(request, new AbortController().signal);
  const rejected = assert.rejects(execution, /cancelled/u);
  const environment = await spawned.promise;
  await fs.appendFile(environment.WORKBENCH_TEST_SERVICE_RECORDS!, `${JSON.stringify("owned-service-record")}\n`);
  controller.cancel();
  running.emit("close", null, "SIGTERM");
  await cleanupStarted.promise;
  await assert.rejects(controller.execute(request, new AbortController().signal), /already running/u);
  cleanupFinished.resolve();
  await rejected;
});
