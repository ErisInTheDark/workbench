/*
 * No exports. Tests protect live scenario allowlisting, queued runs that say when they wait and leave the queue when their
 * caller does, streamed output ending in its exit line, and cancellation.
 */
import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import fs from "node:fs/promises";

import { LiveScenarioExit } from "workbench-shared/workbench/commands/live-scenario-exit";
import WorkbenchAgentCommandLiveScenarioController from "./WorkbenchAgentCommandControllerLiveScenario";
import WorkbenchTestProcessResources from "../runtime/WorkbenchTestProcessResources";

const thread = (providers: Record<string, "paid" | "fake">) => ({
  cwd: "C:/git/web/workbench", file: "test/scenarios/thread.scenario.test.ts", providers,
});

function child() {
  const process = new ChildProcess();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  Object.defineProperty(process, "pid", { configurable: true, value: 42 });
  return process;
}

/** Reads a streamed run as it arrives; `next(pattern)` resolves once the output so far matches. */
function reader(response: Response) {
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) return output;
      output += decoder.decode(chunk.value, { stream: true });
    }
  })();
  const next = async (pattern: RegExp) => {
    while (!pattern.test(output)) await new Promise(resolve => setImmediate(resolve));
    return output;
  };
  return { done, next };
}

test("overlapping runs queue: the later one says it waits at once and spawns only after the first closes", async () => {
  const spawned: Array<{ args: string[]; command: string; options: SpawnOptions }> = [];
  const children = [child(), child()];
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    spawnProcess: (command, args, options) => {
      spawned.push({ args, command, options });
      return children[spawned.length - 1]!;
    },
  });
  const first = reader(controller.execute(thread({ opencode: "fake" }), new AbortController().signal));
  while (!spawned.length) await new Promise(resolve => setImmediate(resolve));
  const second = reader(controller.execute(thread({ codex: "fake" }), new AbortController().signal));
  await second.next(/waits for it to finish/u);
  assert.equal(spawned.length, 1, "the queued run spawned while another ran");

  (children[0]!.stdout as PassThrough).write("journey\n");
  await first.next(/journey/u);
  children[0]!.emit("close", 0, null);
  assert.equal(LiveScenarioExit.read(await first.done), 0);
  assert.deepEqual(spawned[0]?.args.slice(-2), ["--opencode=fake", "test/scenarios/thread.scenario.test.ts"]);

  while (spawned.length < 2) await new Promise(resolve => setImmediate(resolve));
  children[1]!.emit("close", 2, null);
  assert.equal(LiveScenarioExit.read(await second.done), 2);
});

test("a caller that leaves while queued drops out without ever spawning", async () => {
  const running = child();
  let spawnCount = 0;
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    spawnProcess: () => { spawnCount += 1; return running; },
  });
  const first = reader(controller.execute(thread({ opencode: "fake" }), new AbortController().signal));
  while (!spawnCount) await new Promise(resolve => setImmediate(resolve));
  const leaving = new AbortController();
  const second = reader(controller.execute(thread({ codex: "fake" }), leaving.signal));
  await second.next(/waits/u);
  leaving.abort(new Error("shell stopped"));
  assert.notEqual(LiveScenarioExit.read(await second.done), 0);
  running.emit("close", 0, null);
  assert.equal(LiveScenarioExit.read(await first.done), 0);
  assert.equal(spawnCount, 1);
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
  await reader(controller.execute({ cwd: "C:/git/web/workbench", file: "test/install/InstallSandbox.scenario.test.ts" },
    new AbortController().signal)).done;
  const args = spawned[0]!;
  assert.match(args.at(-2)!, /run-live-install-test\.mjs$/u);
  assert.equal(args.at(-1), "test/install/InstallSandbox.scenario.test.ts");
  assert.throws(() => controller.execute({
    cwd: "C:/git/web/workbench", file: "test/install/InstallSandbox.scenario.test.ts", providers: { codex: "fake" },
  }, new AbortController().signal));
});

test("cancellation retires the exact owned child and the stream reports failure", async () => {
  const running = child();
  const retired: number[] = [];
  let spawned!: () => void;
  const didSpawn = new Promise<void>(resolve => { spawned = resolve; });
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async pid => { if (pid) retired.push(pid); },
    spawnProcess: () => { spawned(); return running; },
  });
  const abort = new AbortController();
  const execution = reader(controller.execute(thread({ codex: "paid" }), abort.signal));
  await didSpawn;
  abort.abort(new Error("caller left"));
  running.emit("close", null, "SIGTERM");
  const output = await execution.done;
  assert.match(output, /caller left/u);
  assert.equal(LiveScenarioExit.read(output), 1);
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
    spawnProcess: () => { spawned(); return running; },
  });
  const execution = reader(controller.execute(thread({ opencode: "fake" }), new AbortController().signal));
  await didSpawn;
  assert.equal(controller.cancel(), true);
  running.emit("close", null, "SIGTERM");
  assert.match(await execution.done, /cancelled/u);
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
  assert.match(await reader(controller.execute(thread({ opencode: "paid" }), abort.signal)).done, /cancelled while spawning/u);
  assert.deepEqual(retired, [42]);
});

test("the next run waits until the cancelled run's detached service cleanup finishes", async context => {
  const running = child();
  const spawned = Promise.withResolvers<NodeJS.ProcessEnv>();
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  let spawnCount = 0;
  context.mock.method(WorkbenchTestProcessResources, "retireService", async (file: string) => {
    assert.equal(file, "owned-service-record");
    cleanupStarted.resolve();
    await cleanupFinished.promise;
  });
  const controller = new WorkbenchAgentCommandLiveScenarioController("C:/git/web/workbench", {
    realpath: async value => value,
    retireProcess: async () => {},
    spawnProcess: (_command, _args, options) => {
      spawnCount += 1;
      if (spawnCount === 1) spawned.resolve(options.env!);
      else queueMicrotask(() => running.emit("close", 0, null));
      return running;
    },
  });
  const first = reader(controller.execute(thread({ opencode: "paid" }), new AbortController().signal));
  const environment = await spawned.promise;
  await fs.appendFile(environment.WORKBENCH_TEST_SERVICE_RECORDS!, `${JSON.stringify("owned-service-record")}\n`);
  controller.cancel();
  running.emit("close", null, "SIGTERM");
  await cleanupStarted.promise;
  const second = reader(controller.execute(thread({ opencode: "paid" }), new AbortController().signal));
  await second.next(/waits/u);
  assert.equal(spawnCount, 1, "a run spawned before the previous run's services were retired");
  cleanupFinished.resolve();
  assert.match(await first.done, /cancelled/u);
  assert.equal(LiveScenarioExit.read(await second.done), 0);
  assert.equal(spawnCount, 2);
});
