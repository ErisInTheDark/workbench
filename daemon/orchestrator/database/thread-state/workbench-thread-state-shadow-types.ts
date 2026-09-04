/*
 * Exports:
 * - WorkbenchThreadStateShadowStatus: durable relational projection health and source watermark. Keywords: thread state, shadow, parity, status.
 * - WorkbenchSubagentParentSnapshot: one project-qualified active relationship owner and allocation watermark. Keywords: subagent, parent, relationship, allocation.
 * - WorkbenchThreadStateShadowRefresh: one typed full-source projection request. Keywords: thread state, shadow, subagent, rebuild.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

export interface WorkbenchSubagentParentSnapshot {
  harness: WorkbenchSubagentRelationship["harness"];
  nextDirectSubagentIndex: number;
  parentThreadId: string;
  projectId: string;
  relationships: WorkbenchSubagentRelationship[];
}

export interface WorkbenchThreadStateShadowStatus {
  completedAt: number | null;
  errorCode: "constraint-failure" | "invalid-source" | "projection-failure" | null;
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
  parents: WorkbenchSubagentParentSnapshot[];
}
