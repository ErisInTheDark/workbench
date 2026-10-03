/*
 * No exports. Daemon-run entry for the installer sandbox scenario inside its parent-owned validation budget.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv.slice(2).join(" ");
if (file !== "test/install/InstallSandbox.scenario.test.ts") {
  throw new Error("The live install runner accepts only its exact allowlisted scenario.");
}

const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
console.log("Real npm package, clone, Vite+ dependency install and build in a sandboxed home; host actions pretend.");
// Dependency install and the frontend build dominate; the shared pnpm store keeps warm runs well inside budget.
const result = await new ProjectTestRunner(projectRoot, {
  testConcurrency: 1,
  testTimeoutMs: null,
  fileTimeoutMs: 660_000,
  spawnProcess: (command, args, options) => spawn(command,
    args.map(arg => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
}).run([file]);
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
