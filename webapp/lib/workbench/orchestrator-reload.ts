/*
 * Exports:
 * - ORCHESTRATOR_RELOAD_SCOPES: every internal reload scope accepted by the shared request contract. Keywords: orchestrator, reload, scope.
 * - ORCHESTRATOR_ALL_RELOAD_SCOPES: non-destructive scopes selected by the documented --all convenience switch. Keywords: orchestrator, reload, all.
 * - normalizeOrchestratorReloadScopes: deduplicate and validate unknown scope input. Keywords: orchestrator, reload, validation.
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

const ORCHESTRATOR_RELOAD_SCOPE_SET = new Set<OrchestratorReloadScope>(ORCHESTRATOR_RELOAD_SCOPES);

export function normalizeOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((scope): scope is OrchestratorReloadScope => (
    typeof scope === "string" && ORCHESTRATOR_RELOAD_SCOPE_SET.has(scope as OrchestratorReloadScope)
  ))));
}

export function validateOrchestratorReloadScopeCombination(scopes: readonly OrchestratorReloadScope[]) {
  if (scopes.includes("orchestrator-server") && scopes.length !== 1) {
    return "orchestrator-server must be requested by itself.";
  }
  return null;
}
