/*
 * No exports. Admits only the explicitly named paid Codex scenario through the trusted daemon.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "test/scenarios/codex.scenario.test.ts";
const args = process.argv.slice(2).filter((value) => value !== "--");
if (args.length !== 1 || args[0] !== file) {
  console.error(`Real Codex usage required. Run: pnpm test:codex -- ${file}`);
  process.exitCode = 1;
} else {
  console.log("Paid live scenario: five short luna.low turns and compaction, isolated runtime, exact created-thread cleanup.");
  const executable = path.join(projectRoot, "daemon", "node_modules", ".bin", "wb");
  const child = spawn(process.platform === "win32" ? "bash" : executable, [
    ...(process.platform === "win32" ? [executable] : []),
    "test",
    "live",
    "codex",
    "--",
    file,
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
