/*
 * Exports:
 * - WORKBENCH_RELOAD_SCOPE_PATTERN/WorkbenchReloadScope/WorkbenchReloadScopeDescriptor: shared reload node identity and catalog metadata.
 * - WorkbenchReloadDirtScope/WorkbenchReloadDirtSnapshot: process-local source dirt projection.
 * - WorkbenchReloadDirtSnapshotSchema: validate reload ownership and pending-scope diagnostics.
 * - WorkbenchReloadOperationSchema/WorkbenchReloadOperation/IDLE_RELOAD_OPERATION: the app's in-flight reload-all or pull sequence.
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

/**
 * The app's single in-flight reload-all / pull sequence. `waiting`: pulled, waiting for dirt to observe the new
 * HEAD. `restarting`: a process-replacing scope was admitted, so this app is about to exit.
 */
export const WorkbenchReloadOperationSchema = z.object({
  action: z.enum(["reloadAll", "pull", "pullAndReload"]).nullable(),
  phase: z.enum(["idle", "pulling", "waiting", "reloading", "restarting", "failed"]),
  error: z.string().max(500).nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
}).strict();
export type WorkbenchReloadOperation = z.infer<typeof WorkbenchReloadOperationSchema>;
export const IDLE_RELOAD_OPERATION: WorkbenchReloadOperation = { action: null, phase: "idle", error: null, startedAt: null };

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
