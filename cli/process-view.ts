/*
 * No exports. Attach a local terminal to the local Workbench stack: always tail combined logs and offer lifecycle keybinds.
 * Runs natively without tsx, so it works while a dependency repair has node_modules in flux; full controls load once
 * dependencies are whole.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";
import WorkbenchProcessView from "./WorkbenchProcessView.ts";
import createWorkbenchRepairViewControls from "./WorkbenchRepairViewControls.ts";
import loadProcessViewControls from "./load-process-view-controls.ts";

const warn = (text: string) => process.stderr.write(`${text}\n`);
const write = async (text: string) => {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
};

function logPrefixes(target: string) {
  if (target === "app") return ["workbench-app", "workbench-update"] as const;
  if (target === "daemon") return ["workbench-host"] as const;
  return ["workbench-app", "workbench-host", "workbench-update"] as const;
}

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Interactive process views are human-only. Agents can inspect persisted logs.");
  }
  const [target = "all", ...rest] = process.argv.slice(2);
  if ((target !== "daemon" && target !== "app" && target !== "all") || rest.length) throw new Error("Usage: wb view [daemon|app]");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = resolveWorkbenchDataRoot();
  const repair = await createWorkbenchRepairViewControls({ dataRoot, repositoryRoot });
  const view = new WorkbenchProcessView({
    input: process.stdin,
    write,
    warn,
    logDirectory: path.join(repositoryRoot, ".workbench", "logs"),
    prefixes: logPrefixes(target),
    repair,
    openControls: async (warnMessage, signal) => {
      await repair.whenIdle(signal);
      return await loadProcessViewControls({ dataRoot, repositoryRoot, warn: warnMessage });
    },
  });
  const detach = () => view.detach();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, detach);
  try { await view.run(); }
  finally {
    for (const signal of signals) process.off(signal, detach);
    repair.close();
  }
}

void main().catch(error => { warn(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
