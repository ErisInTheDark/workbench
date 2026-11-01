/*
 * Exports:
 * - resolveOperationDaemon: the selected daemon source, or the attached local one.
 * - DAEMON_UNREACHABLE_LIMIT_MS: how long an operation waits on a disconnected daemon before failing.
 * - DaemonOperationSource: the daemon source surface these operations drive.
 * - readDaemonReloadDirt: authoritative reload dirt read from a current daemon.
 * - pullDaemonInstallation: pull the daemon's running checkout and validate the result.
 * - reloadDaemonScopes: admit a daemon reload batch and wait until its facts show it finished.
 */
import { z } from "zod";
import {
  WORKBENCH_RELOAD_DIRT_READ_METHOD, WORKBENCH_RELOAD_METHOD,
  DaemonReloadResponseSchema,
} from "workbench-shared/workbench/daemon-reload";
import { InstallationPullResultSchema } from "workbench-shared/workbench/installation-update";
import type { InstallationPullOptions } from "workbench-shared/workbench/installation-update-prediction";
import { DaemonReloadDirtEnvelopeSchema } from "workbench-shared/reload/reload-dirt-scope";
import type { DaemonId } from "workbench-shared/workbench/identity";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import type { WorkbenchDaemonObservationFact } from "../workspace/WorkbenchDaemonSource";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";

export function resolveOperationDaemon(sources: Pick<WorkbenchDaemonSources, "attached" | "get">, daemonId?: DaemonId) {
  const source = daemonId ? sources.get(daemonId) : sources.attached;
  if (!source) throw new Error(daemonId ? "Selected daemon is unavailable." : "This device's daemon is unavailable.");
  return source;
}

function validate<Value>(schema: z.ZodType<Value>, value: unknown, label: string): Value {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reportClientSchemaError(label, parsed.error);
  throw new Error(label);
}

/** How long a daemon may stay disconnected while an operation waits on it; reconnecting restarts the allowance. */
export const DAEMON_UNREACHABLE_LIMIT_MS = 120_000;

/** The parts of a daemon source an operation drives. */
export type DaemonOperationSource = Pick<WorkbenchDaemonSource, "retain" | "request" | "getSnapshot" | "subscribe"> & {
  observe(...args: Parameters<WorkbenchDaemonSource["observe"]>):
    Pick<ReturnType<WorkbenchDaemonSource["observe"]>, "getSnapshot" | "release">;
};

/**
 * Operations are explicit demand: retaining the source wakes a sleeping daemon for exactly as long as the operation
 * runs. `wait` resolves once `ready` holds for the observed runtime fact and rejects on failure, cancellation, or the
 * daemon staying disconnected past DAEMON_UNREACHABLE_LIMIT_MS.
 */
async function withCurrentRuntime<Value>(
  source: DaemonOperationSource,
  signal: AbortSignal | undefined,
  operation: (runtime: {
    read(): WorkbenchDaemonObservationFact;
    wait(ready: (fact: WorkbenchDaemonObservationFact) => boolean): Promise<void>;
  }) => Promise<Value>,
) {
  signal?.throwIfAborted();
  const waiters = new Set<() => void>();
  const notify = () => { for (const changed of [...waiters]) changed(); };
  const releaseDemand = source.retain();
  const stopConnection = source.subscribe(notify);
  let observation: ReturnType<DaemonOperationSource["observe"]>;
  try { observation = source.observe({ kind: "runtime" }, notify); }
  catch (error) { stopConnection(); releaseDemand(); throw error; }
  const wait = (ready: (fact: WorkbenchDaemonObservationFact) => boolean) => new Promise<void>((resolve, reject) => {
    let unreachable: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      waiters.delete(changed);
      signal?.removeEventListener("abort", cancelled);
      if (unreachable) clearTimeout(unreachable);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const cancelled = () => fail(signal?.reason);
    const gaveUp = () => fail(new Error(`${source.getSnapshot().hostname} has not been reachable for `
      + `${DAEMON_UNREACHABLE_LIMIT_MS / 60_000} minutes; stopped waiting for it.`));
    const changed = () => {
      try {
        signal?.throwIfAborted();
        if (source.getSnapshot().connection === "current") {
          if (unreachable) clearTimeout(unreachable);
          unreachable = null;
        } else unreachable ??= setTimeout(gaveUp, DAEMON_UNREACHABLE_LIMIT_MS);
        const fact = observation.getSnapshot();
        if (fact.phase === "failed" || fact.failure) throw new Error(fact.failure ?? "The daemon observation failed.");
        if (!ready(fact)) return;
        cleanup();
        resolve();
      } catch (error) { fail(error); }
    };
    waiters.add(changed);
    signal?.addEventListener("abort", cancelled, { once: true });
    changed();
  });
  try {
    await wait(fact => fact.phase === "current" && fact.value?.kind === "runtime");
    return await operation({ read: () => observation.getSnapshot(), wait });
  } finally {
    observation.release();
    stopConnection();
    releaseDemand();
  }
}

export function readDaemonReloadDirt(source: DaemonOperationSource, signal?: AbortSignal) {
  return withCurrentRuntime(source, signal, async () => validate(DaemonReloadDirtEnvelopeSchema,
    await source.request<object>(WORKBENCH_RELOAD_DIRT_READ_METHOD, {}, {}, { signal }), "Invalid daemon reload dirt.").snapshot);
}

export function pullDaemonInstallation(source: DaemonOperationSource, request: InstallationPullOptions, signal?: AbortSignal) {
  return withCurrentRuntime(source, signal, async () => validate(InstallationPullResultSchema,
    await source.request<object>("installation/update/pull", request, {}, { signal }), "Invalid daemon update result."));
}

export function reloadDaemonScopes(source: DaemonOperationSource, scopes: string[], signal?: AbortSignal) {
  return withCurrentRuntime(source, signal, async runtime => {
    const before = runtime.read().value!;
    const response = validate(DaemonReloadResponseSchema,
      await source.request<object>(WORKBENCH_RELOAD_METHOD, { scopes }, {}, { signal }), "Invalid daemon reload response.");
    if (response.error || response.state === "failed") throw new Error(response.error ?? "Daemon reload failed.");
    // Admission answers before execution; a newer runtime fact with nothing pending (or a new process generation
    // after `server:process`) is the completion signal.
    await runtime.wait(fact => {
      if (fact.phase !== "current" || fact.value?.kind !== "runtime") return false;
      if (fact.value.generation === before.generation && fact.value.revision <= before.revision) return false;
      if (fact.value.data.error) throw new Error(fact.value.data.error);
      return fact.value.data.pendingScopes.length === 0;
    });
  });
}
