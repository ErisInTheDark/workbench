/*
 * No exports. Attach a local terminal to an existing daemon host or app without launching it.
 */
import path from "node:path";
import { once } from "node:events";
import { watch } from "node:fs";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";
import WorkbenchServiceClient from "../shared/process/WorkbenchServiceClient.ts";
import { readServiceEndpoint, verifyServiceEndpoint } from "../shared/process/workbench-service-endpoint.ts";
import { WorkbenchAppProcessInfoSchema } from "../shared/http/workbench-app-control.ts";
import WorkbenchProcessView, { type ProcessViewConnection } from "./WorkbenchProcessView.ts";

const warn = (text: string) => process.stderr.write(`${text}\n`);
const write = async (text: string) => {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
};

async function appConnection(lifetime: AbortSignal): Promise<ProcessViewConnection> {
  const endpointPath = path.join(resolveWorkbenchDataRoot(), "app", "runtime.json");
  const endpoint = await readServiceEndpoint(endpointPath);
  if (!endpoint) throw new Error("The Workbench app is not running. No process was started.");
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, lifetime]);
  const readCurrent = async () => {
    const current = await readServiceEndpoint(endpointPath);
    if (!current || current.instanceId !== endpoint.instanceId) throw new Error("The viewed app stopped or was replaced. Attach again to control the new process.");
    await verifyServiceEndpoint(current, signal, (_input, init) =>
      fetch(`${current.origin}/_workbench-control/health`, init));
    return current;
  };
  const current = await readCurrent();
  const response = await fetch(`${current.origin}/_workbench-control/process`, {
    headers: { Authorization: `Bearer ${current.token}` }, redirect: "error", signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("App process information is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new Error("App process information exceeds its size limit."); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const info = WorkbenchAppProcessInfoSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (info.instanceId !== endpoint.instanceId) throw new Error("App process identity changed while attaching.");
  let observing = Promise.resolve();
  let unavailable = false;
  const watcher = watch(path.dirname(endpointPath), (_event, name) => {
    if (name && name.toString() !== path.basename(endpointPath)) return;
    observing = observing.then(async () => {
      if (abort.signal.aborted) return;
      const publication = await readServiceEndpoint(endpointPath);
      if (!unavailable && publication?.instanceId !== endpoint.instanceId) {
        unavailable = true;
        warn("Viewed app stopped or was replaced. Logs continue; attach again to control a replacement.");
      }
    }).catch(error => { if (!abort.signal.aborted) warn(`App observation failed: ${error instanceof Error ? error.message : String(error)}`); });
  });
  watcher.on("error", error => warn(`App observation failed: ${error.message}`));
  return {
    logDirectory: info.logDirectory, logPrefix: info.logPrefix,
    stopDaemon: async () => { throw new Error("This is an app view."); },
    stopHost: async () => { throw new Error("This is an app view."); },
    emergencyStopHost: async () => { throw new Error("This is an app view."); },
    quitApp: async () => {
      const target = await readCurrent();
      const stopped = await fetch(`${target.origin}/_workbench-control/quit/${target.instanceId}`, {
        method: "POST", headers: { Authorization: `Bearer ${target.token}` }, redirect: "error", signal,
      });
      await stopped.body?.cancel();
      if (!stopped.ok) throw new Error("App Quit was rejected.");
    },
    close: async () => {
      abort.abort(new Error("App view detached."));
      watcher.close();
      await observing;
    },
  };
}

async function daemonConnection(signal: AbortSignal): Promise<ProcessViewConnection> {
  const client = new WorkbenchServiceClient({
    endpointPath: path.join(resolveWorkbenchDataRoot(), "service", "runtime.json"), warn,
  });
  const cancelled = () => { void client.close().catch(error => warn(`View cleanup failed: ${error instanceof Error ? error.message : String(error)}`)); };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    signal.throwIfAborted();
    await client.start();
    const info = await client.request({ method: "service/process/read" });
    if (info.kind !== "process") throw new Error("Host process information is unavailable.");
    let wasReady = true;
    const unsubscribe = client.subscribe(() => {
      const ready = client.getSnapshot().phase === "ready";
      if (ready && !wasReady) warn("Host connection was replaced. Logs continue; attach again if stop reports a changed process.");
      wasReady = ready;
    });
    return {
      logDirectory: info.logDirectory, logPrefix: info.logPrefix,
      stopDaemon: async (requestSignal) => { await client.request({ method: "service/daemon/stop", instanceId: info.instanceId }, requestSignal); },
      stopHost: async () => { await client.request({ method: "service/stop", instanceId: info.instanceId }); },
      emergencyStopHost: async () => { await client.request({ method: "service/emergency/stop", instanceId: info.instanceId }); },
      quitApp: async () => { throw new Error("This is a daemon view."); },
      close: async () => { signal.removeEventListener("abort", cancelled); unsubscribe(); await client.close(); },
    };
  } catch (error) {
    signal.removeEventListener("abort", cancelled);
    await client.close();
    throw error;
  }
}

async function main() {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Interactive process views are human-only. Agents can inspect persisted logs.");
  }
  const [target = "all", ...rest] = process.argv.slice(2);
  if ((target !== "daemon" && target !== "app" && target !== "all") || rest.length) throw new Error("Usage: wb view [daemon|app]");
  const view = new WorkbenchProcessView({ target, input: process.stdin, write, warn,
    connect: target === "daemon" ? daemonConnection : appConnection });
  const detach = () => view.detach();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, detach);
  try { await view.run(); }
  finally { for (const signal of signals) process.off(signal, detach); }
}

void main().catch(error => { warn(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
