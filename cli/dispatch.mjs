/*
 * No exports. Checkout-owned human commands preserve daemon shell dispatch.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchBootstrapCommand from "../package/WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "../package/WorkbenchToolchain.mjs";
import { readJournal, isRepairPending } from "../installation/update-journal.mjs";
import { runRepair } from "../installation/update-repair.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const view = args[0] === "view" && (args.length === 1 || args.length === 2 && ["daemon", "app"].includes(args[1]));
const command = view ? "view" : args.length === 0 ? "start" : args.length === 1 ? args[0] : null;
try {
  const native = ["start", "shortcut", "connect", "disconnect", "view", "ports", "repair"].includes(command);
  const humanOnly = ["start", "shortcut", "connect", "disconnect", "view", "repair"].includes(command);
  const managed = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim();
  if (humanOnly && managed) throw new Error("Managed threads cannot launch or configure Workbench services.");
  if (command === "repair" || isRepairPending(await readJournal())) {
    if (managed) throw new Error("Dependency update repair is pending. Ask the user to run `wb repair`.");
    const journal = await runRepair({ root, force: command === "repair" });
    if (journal && journal.phase !== "done") throw new Error(
      `Workbench update repair failed: ${journal.lastError ?? "repair incomplete"}. Run \`wb repair\` (log: ${journal.logPath}).`,
    );
  }
  if (command === "repair") {
    process.stdout.write("Workbench dependency repair complete. Run `wb` to launch.\n");
  } else if (native) {
    const entry = view
      ? "cli/process-view.ts"
      : command === "ports"
        ? "cli/workbench-ports.ts"
        : ["start", "shortcut"].includes(command) ? "app/server/desktop.ts" : "daemon/host/connect.ts";
    await new WorkbenchToolchain().runNode(root, path.join(root, entry), [
      ...(view ? args.slice(1) : command === "ports" ? [] : [command]),
    ], { cwd: root, interactive: view, nodeOptions: ["--disable-warning=ExperimentalWarning", "--import", "tsx"] });
  } else {
    await new WorkbenchBootstrapCommand().run("bash", [path.join(root, "wb"), ...args]);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
