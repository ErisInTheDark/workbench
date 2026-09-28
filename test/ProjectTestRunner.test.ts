/*
 * No exports. Tests protect runner-owned temp routing, daemon-compatible child cwd, timeout policy, and fixture/test-run disposal order.
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

test("a failed file frees its slot while shared fixtures remain owned until the other files finish", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("test-runner-pool-");
  const root = temporary.path;
  const files = ["first", "second", "third"];
  await Promise.all(files.flatMap(name => [
    writeFile(path.join(root, `${name}.ts`), ""),
    writeFile(path.join(root, `${name}.test.ts`), ""),
  ]));
  const outcomes = files.map(() => Promise.withResolvers<{ exitCode: number; signal: null }>());
  const firstPair = Promise.withResolvers<void>();
  const thirdStarted = Promise.withResolvers<void>();
  const disposed: string[] = [];
  let count = 0;
  const runner = new ProjectTestRunner(root, {
    report: () => {}, testConcurrency: 2,
    acquireTestRun: async () => ({
      temporaryRootPath: root, dispose: async () => { disposed.push("lease"); },
    }),
    prepareTestFixtures: async () => ({
      environment: {}, dispose: async () => { disposed.push("fixtures"); },
    }),
    spawnProcess: () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess,
    ownProcess: async () => {
      const index = count++;
      if (count === 2) firstPair.resolve();
      if (count === 3) thirdStarted.resolve();
      return outcomes[index]!.promise;
    },
  });
  try {
    const running = runner.run(files.map(name => `${name}.test.ts`));
    await firstPair.promise;
    outcomes[0]!.resolve({ exitCode: 1, signal: null });
    await thirdStarted.promise;
    assert.deepEqual(disposed, []);
    outcomes[2]!.resolve({ exitCode: 0, signal: null });
    outcomes[1]!.resolve({ exitCode: 0, signal: null });
    assert.deepEqual(await running, { exitCode: 1, signal: null });
    assert.deepEqual(disposed, ["fixtures", "lease"]);
  } finally {
    for (const outcome of outcomes) outcome.resolve({ exitCode: 1, signal: null });
    await temporary.dispose();
  }
});
