/*
 * Default export:
 * - ProjectTestRunner: deterministically discovers TypeScript tests and owns the Node test-runner child lifecycle. Keywords: tests, discovery, TypeScript, lifecycle, Windows.
 */
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXCLUDED_DIRECTORY_NAMES = new Set([".next", "build", "coverage", "dist", "generated", "node_modules"]);
const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const TEST_TIMEOUT_MS = 30_000;

type TestProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export default class ProjectTestRunner {
  constructor(private readonly projectRoot = process.cwd()) {}

  async discoverTestFiles(inputs: readonly string[] = ["."]) {
    const discovered = new Set<string>();
    for (const input of inputs) await this.discoverPath(path.resolve(this.projectRoot, input), discovered);
    return [...discovered].sort(comparePaths);
  }

  async run(inputs: readonly string[] = ["."]) {
    const files = await this.discoverTestFiles(inputs);
    if (files.length === 0) throw new Error(`No .test.ts or .test.tsx files found under: ${inputs.join(", ")}`);

    const reporter = pathToFileURL(path.join(this.projectRoot, "scripts", "concise-test-reporter.mjs")).href;
    const testArguments = files.map((file) => path.relative(this.projectRoot, file).replaceAll("\\", "/"));
    return await new Promise<TestProcessResult>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--test",
        `--test-timeout=${TEST_TIMEOUT_MS}`,
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
  const inputs = process.argv.slice(2).filter((argument) => argument !== "--");
  const result = await new ProjectTestRunner().run(inputs.length > 0 ? inputs : ["."]);
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
