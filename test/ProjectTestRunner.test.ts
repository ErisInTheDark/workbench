/*
 * No exports. Tests protect runner-owned temp routing, daemon-compatible child cwd, timeout policy, and fixture/test-run disposal order.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { WORKBENCH_TEMPORARY_ROOT_ENV } from "../daemon/server/lib/workbench/WorkbenchTemporaryDirectory";
import ProjectTestRunner from "./ProjectTestRunner";

test("rejects all orphaned tests before acquiring fixtures or launching children", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-catalog-"));
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
    await rm(root, { recursive: true, force: true });
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
      const child = new EventEmitter() as ChildProcess;
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
      acquireTestRun: async () => ({ dispose: async () => undefined, temporaryRootPath }),
      prepareTestFixtures: async () => ({ dispose: async () => undefined, environment: {} }),
      spawnProcess: (_command, args) => {
        invocations.push([...args]);
        const child = new EventEmitter() as ChildProcess;
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
  assert.equal(invocations[1]?.some(argument => argument.startsWith("--test-timeout=")), false);
});
