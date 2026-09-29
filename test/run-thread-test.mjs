/*
 * No exports. Require explicit provider modes, then use the trusted daemon's isolated live-test owner.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseThreadTestArguments } from "./thread-test-arguments.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let providers;
try {
  providers = parseThreadTestArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

if (providers) {
  const file = "test/scenarios/thread.scenario.test.ts";
  const executable = path.join(projectRoot, "daemon", "node_modules", ".bin", "wb");
  const child = spawn(process.platform === "win32" ? "bash" : executable, [
    ...(process.platform === "win32" ? [executable] : []),
    "test", "live",
    ...Object.entries(providers).map(([provider, mode]) => `--${provider}=${mode}`),
    "--", file,
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
