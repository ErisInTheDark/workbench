/*
 * No exports. Checkout-owned human commands, including managed provider passthrough and the `idle` busy-lease check, preserve daemon shell dispatch.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchBootstrapCommand, { WorkbenchChildExitError } from "../package/WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "../package/WorkbenchToolchain.mjs";
import { readJournal, isRepairPending, resolveDataRoot } from "../scripts/installation/update-journal.mjs";
import { runRepair } from "../scripts/installation/update-repair.mjs";
import { readWorkbenchBusyLeases } from "../shared/WorkbenchBusyLease.mjs";

/** sysexits EX_TEMPFAIL: busy now, retry later; other failures exit 1. */
const BUSY_EXIT_CODE = 75;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const view = args[0] === "view" && (args.length === 1 || args.length === 2 && ["daemon", "app"].includes(args[1]));
const provider = ["codex", "claude", "opencode"].includes(args[0]);
const command = view ? "view" : args.length === 0 ? "start" : args.length === 1 ? args[0] : null;
try {
  const native = ["start", "shortcut", "connect", "disconnect", "view", "repair"].includes(command);
  const humanOnly = native || provider;
  const managed = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim();
  if (humanOnly && managed) throw new Error("Managed threads cannot launch or configure Workbench services.");
  if (command === "ports") {
    await new WorkbenchBootstrapCommand().run(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      path.join(root, "cli/workbench-ports.ts"),
    ], { cwd: root, interactive: true });
  } else if (command === "idle") {
    // Read-only and dependency-free: never waits behind or starts a pending repair.
    const leases = await readWorkbenchBusyLeases(resolveDataRoot());
    for (const lease of leases) process.stdout.write(`${lease.holder}: ${lease.reasons.join(", ")}\n`);
    if (leases.length) process.exitCode = BUSY_EXIT_CODE;
  } else {
    // `wb view` watches, cancels and retries repairs, so it never waits behind one.
    if (command === "repair" || !view && isRepairPending(await readJournal())) {
      if (managed) throw new Error("Dependency update repair is pending. Ask the user to run `wb repair`.");
      const journal = await runRepair({ root, force: command === "repair" });
      if (journal && journal.phase !== "done") throw new Error(
        `Workbench update repair failed: ${journal.lastError ?? "repair incomplete"}. Run \`wb repair\` (log: ${journal.logPath}).`,
      );
    }
    if (command === "repair") {
      process.stdout.write("Workbench dependency repair complete. Run `wb` to launch.\n");
    } else if (view) {
      // Native type stripping: node_modules (and tsx) may be mid-repair.
      await new WorkbenchToolchain().runNode(root, path.join(root, "cli/process-view.ts"), args.slice(1), {
        cwd: root, interactive: true, nodeOptions: ["--disable-warning=ExperimentalWarning"],
      });
    } else if (provider) {
      // The caller's cwd is the provider's working directory, so tsx resolves from the checkout instead.
      await new WorkbenchToolchain().runNode(root, path.join(root, "cli/provider-passthrough.ts"), args, {
        interactive: true, nodeOptions: ["--disable-warning=ExperimentalWarning", "--import", import.meta.resolve("tsx")],
      });
    } else if (native) {
      const entry = ["start", "shortcut"].includes(command) ? "app/server/desktop.ts" : "daemon/host/connect.ts";
      await new WorkbenchToolchain().runNode(root, path.join(root, entry), [command], {
        cwd: root, interactive: false, nodeOptions: ["--disable-warning=ExperimentalWarning", "--import", "tsx"],
      });
    } else {
      await new WorkbenchBootstrapCommand().run("bash", [path.join(root, "wb"), ...args], { interactive: true });
    }
  }
} catch (error) {
  // A child that exited with a status already reported its own failure.
  if (!(error instanceof WorkbenchChildExitError)) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
