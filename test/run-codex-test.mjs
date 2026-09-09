/*
 * Keywords: paid test, explicit opt-in, lifecycle.
 * No exports. Runs only the explicitly named live diagnostic through the project runner.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "diagnostics/workbench-codex.test.ts";
const args = process.argv.slice(2).filter((value) => value !== "--");
if (args.length !== 1 || args[0] !== file) {
  console.error(`Real Codex usage required. Run: pnpm test:codex -- ${file}`);
  process.exitCode = 1;
} else {
  process.chdir(path.join(projectRoot, "daemon"));
  process.env.WORKBENCH_CODEX_TEST_FILE = file;
  console.log("Paid live diagnostic: one luna.low turn, isolated runtime, exact created-thread cleanup.");
  const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
  // The test owns a ten-minute spend budget, including cleanup. The runner only
  // guards a wedged test process after that lifecycle has had time to retire.
  const result = await new ProjectTestRunner(projectRoot, {
    testConcurrency: 1, testTimeoutMs: 660_000,
    spawnProcess: (command, args, options) => spawn(command, args.map((arg) => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
  }).run([file]);
  if (result.signal !== null) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
}
