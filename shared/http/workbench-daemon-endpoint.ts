/*
 * Exports:
 * - WORKBENCH_DAEMON_TAILNET_PORT: stable tailnet discovery port, independent of the local listener.
 * - WORKBENCH_VIS_TAILNET_PORT: stable tailnet port of the app's vis origin, independent of its local listener.
 * - assertAppTailnetPort: reject a port reserved for daemon discovery or vis pages as the app's tailnet port.
 * - WorkbenchDaemonEndpointSchema/WorkbenchDaemonEndpoint: process-instance-bound local daemon publication.
 * - WorkbenchDaemonReadySchema: typed daemon-to-host readiness message.
 */
import { z } from "zod";

export const WORKBENCH_DAEMON_TAILNET_PORT = 52_739;
/** Where the network relay serves each app's vis origin, on whichever host name the browser used. */
export const WORKBENCH_VIS_TAILNET_PORT = 52_741;

export function assertAppTailnetPort(port: number) {
  if (port === WORKBENCH_DAEMON_TAILNET_PORT) throw new Error("That port is reserved for daemon discovery.");
  if (port === WORKBENCH_VIS_TAILNET_PORT) throw new Error("That port is reserved for vis pages.");
}

const localOrigin = z.url().refine(value => {
  const url = new URL(value);
  return url.origin === value && url.protocol === "http:"
    && url.hostname === "127.0.0.1" && Number(url.port) > 0;
}, "Daemon endpoint must be an explicit IPv4 loopback HTTP origin.");

export const WorkbenchDaemonEndpointSchema = z.object({
  version: z.literal(1),
  instanceId: z.uuid(),
  pid: z.number().int().min(1),
  origin: localOrigin,
}).strict();

export type WorkbenchDaemonEndpoint = z.infer<typeof WorkbenchDaemonEndpointSchema>;

export const WorkbenchDaemonReadySchema = z.object({
  type: z.literal("workbench-daemon-ready"),
  endpoint: WorkbenchDaemonEndpointSchema,
}).strict();
