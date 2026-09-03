/*
 * Keywords: tests, CLI, cwd, lifecycle.
 * No exports. This process entry establishes the daemon-compatible cwd before loading the root project test runner.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(path.join(projectRoot, "daemon"));

try {
  const { runProjectTests } = await import("./ProjectTestRunner.ts");
  const result = await runProjectTests(projectRoot, process.argv.slice(2));
  if (result.signal !== null) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
