/*
 * Exports:
 * - runLiveScenario: hand `wb test live` arguments to the trusted daemon and mirror its exit status.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runLiveScenario(args) {
  const executable = path.join(projectRoot, "daemon", "node_modules", ".bin", "wb");
  const child = spawn(process.platform === "win32" ? "bash" : executable, [
    ...(process.platform === "win32" ? [executable] : []),
    "test", "live", ...args,
  ], {
    cwd: projectRoot,
    env: process.env,
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
