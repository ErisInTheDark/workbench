/*
 * Exports:
 * - runCommand: run one repository script child with inherited output and typed failure.
 */
import { spawn } from "node:child_process";

export function runCommand(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(
        `${command} failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}.`,
      ), { exitCode: code ?? 1 }));
    });
  });
}
