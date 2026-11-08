/*
 * Exports:
 * - SetWorkbenchConnectOptions: startup and running-host request seams.
 * - default setWorkbenchConnect: `wb connect`/`wb disconnect` semantics: OS autostart plus the host's remote wake publication.
 */
import type { WorkbenchServiceIntent } from "../../shared/process/WorkbenchServiceClient.ts";

export interface SetWorkbenchConnectOptions {
  enabled: boolean;
  setStartupEnabled(enabled: boolean): Promise<void>;
  request(intent: Extract<WorkbenchServiceIntent, { method: "service/wake/enable" }>, signal?: AbortSignal): Promise<unknown>;
  signal?: AbortSignal;
}

export default async function setWorkbenchConnect({ enabled, setStartupEnabled, request, signal }: SetWorkbenchConnectOptions) {
  await setStartupEnabled(enabled);
  signal?.throwIfAborted();
  await request({ method: "service/wake/enable", enabled }, signal);
}
