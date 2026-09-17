/*
 * No exports. Run one lifecycle integration test outside normal discovery.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "test/scenarios/lifecycle.scenario.test.ts";
const args = process.argv.slice(2).filter((value) => value !== "--");
if (args.length && (args.length !== 1 || args[0] !== file)) {
  console.error("Run: pnpm test:lifecycle");
  process.exitCode = 1;
} else {
  process.chdir(path.join(root, "daemon"));
  process.env.WORKBENCH_LIFECYCLE_TEST_FILE = file;
  const { default: ProjectTestRunner } = await import("./ProjectTestRunner.ts");
  console.log("Isolated lifecycle scenario: real app/daemon, no model turns.");
  // Ten minutes for the scenario, then two independent process cleanup budgets.
  const result = await new ProjectTestRunner(root, {
    testConcurrency: 1, testTimeoutMs: 720_000,
    spawnProcess: (command, args, options) => spawn(command,
      args.map((arg) => arg.startsWith("--test-reporter=") ? "--test-reporter=spec" : arg), options),
  }).run([file]);
  if (result.signal !== null) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
}
