/*
 * No exports. Launch the foreground development host and retain terminal ownership.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchForegroundHost from "./WorkbenchForegroundHost.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Managed threads cannot launch the foreground Workbench daemon.");
  }
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--dry-run") {
    process.stdout.write("Workbench would start its foreground host and daemon; no background startup registration is changed.\n");
    return;
  }
  if (args.length) throw new Error("Usage: pnpm dev [--dry-run]");
  const host = new WorkbenchForegroundHost({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    dataRoot: resolveWorkbenchDataRoot(),
    output: text => process.stdout.write(text),
    warn: text => process.stderr.write(`${text}\n`),
  });
  let stopRequested = false;
  const stop = () => {
    if (stopRequested) { host.forceStop(); return; }
    stopRequested = true;
    void host.stop().catch(error => {
      process.stderr.write(`Foreground shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  try { await host.run(); }
  finally { for (const signal of signals) process.off(signal, stop); }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
