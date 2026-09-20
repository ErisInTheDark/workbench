/*
 * No exports. Runs one daemon-admitted exact provider scenario without a manufactured test deadline.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}).run([file]);
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
