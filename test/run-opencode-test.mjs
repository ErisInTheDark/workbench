/*
 * No exports. Admits only the explicitly named paid-model OpenCode provider scenario through the trusted daemon.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "test/scenarios/opencode.scenario.test.ts";
const args = process.argv.slice(2).filter(value => value !== "--");
if (args.length !== 1 || args[0] !== file) {
  console.error(`Real OpenCode access required. Run: pnpm test:opencode -- ${file}`);
  process.exitCode = 1;
} else {
  console.log("Paid live provider journey: Muse Spark 1.3, isolated Workbench data, exact native-session cleanup.");
  const executable = path.join(projectRoot, "daemon", "node_modules", ".bin", "wb");
  const child = spawn(process.platform === "win32" ? "bash" : executable, [
    ...(process.platform === "win32" ? [executable] : []),
    "test",
    "live",
    "opencode",
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
