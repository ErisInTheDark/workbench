/*
 * No exports. Run one exact scenario for explicit provider modes inside its parent-owned validation budget.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseThreadTestArguments } from "./thread-test-arguments.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = process.argv.slice(2);
const file = values.pop();
const providers = parseThreadTestArguments(values);
if (file !== "test/scenarios/thread.scenario.test.ts") {
  throw new Error("The live provider runner accepts only an exact allowlisted scenario.");
}

process.env.WORKBENCH_THREAD_TEST_SELECTION = JSON.stringify(providers);
const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
const result = await new ProjectTestRunner(projectRoot, {
  testConcurrency: 1,
  testTimeoutMs: null,
  fileTimeoutMs: 300_000,
  // Like lifecycle, real-provider journeys intentionally report progress and
  // retained diagnostics. Unit suites still enforce the concise noise policy.
  spawnProcess: (command, args, options) => spawn(command,
    args.map(arg => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
}).run([file]);
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
