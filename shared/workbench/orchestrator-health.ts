/*
 * Exports:
 * - WORKBENCH_ORCHESTRATOR_HEALTH_METHOD: read-only WebSocket method for runner liveness proof. Keywords: runner, health, WebSocket.
 * - WorkbenchOrchestratorHealthParamsSchema/WorkbenchOrchestratorHealthResultSchema: strict health request and response contracts. Keywords: Zod, RPC.
 * - WorkbenchOrchestratorHealthResult: typed successful health response. Keywords: contract, health.
 */
import { z } from "zod";

export const WORKBENCH_ORCHESTRATOR_HEALTH_METHOD = "workbench/orchestrator/health";
export const WorkbenchOrchestratorHealthParamsSchema = z.object({}).strict();
export const WorkbenchOrchestratorHealthResultSchema = z.object({ ok: z.literal(true) }).strict();
export type WorkbenchOrchestratorHealthResult = z.infer<typeof WorkbenchOrchestratorHealthResultSchema>;
