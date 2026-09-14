/*
 * Exports:
 * - WORKBENCH_DAEMON_HEALTH_METHOD: read-only WebSocket method for runner liveness proof.
 * - WorkbenchDaemonHealthParamsSchema/WorkbenchDaemonHealthResultSchema: strict health request and response contracts.
 * - WorkbenchDaemonHealthResult: typed successful health response.
 */
import { z } from "zod";

export const WORKBENCH_DAEMON_HEALTH_METHOD = "workbench/daemon/health";
export const WorkbenchDaemonHealthParamsSchema = z.object({}).strict();
export const WorkbenchDaemonHealthResultSchema = z.object({ ok: z.literal(true) }).strict();
export type WorkbenchDaemonHealthResult = z.infer<typeof WorkbenchDaemonHealthResultSchema>;
