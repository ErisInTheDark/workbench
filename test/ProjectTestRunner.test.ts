/*
 * No exports. Tests protect runner-owned temp routing, grouped invocations, timeout and cancellation policy, and fixture/test-run disposal order.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { WORKBENCH_TEMPORARY_ROOT_ENV } from "../daemon/server/lib/workbench/WorkbenchTemporaryDirectory";
import ProjectTestRunner from "./ProjectTestRunner";

test("rejects all orphaned tests before acquiring fixtures or launching children", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("test-catalog-");
  const root = temporary.path;
  try {
    await Promise.all(["first.test.ts", "second.test.tsx"].map(file => writeFile(path.join(root, file), "")));
    let acquired = false;
    const runner = new ProjectTestRunner(root, {
      acquireTestRun: async () => {
        acquired = true;
        throw new Error("fixtures must not start");
      },
    });
    await assert.rejects(runner.run(["first.test.ts"]), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /first\.test\.ts/);
      assert.match(error.message, /second\.test\.tsx/);
      return true;
    });
    assert.equal(acquired, false);
  } finally {
    await temporary.dispose();
  }
});

test("routes fixtures and test children through the acquired temp root before disposing both owners", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRootPath = path.join(projectRoot, "test", "runner-temp-root");
  const disposed: string[] = [];
  let childCwd = "";
  let childEnvironment: NodeJS.ProcessEnv | null = null;
  let fixtureRootPath = "";
  const runner = new ProjectTestRunner(projectRoot, {
    report: () => {},
    acquireTestRun: async () => ({
      dispose: async () => { disposed.push("run"); },
      temporaryRootPath,
    }),
    prepareTestFixtures: async (_files, receivedTemporaryRootPath) => {
      fixtureRootPath = receivedTemporaryRootPath;
      return {
        dispose: async () => { disposed.push("fixtures"); },
        environment: { WORKBENCH_FIXTURE_SENTINEL: "ready" },
      };
    },
    spawnProcess: (_command, _args, options) => {
      childCwd = options.cwd;
      childEnvironment = options.env;
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    testConcurrency: 1,
  });

  const result = await runner.run([fileURLToPath(import.meta.url)]);

  assert.deepEqual(result, { exitCode: 0, signal: null });
  assert.equal(childCwd, path.join(projectRoot, "daemon"));
  assert.equal(fixtureRootPath, temporaryRootPath);
  assert.equal(childEnvironment?.TEMP, temporaryRootPath);
  assert.equal(childEnvironment?.TMP, temporaryRootPath);
  assert.equal(childEnvironment?.TMPDIR, temporaryRootPath);
  assert.equal(childEnvironment?.TSX_TSCONFIG_PATH, path.resolve(projectRoot, "test", "tsconfig.json"));
  assert.equal(childEnvironment?.[WORKBENCH_TEMPORARY_ROOT_ENV], temporaryRootPath);
  assert.equal(childEnvironment?.WORKBENCH_FIXTURE_SENTINEL, "ready");
  assert.deepEqual(disposed, ["fixtures", "run"]);
});

test("live runners can omit the test timeout without changing the ordinary default", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRootPath = path.join(projectRoot, "test", "runner-timeout-root");
  const invocations: string[][] = [];
  const run = async (testTimeoutMs?: number | null) => {
    const runner = new ProjectTestRunner(projectRoot, {
      report: () => {},
      acquireTestRun: async () => ({ dispose: async () => undefined, temporaryRootPath }),
      prepareTestFixtures: async () => ({ dispose: async () => undefined, environment: {} }),
      spawnProcess: (_command, args) => {
        invocations.push([...args]);
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
      testConcurrency: 1,
      ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
    });
    await runner.run([fileURLToPath(import.meta.url)]);
  };

  await run();
  await run(null);

  assert.ok(invocations[0]?.includes("--test-timeout=30000"));
  assert.ok(invocations[0]?.includes("--test-force-exit"));
  assert.equal(invocations[1]?.some(argument => argument.startsWith("--test-timeout=")), false);
});

test("batches selected files by isolation group while preserving failure and cleanup", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("test-runner-batches-");
  const root = temporary.path;
  const files = ["first", "second", "third", "GitArcPlanController", "GitArcClaimLossStore"];
  await Promise.all(files.flatMap(name => [
    writeFile(path.join(root, `${name}.ts`), ""),
    writeFile(path.join(root, `${name}.test.ts`), ""),
  ]));
  const disposed: string[] = [];
  const invocations: string[][] = [];
  const budgets: number[] = [];
  const argumentsByChild = new Map<ChildProcess, string[]>();
  const runner = new ProjectTestRunner(root, {
    report: () => {}, testConcurrency: 2,
    acquireTestRun: async () => ({
      temporaryRootPath: root, dispose: async () => { disposed.push("lease"); },
    }),
    prepareTestFixtures: async () => ({
      environment: {}, dispose: async () => { disposed.push("fixtures"); },
    }),
    spawnProcess: (_command, args) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
      const invocation = [...args];
      invocations.push(invocation);
      argumentsByChild.set(child, invocation);
      return child;
    },
    ownProcess: async (child, _group, budget) => {
      budgets.push(budget);
      const args = argumentsByChild.get(child)!;
      return { exitCode: args.some(argument => argument.endsWith("first.test.ts")) ? 1 : 0, signal: null };
    },
  });
  try {
    assert.deepEqual(await runner.run(files.map(name => `${name}.test.ts`)), { exitCode: 1, signal: null });
    assert.equal(invocations.length, 3);
    const selected = invocations.map(args => args.filter(argument => argument.endsWith(".test.ts")));
    assert.deepEqual(selected.map(group => group.length).sort(), [1, 1, 3]);
    assert.deepEqual(selected.flat().map(file => path.basename(file)).sort(),
      files.map(name => `${name}.test.ts`).sort());
    assert.ok(invocations.some(args => args.includes("--test-concurrency=2")
      && args.filter(argument => argument.endsWith(".test.ts")).length === 3));
    assert.equal(invocations.filter(args => args.includes("--test-concurrency=1")).length, 2);
    assert.deepEqual(budgets.sort((a, b) => a - b), [300_000, 300_000, 600_000]);
    assert.deepEqual(disposed, ["fixtures", "lease"]);
  } finally {
    await temporary.dispose();
  }
});

test("cancelled runs do not spawn a test batch", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const runner = new ProjectTestRunner(projectRoot, {
    signal: controller.signal,
    acquireTestRun: async () => ({ temporaryRootPath: projectRoot, dispose: async () => undefined }),
    prepareTestFixtures: async () => ({ environment: {}, dispose: async () => undefined }),
    spawnProcess: () => {
      spawned = true;
      throw new Error("cancelled run launched a batch");
    },
  });

  assert.deepEqual(await runner.run([fileURLToPath(import.meta.url)]), { exitCode: 130, signal: null });
  assert.equal(spawned, false);
});
