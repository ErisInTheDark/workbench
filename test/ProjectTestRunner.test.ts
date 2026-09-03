/*
 * Keywords: tests, runner, temp, lifecycle.
 * No exports. Tests protect runner-owned temp routing, daemon-compatible child cwd, and fixture/test-run disposal order.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { WORKBENCH_TEMPORARY_ROOT_ENV } from "../daemon/lib/workbench/WorkbenchTemporaryDirectory";
import ProjectTestRunner from "./ProjectTestRunner";

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
