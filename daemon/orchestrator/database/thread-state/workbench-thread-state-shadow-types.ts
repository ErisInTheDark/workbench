/*
 * Exports:
 * - WorkbenchThreadStateShadowStatus: durable relational projection health and source watermark. Keywords: thread state, shadow, parity, status.
 * - WorkbenchThreadStateShadowRefresh: one typed full-source projection request. Keywords: thread state, shadow, subagent, rebuild.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

export interface WorkbenchThreadStateShadowStatus {
  completedAt: number | null;
  errorText: string | null;
  generation: number;
  mismatchCount: number;
  projectedSubagentCount: number;
  projectedThreadCount: number;
  sourceDigest: string;
  sourceProjectCount: number;
  sourceProjectUpdatedAt: number;
  sourceSubagentParentCount: number;
  sourceSubagentCount: number;
  state: "stale" | "complete" | "failed";
  updatedAt: number;
}

export interface WorkbenchThreadStateShadowRefresh {
  now: number;
  relationships: WorkbenchSubagentRelationship[];
}
