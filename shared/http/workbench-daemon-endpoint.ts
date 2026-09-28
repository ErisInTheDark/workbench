/*
 * Exports:
 * - WORKBENCH_DAEMON_TAILNET_PORT: stable tailnet discovery port, independent of the local listener.
 * - WorkbenchDaemonEndpointSchema/WorkbenchDaemonEndpoint: process-instance-bound local daemon publication.
 * - WorkbenchDaemonReadySchema: typed daemon-to-host readiness message.
 */
import { z } from "zod";

export const WORKBENCH_DAEMON_TAILNET_PORT = 52_739;

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
