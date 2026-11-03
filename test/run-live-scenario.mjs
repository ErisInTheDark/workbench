/*
 * Exports:
 * - runLiveScenario: hand `wb test live` arguments to the trusted daemon, which runs the scenario outside the caller's
 *   sandbox; show its output as it streams and exit with the code its final exit line reports.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveScenarioExit } from "../shared/workbench/commands/live-scenario-exit.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Enough trailing output to always hold the exit line. */
const TAIL_CHARACTERS = 256;

export function runLiveScenario(args) {
  const child = spawn("bash", [path.join(projectRoot, "wb"), "test", "live", ...args], {
    cwd: projectRoot,
    // Agents that may only reach wb through MCP still let their own validation scripts call it.
    env: { ...process.env, THIS_IS_A_MANAGED_SCRIPT: "1" },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  let tail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    tail = (tail + chunk).slice(-TAIL_CHARACTERS);
  });
  child.once("error", error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (exitCode, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    // The daemon refused the request outright, or its stream broke off before the exit line.
    else process.exitCode = exitCode !== 0 ? exitCode ?? 1 : LiveScenarioExit.read(tail) ?? 1;
  });
}
