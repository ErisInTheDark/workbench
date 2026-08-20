/*
 * Default export:
 * - ProjectTestRunner: deterministically discovers TypeScript tests and owns the Node test-runner child lifecycle. Keywords: tests, discovery, TypeScript, lifecycle, Windows.
 * - ProjectTestRunnerOptions: inject fixture prewarming, process spawning, bounded file concurrency, and timeout for regression wards. Keywords: tests, fixtures, process, concurrency, timeout.
 * - parseProjectTestRunnerArguments/ProjectTestRunnerArguments: parse the cooperative full-suite flag and discovery inputs. Keywords: tests, CLI, good citizen, concurrency.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { prewarmWorkbenchGitTestFixtures } from "../lib/workbench/git/WorkbenchGitTestFixtures";

const EXCLUDED_DIRECTORY_NAMES = new Set([".next", "build", "coverage", "dist", "generated", "node_modules"]);
const GOOD_CITIZEN_TEST_TIMEOUT_MS = 120_000;
const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const TEST_CONCURRENCY = Math.max(1, Math.min(8, availableParallelism()));
const TEST_TIMEOUT_MS = 30_000;

type TestProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export interface ProjectTestRunnerOptions {
  prewarmTestFixtures?: (files: readonly string[]) => Promise<void>;
  spawnProcess?: (command: string, args: readonly string[], options: { cwd: string; stdio: "inherit" }) => ChildProcess;
  testConcurrency?: number;
  testTimeoutMs?: number;
}

export interface ProjectTestRunnerArguments {
  inputs: string[];
  testConcurrency?: number;
  testTimeoutMs?: number;
}

export function parseProjectTestRunnerArguments(arguments_: readonly string[]): ProjectTestRunnerArguments {
  const inputs: string[] = [];
  let goodCitizen = false;
  for (const argument of arguments_) {
    if (argument === "--") continue;
    if (argument === "--good-citizen") {
      goodCitizen = true;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown test runner option: ${argument}`);
    inputs.push(argument);
  }
  return {
    inputs: inputs.length ? inputs : ["."],
    ...(goodCitizen ? { testConcurrency: 1, testTimeoutMs: GOOD_CITIZEN_TEST_TIMEOUT_MS } : {}),
  };
}

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export default class ProjectTestRunner {
  private readonly prewarmTestFixtures: (files: readonly string[]) => Promise<void>;
  private readonly spawnProcess: NonNullable<ProjectTestRunnerOptions["spawnProcess"]>;
  private readonly testConcurrency: number;
  private readonly testTimeoutMs: number;

  constructor(
    private readonly projectRoot = process.cwd(),
    options: ProjectTestRunnerOptions = {},
  ) {
    this.prewarmTestFixtures = options.prewarmTestFixtures ?? prewarmWorkbenchGitTestFixtures;
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

  async discoverTestFiles(inputs: readonly string[] = ["."]) {
    const discovered = new Set<string>();
    for (const input of inputs) await this.discoverPath(path.resolve(this.projectRoot, input), discovered);
    return [...discovered].sort(comparePaths);
  }

  async run(inputs: readonly string[] = ["."]) {
    const files = await this.discoverTestFiles(inputs);
    if (files.length === 0) throw new Error(`No .test.ts or .test.tsx files found under: ${inputs.join(", ")}`);

    await this.prewarmTestFixtures(files);
    return await this.runTestFiles(files);
  }

  protected async runTestFiles(files: readonly string[]) {
    const reporter = pathToFileURL(path.join(this.projectRoot, "scripts", "concise-test-reporter.mjs")).href;
    const testArguments = files.map((file) => path.relative(this.projectRoot, file).replaceAll("\\", "/"));
    return await new Promise<TestProcessResult>((resolve, reject) => {
      const child = this.spawnProcess(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--test",
        `--test-concurrency=${this.testConcurrency}`,
        `--test-timeout=${this.testTimeoutMs}`,
        `--test-reporter=${reporter}`,
        ...testArguments,
      ], {
        cwd: this.projectRoot,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  }

  private async discoverPath(candidate: string, discovered: Set<string>): Promise<void> {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) {
      if (TEST_FILE_PATTERN.test(path.basename(candidate))) discovered.add(candidate);
      return;
    }
    if (!candidateStat.isDirectory() || EXCLUDED_DIRECTORY_NAMES.has(path.basename(candidate))) return;

    const entries = await readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      await this.discoverPath(path.join(candidate, entry.name), discovered);
    }
  }
}

async function main() {
  const { inputs, testConcurrency, testTimeoutMs } = parseProjectTestRunnerArguments(process.argv.slice(2));
  const runnerOptions: ProjectTestRunnerOptions = {
    ...(testConcurrency === undefined ? {} : { testConcurrency }),
    ...(testTimeoutMs === undefined ? {} : { testTimeoutMs }),
  };
  const result = await new ProjectTestRunner(process.cwd(), runnerOptions).run(inputs);
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.exitCode ?? 1;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
