/*
 * Exports:
 * - WORKBENCH_RELOAD_SCOPE_PATTERN/WorkbenchReloadScope/WorkbenchReloadScopeDescriptor: shared reload node identity and catalog metadata. Keywords: reload, scope, catalog.
 * - WorkbenchReloadDirtScope/WorkbenchReloadDirtSnapshot: process-local source dirt projection. Keywords: reload, dirt, browser.
 * - WorkbenchReloadResponse: admitted and completed reload batch state. Keywords: reload, response, lifecycle.
 */
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
