/*
 * No exports. Run one exact provider scenario inside its parent-owned validation budget.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarios = {
  codex: "test/scenarios/codex.scenario.test.ts",
  opencode: "test/scenarios/opencode.scenario.test.ts",
};
const [provider, file] = process.argv.slice(2);
if (!(provider in scenarios) || file !== scenarios[provider]) {
  throw new Error("The live provider runner accepts only an exact allowlisted scenario.");
}

process.env[provider === "codex" ? "WORKBENCH_CODEX_TEST_FILE" : "WORKBENCH_OPENCODE_TEST_FILE"] = file;
const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
const result = await new ProjectTestRunner(projectRoot, {
  testConcurrency: 1,
  testTimeoutMs: null,
  fileTimeoutMs: 1_200_000,
  // Like lifecycle, real-provider journeys intentionally report progress and
  // retained diagnostics. Unit suites still enforce the concise noise policy.
  spawnProcess: (command, args, options) => spawn(command,
    args.map(arg => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
}).run([file]);
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
