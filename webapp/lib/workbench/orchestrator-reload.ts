/*
 * Exports:
 * - ORCHESTRATOR_RELOAD_SCOPES: every internal reload scope accepted by the shared request contract. Keywords: orchestrator, reload, scope.
 * - ORCHESTRATOR_ALL_RELOAD_SCOPES: non-destructive scopes selected by the documented --all convenience switch. Keywords: orchestrator, reload, all.
 * - normalizeOrchestratorReloadScopes: bound and deduplicate stable-shell scope input before owner validation. Keywords: orchestrator, reload, validation.
 * - validateOrchestratorReloadScopeCombination: reject full-server restart combined with any other scope. Keywords: orchestrator, restart, exclusivity.
 */

import type { OrchestratorReloadScope } from "../types";

export const ORCHESTRATOR_RELOAD_SCOPES = [
  "orchestrator-logic",
  "browse-controller",
  "codex-bridge",
  "mcp",
  "opencode-bridge",
  "opencode-server",
  "next-dev",
  "orchestrator-server",
] as const satisfies readonly OrchestratorReloadScope[];

export const ORCHESTRATOR_ALL_RELOAD_SCOPES = [
  "orchestrator-logic",
  "browse-controller",
  "codex-bridge",
  "mcp",
  "opencode-bridge",
  "next-dev",
] as const satisfies readonly OrchestratorReloadScope[];

const MAX_RELOAD_SCOPES = 32;
const MAX_RELOAD_SCOPE_LENGTH = 64;
const RELOAD_SCOPE_PATTERN = /^[a-z][a-z0-9-]*$/u;

export function normalizeOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((scope): scope is string => (
    typeof scope === "string"
    && scope.length <= MAX_RELOAD_SCOPE_LENGTH
    && RELOAD_SCOPE_PATTERN.test(scope)
  )))).slice(0, MAX_RELOAD_SCOPES) as OrchestratorReloadScope[];
}

export function validateOrchestratorReloadScopeCombination(scopes: readonly string[]) {
  if (scopes.includes("orchestrator-server") && scopes.length !== 1) {
    return "orchestrator-server must be requested by itself.";
  }
  return null;
}
