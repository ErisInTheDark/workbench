/*
 * No exports. Human CLI controls independent startup, remote wake and development wake.
 */
import path from "node:path";
import WorkbenchServiceStartup from "./WorkbenchServiceStartup.ts";
import WorkbenchServiceLauncher from "./WorkbenchServiceLauncher.ts";
import WorkbenchServiceClient from "../../shared/process/WorkbenchServiceClient.ts";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Managed threads cannot change installation service startup.");
  }
  const command = process.argv[2];
  if (!["connect", "disconnect", "wake", "status"].includes(command ?? "")) throw new Error("Usage: wb connect | wb disconnect | pnpm dev");
  const root = path.resolve(import.meta.dirname, "../..");
  const warn = (message: string) => process.stderr.write(`${message}\n`);
  const startup = new WorkbenchServiceStartup({ root });
  const launcher = new WorkbenchServiceLauncher({ root, startup, warn });
  const client = new WorkbenchServiceClient({
    endpointPath: path.join(resolveWorkbenchDataRoot(), "service", "runtime.json"), warn,
  });
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("Service command cancelled."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "connect") await startup.setEnabled(true);
    if (command === "disconnect") await startup.setEnabled(false);
    await launcher.ensure(abort.signal);
    await client.start();
    if (command === "connect" || command === "disconnect") {
      await client.request({ method: "service/wake/enable", enabled: command === "connect" }, abort.signal);
      process.stdout.write(command === "connect" ? "Workbench wake service enabled.\n" : "Workbench wake service disabled; active work is unchanged.\n");
    } else if (command === "wake") {
      await client.request({ method: "service/daemon/wake", retry: true }, abort.signal);
      process.stdout.write("Workbench daemon requested.\n");
    } else {
      process.stdout.write(`${JSON.stringify(client.getSnapshot().snapshot?.identity)}\n`);
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    const results = await Promise.allSettled([client.close(), launcher.close()]);
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Service command cleanup failed.");
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
