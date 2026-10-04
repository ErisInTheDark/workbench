/*
 * Exports:
 * - default ProjectTestRunner: validate test discovery and own fixtures and Node test-runner children.
 * - ProjectTestRunnerOptions/PreparedTestFixtures: inject runner-owned fixture setup, cleanup, process spawning, concurrency, and optional timeout.
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
import ProjectTestProcess, { type ProjectTestProcessResult } from "./ProjectTestProcess";
import WorkbenchTestProcessResources from "../daemon/server/WorkbenchTestProcessResources";

const GIT_TEST_CONCURRENCY = 1;
const NESTED_GIT_TEST_CONCURRENCY = 1;
const ORDINARY_TEST_CONCURRENCY = 8;
const TEST_CONCURRENCY = Math.max(1, Math.min(8, availableParallelism()));
const TEST_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 300_000;

/**
 * Ambient agent identity belongs to the invoking shell, not to the tests it runs.
 * The suite must see the same world whoever runs it, so a fixture that needs one sets it explicitly.
 */
const AMBIENT_AGENT_IDENTITY_ENV = ["WORKBENCH_HARNESS", "WORKBENCH_THREAD_ID", "WORKBENCH_ORIGIN", "CODEX_THREAD_ID"] as const;

function withoutAmbientAgentIdentity(environment: NodeJS.ProcessEnv) {
  const sanitized = { ...environment };
  for (const key of AMBIENT_AGENT_IDENTITY_ENV) delete sanitized[key];
  return sanitized;
}

export interface ProjectTestRunnerOptions {
  acquireTestRun?: () => Promise<ProjectTestRunLease>;
  prepareTestFixtures?: (files: readonly string[], temporaryRootPath: string) => Promise<PreparedTestFixtures>;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit"; detached: boolean; windowsHide: boolean },
  ) => ChildProcess;
  testConcurrency?: number;
  testTimeoutMs?: number | null;
  fileTimeoutMs?: number;
  signal?: AbortSignal;
  ownProcess?: (child: ChildProcess, file: string, timeoutMs: number, signal: AbortSignal) => Promise<ProjectTestProcessResult>;
  report?: (message: string) => void;
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
  private readonly testTimeoutMs: number | null;
  private readonly fileTimeoutMs: number;
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private readonly ownProcess: NonNullable<ProjectTestRunnerOptions["ownProcess"]>;
  private readonly report: (message: string) => void;

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
    const requestedTimeoutMs = Object.hasOwn(options, "testTimeoutMs") ? options.testTimeoutMs ?? null : TEST_TIMEOUT_MS;
    if (requestedTimeoutMs !== null && (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1)) {
      throw new Error("Test timeout must be a positive integer of milliseconds.");
    }
    this.testTimeoutMs = requestedTimeoutMs;
    this.fileTimeoutMs = options.fileTimeoutMs ?? FILE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.fileTimeoutMs) || this.fileTimeoutMs < 1) {
      throw new Error("Test-file timeout must be a positive integer of milliseconds.");
    }
    this.signal = options.signal
      ? AbortSignal.any([this.cancellation.signal, options.signal])
      : this.cancellation.signal;
    this.report = options.report ?? console.log;
    this.ownProcess = options.ownProcess ?? ((child, file, timeoutMs, signal) =>
      new ProjectTestProcess(child, file, { timeoutMs, signal, report: this.report }).wait());
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
    const cancel = () => this.cancellation.abort(new Error("Test command interrupted."));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
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
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      await testRun.dispose();
    }
  }

  protected async runTestFiles(
    files: readonly string[],
    concurrency = this.testConcurrency,
    fixtureEnvironment: Record<string, string> = {},
  ) {
    if (this.signal.aborted) return { exitCode: 130, signal: null };
    const testProcessRoot = path.join(this.projectRoot, "daemon");
    const reporter = pathToFileURL(path.join(this.projectRoot, "test", "concise-test-reporter.mjs")).href;
    const budget = Math.ceil(files.length / concurrency) * this.fileTimeoutMs;
    const label = files.length === 1
      ? path.relative(this.projectRoot, files[0]!).replaceAll("\\", "/")
      : `${files.length} test files`;
    const services = await WorkbenchTestProcessResources.create(true, this.projectRoot);
    try {
      if (this.signal.aborted) return { exitCode: 130, signal: null };
      const child = this.spawnProcess(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--test",
        "--test-force-exit",
        `--test-concurrency=${concurrency}`,
        ...(this.testTimeoutMs === null ? [] : [`--test-timeout=${this.testTimeoutMs}`]),
        `--test-reporter=${reporter}`,
        ...files.map(file => path.relative(testProcessRoot, file).replaceAll("\\", "/")),
      ], {
        cwd: testProcessRoot,
        env: { ...withoutAmbientAgentIdentity(process.env), ...fixtureEnvironment, ...services.environment },
        stdio: "inherit",
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.report(`TEST ${label} (pid ${child.pid ?? "unstarted"}, budget ${budget}ms)`);
      return await this.ownProcess(child, label, budget, this.signal);
    } finally {
      await services.dispose();
    }
  }
}

export async function runProjectTests(projectRoot: string, arguments_: readonly string[]) {
  const { inputs } = parseProjectTestRunnerArguments(arguments_);
  return await new ProjectTestRunner(projectRoot).run(inputs);
}
