/*
 * Exports:
 * - ORCHESTRATOR_REQUESTABLE_RELOAD_SCOPES/ORCHESTRATOR_RELOAD_SCOPES/ORCHESTRATOR_ALL_RELOAD_SCOPES: public, complete, and safe-all atomic reload scope registries. Keywords: orchestrator, reload, scope, all.
 * - WORKBENCH_RELOAD_SCOPE_PATHS/getReloadScopesForPaths: derive additive runtime barriers from project touch paths. Keywords: path, gitignore, arc.
 * - normalizeOrchestratorReloadScopes/expandOrchestratorReloadScopes: normalize canonical atoms or validate grouped request input. Keywords: validation, CLI, MCP, group.
 * - validateOrchestratorReloadScopeCombination: reject full-process restart combined with another scope. Keywords: process, restart, exclusivity.
 */

import type { OrchestratorReloadScope } from "../types";
import { createGitignoreMatcher } from "./gitignore-matcher";

export const ORCHESTRATOR_REQUESTABLE_RELOAD_SCOPES = [
  "server:core",
  "server:browse",
  "server:codex",
  "server:mcp",
  "server:opencode",
  "server:reloader",
  "client:all",
  "harness:codex",
  "harness:opencode",
] as const satisfies readonly OrchestratorReloadScope[];

export const ORCHESTRATOR_RELOAD_SCOPES = [
  ...ORCHESTRATOR_REQUESTABLE_RELOAD_SCOPES,
  "server:process",
] as const satisfies readonly OrchestratorReloadScope[];

export const ORCHESTRATOR_ALL_RELOAD_SCOPES = [
  "server:core",
  "server:browse",
  "server:codex",
  "server:mcp",
  "server:opencode",
  "client:all",
] as const satisfies readonly OrchestratorReloadScope[];

export const WORKBENCH_RELOAD_SCOPE_PATHS = {
  "server:core": `
/webapp/orchestrator/
/webapp/lib/
!**/*.test.*
!/webapp/lib/workbench/browse/
!/webapp/lib/workbench/commands/
!/webapp/orchestrator/index.ts
!/webapp/orchestrator/CodexAppServer.ts
!/webapp/orchestrator/CodexStdioBridge.ts
!/webapp/orchestrator/opencode-bridge.ts
!/webapp/orchestrator/OrchestratorFeatureHost.ts
!/webapp/orchestrator/orchestrator-feature-loader.ts
!/webapp/orchestrator/ReloadableWorkbenchOrchestratorReloadController.ts
!/webapp/orchestrator/WorkbenchAgentMcpController.ts
!/webapp/orchestrator/WorkbenchBrowseController.ts
!/webapp/orchestrator/WorkbenchBrowseResultController.ts
!/webapp/orchestrator/WorkbenchOrchestratorReloadController.ts
!/webapp/orchestrator/workbench-agent-mcp-request-registry.ts
`,
  "server:browse": `
/webapp/orchestrator/WorkbenchBrowseController.ts
/webapp/orchestrator/WorkbenchBrowseResultController.ts
/webapp/lib/workbench/browse/
`,
  "server:codex": `
/webapp/orchestrator/CodexStdioBridge.ts
/webapp/orchestrator/CodexTranscriptStore.ts
/webapp/orchestrator/codex-transcript-*
/webapp/orchestrator/workbench-codex-mcp-config.ts
/webapp/orchestrator/workbench-prompt-context.ts
`,
  "server:mcp": `
/webapp/orchestrator/WorkbenchAgentMcpController.ts
/webapp/orchestrator/workbench-agent-mcp-request-registry.ts
/webapp/lib/workbench/commands/
`,
  "server:opencode": `
/webapp/orchestrator/opencode-bridge.ts
/webapp/orchestrator/opencode-live-thread-state.ts
/webapp/orchestrator/opencode-thread-state.ts
/webapp/orchestrator/opencode-workbench-instructions.ts
/webapp/orchestrator/workbench-prompt-context.ts
`,
  "server:reloader": `
/webapp/orchestrator/WorkbenchOrchestratorReloadController.ts
`,
  "client:all": `
/webapp/app/
/webapp/components/
/webapp/hooks/
/webapp/lib/
/webapp/public/
/webapp/next.config.ts
!**/*.test.*
`,
  "harness:codex": ``,
  "harness:opencode": ``,
  "server:process": `
/webapp/orchestrator/index.ts
/webapp/orchestrator/CodexAppServer.ts
/webapp/orchestrator/CodexBridgeTransitionController.ts
/webapp/orchestrator/CodexRecoverySupervisor.ts
/webapp/orchestrator/copilot-bridge.ts
/webapp/orchestrator/OrchestratorFeatureHost.ts
/webapp/orchestrator/orchestrator-feature-loader.ts
/webapp/orchestrator/process-helpers.ts
/webapp/orchestrator/ReloadableWorkbenchOrchestratorReloadController.ts
/webapp/orchestrator/WorkbenchAgentCliEnvironment.ts
/webapp/orchestrator/WorkbenchCodexMcpGenerationController.ts
/webapp/orchestrator/WorkbenchThreadTransitionCoordinator.ts
/webapp/orchestrator/WorkbenchTurnRecoveryController.ts
/webapp/orchestrator/WorkbenchTurnRecoveryHandoffStore.ts
`,
} satisfies Record<OrchestratorReloadScope, string>;

const MAX_RELOAD_SCOPES = 32;
const MAX_RELOAD_SCOPE_LENGTH = 64;
const RELOAD_SCOPE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u;
const RELOAD_SCOPE_GROUP_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(?:\+[a-z][a-z0-9-]*)*$/u;
const RELOAD_SCOPE_SET = new Set<string>(ORCHESTRATOR_RELOAD_SCOPES);
const RELOAD_SCOPE_MATCHERS = new Map(Object.entries(WORKBENCH_RELOAD_SCOPE_PATHS).map(([scope, patterns]) => (
  [scope as OrchestratorReloadScope, createGitignoreMatcher(patterns)]
)));

export function normalizeOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((scope): OrchestratorReloadScope[] => {
    if (typeof scope !== "string" || scope.length > MAX_RELOAD_SCOPE_LENGTH) return [];
    return RELOAD_SCOPE_PATTERN.test(scope) && RELOAD_SCOPE_SET.has(scope)
      ? [scope as OrchestratorReloadScope]
      : [];
  }))).slice(0, MAX_RELOAD_SCOPES);
}

export function expandOrchestratorReloadScopes(value: unknown): OrchestratorReloadScope[] {
  if (!Array.isArray(value) || !value.length || value.some((scope) => typeof scope !== "string" || !RELOAD_SCOPE_GROUP_PATTERN.test(scope))) {
    throw new Error("At least one valid reload scope or namespace group is required.");
  }
  const scopes = value.flatMap((selection) => {
    const [namespace, members] = (selection as string).split(":", 2);
    return members!.split("+").map((member) => `${namespace}:${member}`);
  });
  const unknown = scopes.filter((scope) => !RELOAD_SCOPE_SET.has(scope));
  if (unknown.length) throw new Error(`Unknown reload scopes: ${[...new Set(unknown)].join(", ")}.`);
  return [...new Set(scopes)] as OrchestratorReloadScope[];
}

export function getReloadScopesForPaths(paths: readonly string[]) {
  return ORCHESTRATOR_RELOAD_SCOPES.filter((scope) => {
    const matcher = RELOAD_SCOPE_MATCHERS.get(scope)!;
    return paths.some((path) => matcher.matchesPathOrDescendant(path));
  });
}

export function validateOrchestratorReloadScopeCombination(scopes: readonly string[]) {
  if (scopes.includes("server:process") && scopes.length !== 1) return "server:process must be requested by itself.";
  return null;
}
