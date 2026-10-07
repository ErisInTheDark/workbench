/*
 * No exports. Attach a local terminal to the local Workbench stack: always tail combined logs and offer lifecycle keybinds.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";
import WorkbenchProcessView from "./WorkbenchProcessView.ts";
import createWorkbenchProcessViewControls from "./WorkbenchProcessViewControls.ts";

const warn = (text: string) => process.stderr.write(`${text}\n`);
const write = async (text: string) => {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
};

function logPrefixes(target: string) {
  if (target === "app") return ["workbench-app"] as const;
  if (target === "daemon") return ["workbench-host"] as const;
  return ["workbench-app", "workbench-host"] as const;
}

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Interactive process views are human-only. Agents can inspect persisted logs.");
  }
  const [target = "all", ...rest] = process.argv.slice(2);
  if ((target !== "daemon" && target !== "app" && target !== "all") || rest.length) throw new Error("Usage: wb view [daemon|app]");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const view = new WorkbenchProcessView({
    input: process.stdin,
    write,
    warn,
    logDirectory: path.join(repositoryRoot, ".workbench", "logs"),
    prefixes: logPrefixes(target),
    openControls: warnMessage => createWorkbenchProcessViewControls({
      dataRoot: resolveWorkbenchDataRoot(),
      repositoryRoot,
      warn: warnMessage,
    }),
  });
  const detach = () => view.detach();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, detach);
  try { await view.run(); }
  finally { for (const signal of signals) process.off(signal, detach); }
}

void main().catch(error => { warn(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
