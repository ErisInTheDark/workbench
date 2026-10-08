/*
 * Exports:
 * - resolveOperationDaemon: the selected daemon source, or the attached local one.
 * - readDaemonReloadDirt: authoritative reload dirt read from a current daemon.
 * - pullDaemonInstallation: pull the daemon's running checkout and validate the result.
 * - reloadDaemonScopes: admit a daemon reload batch and wait until its facts show it finished.
 */
import { z } from "zod";
import {
  WORKBENCH_RELOAD_DIRT_READ_METHOD, WORKBENCH_RELOAD_METHOD,
  DaemonReloadResponseSchema, WorkbenchDaemonReloadDirtEnvelopeSchema,
} from "workbench-shared/workbench/daemon-reload";
import { InstallationPullResultSchema } from "workbench-shared/workbench/installation-update";
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

/**
 * Operations are explicit demand: retaining the source wakes a sleeping daemon for exactly as long as the operation
 * runs. `wait` resolves once `ready` holds for the observed runtime fact and rejects on failure or cancellation.
 */
async function withCurrentRuntime<Value>(
  source: WorkbenchDaemonSource,
  signal: AbortSignal | undefined,
  operation: (runtime: {
    read(): WorkbenchDaemonObservationFact;
    wait(ready: (fact: WorkbenchDaemonObservationFact) => boolean): Promise<void>;
  }) => Promise<Value>,
) {
  signal?.throwIfAborted();
  const waiters = new Set<() => void>();
  const releaseDemand = source.retain();
  let observation: ReturnType<WorkbenchDaemonSource["observe"]>;
  try { observation = source.observe({ kind: "runtime" }, () => { for (const changed of [...waiters]) changed(); }); }
  catch (error) { releaseDemand(); throw error; }
  const wait = (ready: (fact: WorkbenchDaemonObservationFact) => boolean) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { waiters.delete(changed); signal?.removeEventListener("abort", cancelled); };
    const cancelled = () => { cleanup(); reject(signal?.reason); };
    const changed = () => {
      try {
        signal?.throwIfAborted();
        const fact = observation.getSnapshot();
        if (fact.phase === "failed" || fact.failure) throw new Error(fact.failure ?? "The daemon observation failed.");
        if (!ready(fact)) return;
        cleanup();
        resolve();
      } catch (error) { cleanup(); reject(error); }
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
    releaseDemand();
  }
}

export function readDaemonReloadDirt(source: WorkbenchDaemonSource, signal?: AbortSignal) {
  return withCurrentRuntime(source, signal, async () => validate(WorkbenchDaemonReloadDirtEnvelopeSchema,
    await source.request<object>(WORKBENCH_RELOAD_DIRT_READ_METHOD, {}, {}, { signal }), "Invalid daemon reload dirt.").snapshot);
}

export function pullDaemonInstallation(source: WorkbenchDaemonSource, signal?: AbortSignal) {
  return withCurrentRuntime(source, signal, async () => validate(InstallationPullResultSchema,
    await source.request<object>("installation/update/pull", {}, {}, { signal }), "Invalid daemon update result."));
}

export function reloadDaemonScopes(source: WorkbenchDaemonSource, scopes: string[], signal?: AbortSignal) {
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
