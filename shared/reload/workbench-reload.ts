/*
 * Exports:
 * - WORKBENCH_RELOAD_SCOPE_PATTERN/WorkbenchReloadScope/WorkbenchReloadScopeDescriptor: shared reload node identity and catalog metadata.
 * - WorkbenchReloadDirtScope/WorkbenchReloadDirtSnapshot: process-local source dirt projection.
 * - WorkbenchReloadDirtSnapshotSchema: validate reload ownership and pending-scope diagnostics.
 * - WorkbenchReloadResponse: admitted and completed reload batch state.
 */
import { z } from "zod";

export const WorkbenchReloadDirtSnapshotSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(z.string()).optional(),
    description: z.string(),
    destructive: z.boolean(),
    scope: z.string(),
  }).strict()),
  error: z.string().max(500).nullable(),
  pendingScopes: z.array(z.string()),
}).strict();

export const WORKBENCH_RELOAD_SCOPE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u;
export type WorkbenchReloadScope = string;

export interface WorkbenchReloadScopeDescriptor {
  access: "agent" | "cli" | "operator";
  description: string;
  destructive?: boolean;
  safeAll: boolean;
  scope: WorkbenchReloadScope;
}

export interface WorkbenchReloadDirtScope {
  dependantScopes?: WorkbenchReloadScope[];
  description: string;
  destructive: boolean;
  scope: WorkbenchReloadScope;
}

export interface WorkbenchReloadDirtSnapshot {
  dirtyScopes: WorkbenchReloadDirtScope[];
  error: string | null;
  pendingScopes: WorkbenchReloadScope[];
}

export interface WorkbenchReloadResponse {
  appliedScopes: WorkbenchReloadScope[];
  completedAt: number | null;
  error: string | null;
  ok: true;
  queuedScopes: WorkbenchReloadScope[];
  requestedScopes: WorkbenchReloadScope[];
  startedAt: number | null;
  state: "failed" | "idle" | "running" | "succeeded";
}
