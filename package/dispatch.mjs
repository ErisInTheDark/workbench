/*
 * No exports. Checkout-owned human commands preserve daemon shell dispatch.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import SetupCommand from "./SetupCommand.mjs";
import { access } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.length === 0 ? "start" : args.length === 1 ? args[0] : null;
try {
  if (["start", "shortcut", "connect", "disconnect"].includes(command)) {
    if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
      throw new Error("Managed threads cannot launch or configure Workbench services.");
    }
    const entry = ["start", "shortcut"].includes(command) ? "app/server/desktop.ts" : "daemon/host/connect.ts";
    const node = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "node.exe" : "node");
    try { await access(node); }
    catch (error) { throw new Error("The checkout's Node runtime is unavailable. Run pnpm install in the Workbench repository.", { cause: error }); }
    await new SetupCommand().run(node, [
      "--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(root, entry), command,
    ], { cwd: root });
  } else {
    await new SetupCommand().run("bash", [path.join(root, "wb"), ...args]);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
