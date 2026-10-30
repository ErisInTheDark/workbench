/*
 * No exports. Run the two-daemon networking scenario outside normal discovery; fake model turns only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "test/scenarios/daemons.scenario.test.ts";
const args = process.argv.slice(2).filter((value) => value !== "--");
if (args.length && (args.length !== 1 || args[0] !== file)) {
  console.error("Run: pnpm test:daemons");
  process.exitCode = 1;
} else {
  process.chdir(path.join(root, "daemon"));
  const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
  console.log("Two isolated daemons behind one app, with fake Codex turns.");
  // Fifteen minutes for two installations and their scripted turns, with the remaining minute reserved for cleanup.
  const result = await new ProjectTestRunner(root, {
    testConcurrency: 1, testTimeoutMs: 960_000,
    fileTimeoutMs: 960_000,
    spawnProcess: (command, args, options) => spawn(command,
      args.map((arg) => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
  }).run([file]);
  if (result.signal !== null) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
}
