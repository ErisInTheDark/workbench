/*
 * No exports. Run shared native and platform launcher regression tests.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const project of ["shared/native", "app/tray", ...(process.platform === "win32" ? ["daemon/host/native"] : [])]) {
  await runCommand("cargo", ["test", "--manifest-path", path.join(root, project, "Cargo.toml")], { cwd: root });
}
