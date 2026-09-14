/*
 * Exports:
 * - default ProjectTestRunner: validate test discovery and own fixtures and Node test-runner children.
 * - ProjectTestRunnerOptions/PreparedTestFixtures: inject runner-owned fixture setup, cleanup, process spawning, concurrency, and timeout.
 * - parseProjectTestRunnerArguments/ProjectTestRunnerArguments: parse explicit discovery inputs.
 * - runProjectTests: apply parsed CLI settings to one complete project test run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  partitionWorkbenchGitTestFiles,
  prepareWorkbenchGitTestFixtures,
  type WorkbenchPreparedTestFixtures,
} from "../daemon/server/lib/workbench/git/WorkbenchGitTestFixtures";
import { WORKBENCH_TEMPORARY_ROOT_ENV } from "../daemon/server/lib/workbench/WorkbenchTemporaryDirectory";
import ProjectTestRunCoordinator, { type ProjectTestRunLease } from "./ProjectTestRunCoordinator";
import ProjectTestCatalog from "./ProjectTestCatalog";

const GIT_TEST_CONCURRENCY = 1;
const NESTED_GIT_TEST_CONCURRENCY = 1;
const ORDINARY_TEST_CONCURRENCY = 8;
const TEST_CONCURRENCY = Math.max(1, Math.min(8, availableParallelism()));
const TEST_TIMEOUT_MS = 30_000;

type TestProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export interface ProjectTestRunnerOptions {
  acquireTestRun?: () => Promise<ProjectTestRunLease>;
  prepareTestFixtures?: (files: readonly string[], temporaryRootPath: string) => Promise<PreparedTestFixtures>;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
  ) => ChildProcess;
  testConcurrency?: number;
  testTimeoutMs?: number;
}

export type PreparedTestFixtures = WorkbenchPreparedTestFixtures;

export interface ProjectTestRunnerArguments {
  inputs: string[];
}

export function parseProjectTestRunnerArguments(arguments_: readonly string[]): ProjectTestRunnerArguments {
  const inputs: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--") continue;
    if (argument.startsWith("--")) throw new Error(`Unknown test runner option: ${argument}`);
    inputs.push(argument);
  }
  return { inputs };
}

export default class ProjectTestRunner {
  private readonly acquireTestRun: () => Promise<ProjectTestRunLease>;
  private readonly prepareTestFixtures: (files: readonly string[], temporaryRootPath: string) => Promise<PreparedTestFixtures>;
  private readonly spawnProcess: NonNullable<ProjectTestRunnerOptions["spawnProcess"]>;
  private readonly testConcurrency: number;
  private readonly testTimeoutMs: number;

  constructor(
    private readonly projectRoot = process.cwd(),
    options: ProjectTestRunnerOptions = {},
  ) {
    this.acquireTestRun = options.acquireTestRun ?? (async () => await new ProjectTestRunCoordinator().acquire());
    this.prepareTestFixtures = options.prepareTestFixtures ?? prepareWorkbenchGitTestFixtures;
    this.spawnProcess = options.spawnProcess ?? spawn;
    const requestedConcurrency = options.testConcurrency ?? TEST_CONCURRENCY;
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
      throw new Error("Test concurrency must be a positive integer.");
    }
    this.testConcurrency = requestedConcurrency;
    const requestedTimeoutMs = options.testTimeoutMs ?? TEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
      throw new Error("Test timeout must be a positive integer of milliseconds.");
    }
    this.testTimeoutMs = requestedTimeoutMs;
  }

  async discoverTestFiles(inputs: readonly string[] = []) {
    const catalog = await ProjectTestCatalog.read(this.projectRoot, inputs);
    catalog.validate();
    return catalog.select(inputs);
  }

  async run(inputs: readonly string[] = []) {
    const files = await this.discoverTestFiles(inputs);
    if (files.length === 0) throw new Error(`No .test.ts or .test.tsx files found under: ${inputs.join(", ")}`);

    const testRun = await this.acquireTestRun();
    try {
      const prepared = await this.prepareTestFixtures(files, testRun.temporaryRootPath);
      const environment = {
        ...prepared.environment,
        [WORKBENCH_TEMPORARY_ROOT_ENV]: testRun.temporaryRootPath,
        TEMP: testRun.temporaryRootPath,
        TMP: testRun.temporaryRootPath,
        TMPDIR: testRun.temporaryRootPath,
        TSX_TSCONFIG_PATH: path.resolve(this.projectRoot, "test", "tsconfig.json"),
      };
      try {
        if (this.testConcurrency === 1) return await this.runTestFiles(files, this.testConcurrency, environment);
        const { gitFiles, nestedGitFiles, ordinaryFiles } = partitionWorkbenchGitTestFiles(files);
        const groups = [
          ...(nestedGitFiles.length ? [{ concurrency: Math.min(NESTED_GIT_TEST_CONCURRENCY, this.testConcurrency), files: nestedGitFiles }] : []),
          ...(gitFiles.length ? [{ concurrency: Math.min(GIT_TEST_CONCURRENCY, this.testConcurrency), files: gitFiles }] : []),
          ...(ordinaryFiles.length ? [{ concurrency: Math.min(ORDINARY_TEST_CONCURRENCY, this.testConcurrency), files: ordinaryFiles }] : []),
        ];
        const settled = await Promise.allSettled(groups.map(async ({ concurrency, files: groupFiles }) => (
          await this.runTestFiles(groupFiles, concurrency, environment)
        )));
        const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
        const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const signaled = results.find((result) => result.signal !== null);
        if (signaled) return signaled;
        const failed = results.find((result) => result.exitCode !== 0);
        return failed ?? { exitCode: 0, signal: null };
      } finally {
        await prepared.dispose();
      }
    } finally {
      await testRun.dispose();
    }
  }

  protected async runTestFiles(
    files: readonly string[],
    concurrency = this.testConcurrency,
    fixtureEnvironment: Record<string, string> = {},
  ) {
    const testProcessRoot = path.join(this.projectRoot, "daemon");
    const reporter = pathToFileURL(path.join(this.projectRoot, "test", "concise-test-reporter.mjs")).href;
    const testArguments = files.map((file) => path.relative(testProcessRoot, file).replaceAll("\\", "/"));
    return await new Promise<TestProcessResult>((resolve, reject) => {
      const child = this.spawnProcess(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--test",
        `--test-concurrency=${concurrency}`,
        `--test-timeout=${this.testTimeoutMs}`,
        `--test-reporter=${reporter}`,
        ...testArguments,
      ], {
        cwd: testProcessRoot,
        env: { ...process.env, ...fixtureEnvironment },
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  }
}

export async function runProjectTests(projectRoot: string, arguments_: readonly string[]) {
  const { inputs } = parseProjectTestRunnerArguments(arguments_);
  return await new ProjectTestRunner(projectRoot).run(inputs);
}
