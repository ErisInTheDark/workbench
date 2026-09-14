/*
 * Exports:
 * - WORKBENCH_RELOAD_METHOD/DaemonReloadRequestSchema/DaemonReloadResponseSchema: one typed browser reload protocol.
 * - WORKBENCH_RELOAD_DIRT_READ_METHOD/WORKBENCH_RELOAD_DIRT_UPDATED_METHOD: global reload dirt observation methods.
 * - WorkbenchDaemonReloadDirtEnvelopeSchema/WorkbenchDaemonReloadDirtEnvelope: ordered global reload dirt snapshot.
 * - DaemonReloadScope/DaemonReloadState/DaemonReloadRequest/DaemonReloadResponse: inferred reload protocol types.
 * - DAEMON_RELOAD_SCOPE_PATTERN: canonical namespace:path scope syntax.
 * - DaemonReloadScopeDescriptor: active node catalog projection shared by CLI and reload admission.
 * - normalizeDaemonReloadScopes/expandDaemonReloadScopes: validate atomic or grouped scope strings without owning topology.
 * - resolveDaemonReloadSelections: resolve explicit scopes and destructive-aware all from one active catalog.
 * - validateDaemonReloadScopeCombination: keep hard process reload exclusive.
 */

import { z } from "zod";
import { WORKBENCH_RELOAD_SCOPE_PATTERN } from "../reload/workbench-reload.ts";

export const DAEMON_RELOAD_SCOPE_PATTERN = WORKBENCH_RELOAD_SCOPE_PATTERN;
const RELOAD_SCOPE_GROUP_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*(?:\+[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)*$/u;
const MAX_RELOAD_SCOPES = 64;
const MAX_RELOAD_SCOPE_LENGTH = 64;
const DaemonReloadScopeSchema = z.string().max(MAX_RELOAD_SCOPE_LENGTH).regex(DAEMON_RELOAD_SCOPE_PATTERN);
const WorkbenchReloadDirtSnapshotSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES).default([]),
    description: z.string(),
    destructive: z.boolean(),
    scope: DaemonReloadScopeSchema,
  }).strict()).max(MAX_RELOAD_SCOPES),
  error: z.string().nullable(),
  pendingScopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES),
}).strict();

export const WORKBENCH_RELOAD_METHOD = "workbench/daemon/reload";
export const WORKBENCH_RELOAD_DIRT_READ_METHOD = "workbench/daemon/reload-dirt/read";
export const WORKBENCH_RELOAD_DIRT_UPDATED_METHOD = "workbench/daemon/reload-dirt/updated";
export const WorkbenchDaemonReloadDirtEnvelopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  snapshot: WorkbenchReloadDirtSnapshotSchema,
}).strict();
export const DaemonReloadRequestSchema = z.object({
  all: z.boolean().optional(),
  scopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES).optional(),
}).strict();
export const DaemonReloadResponseSchema = z.object({
  appliedScopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  completedAt: z.number().nullable(),
  error: z.string().nullable(),
  ok: z.literal(true),
  queuedScopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  requestedScopes: z.array(DaemonReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  startedAt: z.number().nullable(),
  state: z.enum(["idle", "running", "succeeded", "failed"]),
}).strict();

export type DaemonReloadScope = z.infer<typeof DaemonReloadScopeSchema>;
export type DaemonReloadState = z.infer<typeof DaemonReloadResponseSchema>["state"];
export type DaemonReloadRequest = z.infer<typeof DaemonReloadRequestSchema>;
export type DaemonReloadResponse = z.infer<typeof DaemonReloadResponseSchema>;
export type WorkbenchDaemonReloadDirtEnvelope = z.infer<typeof WorkbenchDaemonReloadDirtEnvelopeSchema>;

export interface DaemonReloadScopeDescriptor {
  access: "agent" | "cli" | "operator";
  description: string;
  destructive?: boolean;
  safeAll: boolean;
  scope: DaemonReloadScope;
}

export function normalizeDaemonReloadScopes(value: unknown): DaemonReloadScope[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((scope): DaemonReloadScope[] => (
    typeof scope === "string"
      && scope.length <= MAX_RELOAD_SCOPE_LENGTH
      && DAEMON_RELOAD_SCOPE_PATTERN.test(scope)
      ? [scope as DaemonReloadScope]
      : []
  )))).slice(0, MAX_RELOAD_SCOPES);
}

export function expandDaemonReloadScopes(value: unknown): DaemonReloadScope[] {
  if (!Array.isArray(value) || !value.length || value.some((scope) => typeof scope !== "string" || !RELOAD_SCOPE_GROUP_PATTERN.test(scope))) {
    throw new Error("At least one valid reload scope or namespace group is required.");
  }
  return [...new Set(value.flatMap((selection) => {
    const [namespace, members] = (selection as string).split(":", 2);
    return members!.split("+").map((member) => `${namespace}:${member}` as DaemonReloadScope);
  }))].slice(0, MAX_RELOAD_SCOPES);
}

export function resolveDaemonReloadSelections(
  input: { all?: boolean; scopes?: unknown; unsafe?: boolean },
  catalog: readonly DaemonReloadScopeDescriptor[],
  access: DaemonReloadScopeDescriptor["access"],
) {
  const explicit = input.scopes === undefined ? [] : expandDaemonReloadScopes(input.scopes);
  const allowedAccess = access === "operator" ? new Set(["agent", "cli", "operator"]) : access === "cli" ? new Set(["agent", "cli"]) : new Set(["agent"]);
  const available = new Map(catalog.filter((entry) => allowedAccess.has(entry.access)).map((entry) => [entry.scope, entry]));
  if (input.unsafe && !input.all) throw new Error("--unsafe is only available with --all.");
  const scopes = [
    ...(input.all ? [...available.values()].filter((entry) => entry.destructive !== true || input.unsafe).map((entry) => entry.scope) : []),
    ...explicit,
  ];
  const unknown = scopes.filter((scope) => !available.has(scope));
  if (unknown.length) throw new Error(`Unknown or unavailable reload scopes: ${[...new Set(unknown)].join(", ")}.`);
  const resolved = [...new Set(scopes)];
  if (!resolved.length && !input.all) throw new Error("At least one supported reload scope is required.");
  return resolved;
}

export function validateDaemonReloadScopeCombination(scopes: readonly string[]) {
  if (scopes.includes("server:process") && scopes.length !== 1) return "server:process must be requested by itself.";
  return null;
}
