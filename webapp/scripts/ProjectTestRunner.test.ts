/* No production exports. Regression wards cover deterministic discovery, runner-owned fixture lifecycle, pool settlement, and bounded Node arguments. Keywords: tests, fixtures, concurrency, cleanup. */
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { partitionWorkbenchGitTestFiles } from "../lib/workbench/git/WorkbenchGitTestFixtures";
import ProjectTestRunner, { parseProjectTestRunnerArguments } from "./ProjectTestRunner";

const noPreparedFixtures = async () => ({ dispose: async () => undefined, environment: {} });

function readNumericArgument(args: readonly string[], name: string) {
  const prefix = `${name}=`;
  const value = Number(args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length));
  assert.equal(Number.isInteger(value), true, `Expected an integer ${name} argument.`);
  return value;
}

test("parses one cooperative mode without changing ordinary discovery inputs", () => {
  assert.deepEqual(parseProjectTestRunnerArguments([]), { inputs: ["."] });
  const cooperative = parseProjectTestRunnerArguments([
    "--", "--good-citizen", "nested", "alpha.test.ts", "--good-citizen",
  ]);
  assert.deepEqual(cooperative.inputs, ["nested", "alpha.test.ts"]);
  assert.equal(cooperative.testConcurrency, 1);
  assert.equal(typeof cooperative.testTimeoutMs === "number" && Number.isInteger(cooperative.testTimeoutMs) && cooperative.testTimeoutMs > 0, true);
  assert.throws(
    () => parseProjectTestRunnerArguments(["--jobs", "2"]),
    /Unknown test runner option: --jobs/u,
  );
  assert.throws(
    () => new ProjectTestRunner(".", { testTimeoutMs: 0 }),
    /Test timeout must be a positive integer of milliseconds/u,
  );
});

test("discovers TypeScript tests exactly once in stable order and skips generated trees", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-test-discovery-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    writeFile(path.join(root, "alpha.test.tsx"), ""),
    writeFile(path.join(root, "alpha.tsx"), ""),
    mkdir(path.join(root, "nested"), { recursive: true }).then(() => writeFile(path.join(root, "nested", "beta.test.ts"), "")),
    mkdir(path.join(root, "generated"), { recursive: true }).then(() => writeFile(path.join(root, "generated", "ignored.test.ts"), "")),
    mkdir(path.join(root, "node_modules"), { recursive: true }).then(() => writeFile(path.join(root, "node_modules", "ignored.test.tsx"), "")),
  ]);

  const discovered = await new ProjectTestRunner(root).discoverTestFiles(["nested", ".", "alpha.test.tsx"]);

  assert.deepEqual(discovered.map((file) => path.relative(root, file).replaceAll("\\", "/")), [
    "alpha.test.tsx",
    "nested/beta.test.ts",
  ]);
});

test("fails clearly when no TypeScript tests match", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-empty-test-discovery-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(() => new ProjectTestRunner(root).run(), /No \.test\.ts or \.test\.tsx files found under: \./u);
});

test("prepares selected fixtures before Node starts and disposes them after it exits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-fixture-lifecycle-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const testFile = path.join(root, "prepared.test.ts");
  await writeFile(testFile, "");
  const events: string[] = [];

  class RecordingRunner extends ProjectTestRunner {
    protected override async runTestFiles(
      files: readonly string[],
      _concurrency?: number,
      fixtureEnvironment?: Record<string, string>,
    ) {
      assert.deepEqual(fixtureEnvironment, { WORKBENCH_FIXTURE_TEST: "prepared" });
      events.push(`run:${files.map((file) => path.basename(file)).join(",")}`);
      return { exitCode: 0, signal: null };
    }
  }

  const runner = new RecordingRunner(root, {
    prepareTestFixtures: async (files) => {
      events.push(`prepare:${files.map((file) => path.basename(file)).join(",")}`);
      return {
        dispose: async () => { events.push("dispose"); },
        environment: { WORKBENCH_FIXTURE_TEST: "prepared" },
      };
    },
  });
  assert.deepEqual(await runner.run(), { exitCode: 0, signal: null });
  assert.deepEqual(events, ["prepare:prepared.test.ts", "run:prepared.test.ts", "dispose"]);
});

test("starts Node with explicit bounded file concurrency and the project timeout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-test-runner-args-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "alpha.test.ts"), "");
  const invocations: Array<{ args: readonly string[]; command: string }> = [];

  const runner = new ProjectTestRunner(root, {
    prepareTestFixtures: noPreparedFixtures,
    spawnProcess: (command, args) => {
      invocations.push({ args, command });
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    testConcurrency: 3,
    testTimeoutMs: 45_000,
  });

  assert.deepEqual(await runner.run(), { exitCode: 0, signal: null });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.command, process.execPath);
  assert(invocations[0]?.args.includes("--test-concurrency=3"));
  assert(invocations[0]?.args.includes("--test-timeout=45000"));
  assert(invocations[0]?.args.includes("alpha.test.ts"));
});

test("caps ordinary test-file concurrency", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-default-test-concurrency-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "alpha.test.ts"), "");
  const invocations: Array<{ args: readonly string[]; command: string }> = [];
  const runner = new ProjectTestRunner(root, {
    prepareTestFixtures: noPreparedFixtures,
    spawnProcess: (command, args) => {
      invocations.push({ args, command });
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.deepEqual(await runner.run(), { exitCode: 0, signal: null });
  const concurrency = readNumericArgument(invocations[0]?.args ?? [], "--test-concurrency");
  assert(concurrency >= 1);
  assert(concurrency <= Math.max(1, os.availableParallelism()));
});

test("partitions Git-heavy suites without disturbing stable group order", () => {
  assert.deepEqual(partitionWorkbenchGitTestFiles([
    "components/zeta.test.ts",
    "lib/workbench/git/GitArcRetentionController.test.ts",
    "lib/workbench/git/WorkbenchThreadGit.test.ts",
    "lib/alpha.test.ts",
    "lib/git-checkpoints.test.ts",
  ]), {
    gitFiles: [
      "lib/workbench/git/GitArcRetentionController.test.ts",
      "lib/workbench/git/WorkbenchThreadGit.test.ts",
    ],
    nestedGitFiles: ["lib/git-checkpoints.test.ts"],
    ordinaryFiles: ["components/zeta.test.ts", "lib/alpha.test.ts"],
  });
});

test("runs Git-heavy and ordinary files in concurrent bounded pools", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-test-pools-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    writeFile(path.join(root, "git-checkpoints.test.ts"), ""),
    writeFile(path.join(root, "WorkbenchThreadGit.test.ts"), ""),
    writeFile(path.join(root, "ordinary.test.ts"), ""),
  ]);
  const invocations: Array<{ args: readonly string[]; command: string }> = [];
  const events: string[] = [];
  const runner = new ProjectTestRunner(root, {
    prepareTestFixtures: async () => ({
      dispose: async () => { events.push("dispose"); },
      environment: { WORKBENCH_FIXTURE_TEST: "pooled" },
    }),
    spawnProcess: (command, args, options) => {
      invocations.push({ args, command });
      assert.equal(options.env.WORKBENCH_FIXTURE_TEST, "pooled");
      const file = args.at(-1) ?? "unknown";
      events.push(`start:${file}`);
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        events.push(`exit:${file}`);
        child.emit("exit", 0, null);
      });
      return child;
    },
    testConcurrency: 8,
  });

  assert.deepEqual(await runner.run(), { exitCode: 0, signal: null });
  assert.equal(invocations.length, 3);
  const nestedGitPool = invocations.find(({ args }) => args.includes("git-checkpoints.test.ts"));
  const gitPool = invocations.find(({ args }) => args.includes("WorkbenchThreadGit.test.ts"));
  const ordinaryPool = invocations.find(({ args }) => args.includes("ordinary.test.ts"));
  const nestedGitConcurrency = readNumericArgument(nestedGitPool?.args ?? [], "--test-concurrency");
  const gitConcurrency = readNumericArgument(gitPool?.args ?? [], "--test-concurrency");
  const ordinaryConcurrency = readNumericArgument(ordinaryPool?.args ?? [], "--test-concurrency");
  assert(nestedGitConcurrency >= 1);
  assert(nestedGitConcurrency < ordinaryConcurrency);
  assert(gitConcurrency >= nestedGitConcurrency);
  assert(gitConcurrency < ordinaryConcurrency);
  assert.equal(ordinaryConcurrency, 8);
  assert.equal(events.at(-1), "dispose");
  assert.equal(events.filter((event) => event.startsWith("exit:")).length, 3);
});

test("waits for every started pool before cleaning fixtures after a pool failure", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-test-pool-failure-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    writeFile(path.join(root, "WorkbenchThreadGit.test.ts"), ""),
    writeFile(path.join(root, "ordinary.test.ts"), ""),
  ]);
  const events: string[] = [];
  let lingeringChild: ChildProcess | undefined;
  let reportFailure: (() => void) | undefined;
  const failureReported = new Promise<void>((resolve) => { reportFailure = resolve; });
  const runner = new ProjectTestRunner(root, {
    prepareTestFixtures: async () => ({
      dispose: async () => { events.push("dispose"); },
      environment: {},
    }),
    spawnProcess: (_command, args) => {
      const child = new EventEmitter() as ChildProcess;
      if (args.includes("WorkbenchThreadGit.test.ts")) {
        lingeringChild = child;
      } else {
        queueMicrotask(() => {
          events.push("failure");
          child.emit("error", new Error("pool spawn failed"));
          reportFailure?.();
        });
      }
      return child;
    },
    testConcurrency: 8,
  });

  const running = runner.run();
  await failureReported;
  assert.deepEqual(events, ["failure"]);
  lingeringChild?.emit("exit", 0, null);
  await assert.rejects(running, /pool spawn failed/u);
  assert.deepEqual(events, ["failure", "dispose"]);
});

test("good-citizen mode runs the selected suite with one test file at a time", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-good-citizen-runner-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "alpha.test.ts"), "");
  const invocations: Array<{ args: readonly string[]; command: string }> = [];
  const parsed = parseProjectTestRunnerArguments(["--", "--good-citizen", "alpha.test.ts"]);
  if (parsed.testConcurrency === undefined) assert.fail("Good-citizen mode must select cooperative concurrency.");
  if (parsed.testTimeoutMs === undefined) assert.fail("Good-citizen mode must select a cooperative timeout.");
  const runner = new ProjectTestRunner(root, {
    prepareTestFixtures: noPreparedFixtures,
    spawnProcess: (command, args) => {
      invocations.push({ args, command });
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    testConcurrency: parsed.testConcurrency,
    testTimeoutMs: parsed.testTimeoutMs,
  });

  assert.deepEqual(await runner.run(parsed.inputs), { exitCode: 0, signal: null });
  assert.equal(invocations.length, 1);
  assert(invocations[0]?.args.includes("--test-concurrency=1"));
  assert(invocations[0]?.args.includes(`--test-timeout=${parsed.testTimeoutMs}`));
  assert(invocations[0]?.args.includes("alpha.test.ts"));
});
