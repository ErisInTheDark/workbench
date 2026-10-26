/*
 * Exports:
 * - runCommand: run one repository script child with inherited output, repository-local temp and typed failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds never write to the user's temp folder, which agent sandboxes also deny.
const temporary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".workbench", "tmp", "scripts");

export async function runCommand(command, args, { cwd } = {}) {
  await fs.mkdir(temporary, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: "inherit", windowsHide: true,
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(
        `${command} failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}.`,
      ), { exitCode: code ?? 1 }));
    });
  });
}
