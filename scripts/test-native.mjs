/*
 * No exports. Run shared native and platform launcher regression tests.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import SetupCommand from "../package/SetupCommand.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = new SetupCommand();
for (const project of ["shared/native", "app/tray", ...(process.platform === "win32" ? ["daemon/host/native"] : [])]) {
  await command.run("cargo", ["test", "--manifest-path", path.join(root, project, "Cargo.toml")], { cwd: root });
}
