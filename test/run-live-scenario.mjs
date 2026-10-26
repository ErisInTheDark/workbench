/*
 * Exports:
 * - runLiveScenario: hand `wb test live` arguments to the trusted daemon, which runs the scenario outside the caller's
 *   sandbox, and mirror its exit status.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runLiveScenario(args) {
  const child = spawn("bash", [path.join(projectRoot, "wb"), "test", "live", ...args], {
    cwd: projectRoot,
    // Agents that may only reach wb through MCP still let their own validation scripts call it.
    env: { ...process.env, THIS_IS_A_MANAGED_SCRIPT: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (exitCode, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = exitCode ?? 1;
  });
}
