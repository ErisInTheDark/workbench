/*
 * Exports:
 * - WORKBENCH_RELOAD_METHOD/OrchestratorReloadRequestSchema/OrchestratorReloadResponseSchema: one typed browser reload protocol. Keywords: WebSocket, Zod, contract.
 * - WORKBENCH_RELOAD_DIRT_READ_METHOD/WORKBENCH_RELOAD_DIRT_UPDATED_METHOD: global reload dirt observation methods. Keywords: WebSocket, dirt, notification.
 * - WorkbenchOrchestratorReloadDirtEnvelopeSchema/WorkbenchOrchestratorReloadDirtEnvelope: ordered global reload dirt snapshot. Keywords: revision, snapshot, reconnect.
 * - OrchestratorReloadScope/OrchestratorReloadState/OrchestratorReloadRequest/OrchestratorReloadResponse: inferred reload protocol types. Keywords: reload, types.
 * - ORCHESTRATOR_RELOAD_SCOPE_PATTERN: canonical namespace:path scope syntax. Keywords: reload, scope, validation.
 * - OrchestratorReloadScopeDescriptor: active node catalog projection shared by CLI and reload admission. Keywords: catalog, access, destructive.
 * - normalizeOrchestratorReloadScopes/expandOrchestratorReloadScopes: validate atomic or grouped scope strings without owning topology. Keywords: normalize, group.
 * - resolveOrchestratorReloadSelections: resolve explicit scopes and destructive-aware all from one active catalog. Keywords: policy, dynamic, request.
 * - validateOrchestratorReloadScopeCombination: keep hard process reload exclusive. Keywords: process, restart.
 */

import { z } from "zod";
import { WORKBENCH_RELOAD_SCOPE_PATTERN } from "../reload/workbench-reload.ts";

export const ORCHESTRATOR_RELOAD_SCOPE_PATTERN = WORKBENCH_RELOAD_SCOPE_PATTERN;
const RELOAD_SCOPE_GROUP_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*(?:\+[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)*$/u;
const MAX_RELOAD_SCOPES = 64;
const MAX_RELOAD_SCOPE_LENGTH = 64;
const OrchestratorReloadScopeSchema = z.string().max(MAX_RELOAD_SCOPE_LENGTH).regex(ORCHESTRATOR_RELOAD_SCOPE_PATTERN);
const WorkbenchReloadDirtSnapshotSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES).default([]),
    description: z.string(),
    destructive: z.boolean(),
    scope: OrchestratorReloadScopeSchema,
  }).strict()).max(MAX_RELOAD_SCOPES),
  error: z.string().nullable(),
  pendingScopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES),
}).strict();

export const WORKBENCH_RELOAD_METHOD = "workbench/orchestrator/reload";
export const WORKBENCH_RELOAD_DIRT_READ_METHOD = "workbench/orchestrator/reload-dirt/read";
export const WORKBENCH_RELOAD_DIRT_UPDATED_METHOD = "workbench/orchestrator/reload-dirt/updated";
export const WorkbenchOrchestratorReloadDirtEnvelopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  snapshot: WorkbenchReloadDirtSnapshotSchema,
}).strict();
export const OrchestratorReloadRequestSchema = z.object({
  all: z.boolean().optional(),
  scopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES).optional(),
}).strict();
export const OrchestratorReloadResponseSchema = z.object({
  appliedScopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  completedAt: z.number().nullable(),
  error: z.string().nullable(),
  ok: z.literal(true),
  queuedScopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  requestedScopes: z.array(OrchestratorReloadScopeSchema).max(MAX_RELOAD_SCOPES),
  startedAt: z.number().nullable(),
  state: z.enum(["idle", "running", "succeeded", "failed"]),
}).strict();

export type OrchestratorReloadScope = z.infer<typeof OrchestratorReloadScopeSchema>;
export type OrchestratorReloadState = z.infer<typeof OrchestratorReloadResponseSchema>["state"];
export type OrchestratorReloadRequest = z.infer<typeof OrchestratorReloadRequestSchema>;
export type OrchestratorReloadResponse = z.infer<typeof OrchestratorReloadResponseSchema>;
export type WorkbenchOrchestratorReloadDirtEnvelope = z.infer<typeof WorkbenchOrchestratorReloadDirtEnvelopeSchema>;

export interface OrchestratorReloadScopeDescriptor {
  access: "agent" | "cli" | "operator";
  description: string;
  destructive?: boolean;
  safeAll: boolean;
  scope: OrchestratorReloadScope;
}

export function normalizeOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((scope): OrchestratorReloadScope[] => (
    typeof scope === "string"
      && scope.length <= MAX_RELOAD_SCOPE_LENGTH
      && ORCHESTRATOR_RELOAD_SCOPE_PATTERN.test(scope)
      ? [scope as OrchestratorReloadScope]
      : []
  )))).slice(0, MAX_RELOAD_SCOPES);
}

export function expandOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value) || !value.length || value.some((scope) => typeof scope !== "string" || !RELOAD_SCOPE_GROUP_PATTERN.test(scope))) {
    throw new Error("At least one valid reload scope or namespace group is required.");
  }
  return [...new Set(value.flatMap((selection) => {
    const [namespace, members] = (selection as string).split(":", 2);
    return members!.split("+").map((member) => `${namespace}:${member}` as OrchestratorReloadScope);
  }))].slice(0, MAX_RELOAD_SCOPES);
}

export function resolveOrchestratorReloadSelections(
  input: { all?: boolean; scopes?: unknown; unsafe?: boolean },
  catalog: readonly OrchestratorReloadScopeDescriptor[],
  access: OrchestratorReloadScopeDescriptor["access"],
) {
  const explicit = input.scopes === undefined ? [] : expandOrchestratorReloadScopes(input.scopes);
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

export function validateOrchestratorReloadScopeCombination(scopes: readonly string[]) {
  if (scopes.includes("server:process") && scopes.length !== 1) return "server:process must be requested by itself.";
  return null;
}
