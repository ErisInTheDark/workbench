/*
 * No exports. Daemon-run entry for the Claude account privacy scenario inside its parent-owned validation budget.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv.slice(2).join(" ");
if (file !== "daemon/server/providers/claude/claude-account-privacy.scenario.test.ts") {
  throw new Error("The live Claude account runner accepts only its exact allowlisted scenario.");
}

const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
console.log("Pinned Claude with the real login and real startup traffic; prompts reach a local stand-in, so no model turn runs.");
const result = await new ProjectTestRunner(projectRoot, {
  testConcurrency: 1,
  testTimeoutMs: null,
  fileTimeoutMs: 300_000,
  spawnProcess: (command, args, options) => spawn(command,
    args.map(arg => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
}).run([file]);
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
