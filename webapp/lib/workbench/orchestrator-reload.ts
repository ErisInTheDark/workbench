/*
 * Exports:
 * - ORCHESTRATOR_RELOAD_SCOPE_PATTERN: canonical namespace:name scope syntax. Keywords: reload, scope, validation.
 * - OrchestratorReloadScopeDescriptor: active node catalog projection shared by CLI and reload admission. Keywords: catalog, access, destructive.
 * - normalizeOrchestratorReloadScopes/expandOrchestratorReloadScopes: validate atomic or grouped scope strings without owning topology. Keywords: normalize, group.
 * - resolveOrchestratorReloadSelections: resolve explicit scopes and destructive-aware all from one active catalog. Keywords: policy, dynamic, request.
 * - validateOrchestratorReloadScopeCombination: keep hard process reload exclusive. Keywords: process, restart.
 */

import type { OrchestratorReloadScope } from "../types";

export const ORCHESTRATOR_RELOAD_SCOPE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u;
const RELOAD_SCOPE_GROUP_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\+[a-z][a-z0-9-]*)*$/u;
const MAX_RELOAD_SCOPES = 64;
const MAX_RELOAD_SCOPE_LENGTH = 64;

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
