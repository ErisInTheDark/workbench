import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OrchestratorReloadRequestSchema,
  OrchestratorReloadResponseSchema,
  expandOrchestratorReloadScopes,
  normalizeOrchestratorReloadScopes,
  resolveOrchestratorReloadSelections,
  type OrchestratorReloadScopeDescriptor,
  validateOrchestratorReloadScopeCombination,
} from "./orchestrator-reload.ts";

const catalog: OrchestratorReloadScopeDescriptor[] = [
  { access: "agent", description: "Core", safeAll: true, scope: "server:core" },
  { access: "agent", description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli", description: "Codex harness", destructive: true, safeAll: false, scope: "harness:codex" },
];

test("canonical scope parsing owns syntax without freezing topology", () => {
  assert.deepEqual(normalizeOrchestratorReloadScopes(["server:new-node", "bad", "server:new-node"]), ["server:new-node"]);
  assert.deepEqual(expandOrchestratorReloadScopes(["server:core+topology"]), ["server:core", "server:topology"]);
  assert.deepEqual(
    expandOrchestratorReloadScopes(["server:codex/instructions+mcp"]),
    ["server:codex/instructions", "server:mcp"],
  );
});

test("the active catalog owns scope access and destructive all expansion", () => {
  assert.deepEqual(resolveOrchestratorReloadSelections({ all: true }, catalog, "agent"), ["server:core", "server:topology"]);
  assert.deepEqual(resolveOrchestratorReloadSelections({ all: true }, catalog, "cli"), ["server:core", "server:topology"]);
  assert.deepEqual(resolveOrchestratorReloadSelections({ all: true, unsafe: true }, catalog, "cli"), ["server:core", "server:topology", "harness:codex"]);
  assert.deepEqual(resolveOrchestratorReloadSelections({ scopes: ["harness:codex"] }, catalog, "cli"), ["harness:codex"]);
  assert.throws(() => resolveOrchestratorReloadSelections({ scopes: ["harness:codex"] }, catalog, "agent"), /unavailable/u);
  assert.throws(() => resolveOrchestratorReloadSelections({ unsafe: true }, catalog, "cli"), /only available with --all/u);
  assert.throws(() => resolveOrchestratorReloadSelections({ scopes: ["server:missing"] }, catalog, "operator"), /Unknown/u);
});

test("full orchestrator process restart is exclusive", () => {
  assert.equal(validateOrchestratorReloadScopeCombination(["server:process"]), null);
  assert.match(validateOrchestratorReloadScopeCombination(["server:process", "server:core"]) ?? "", /by itself/u);
});

test("browser reload protocol rejects malformed and surplus transport fields", () => {
  assert.equal(OrchestratorReloadRequestSchema.safeParse({ scopes: ["server:core"] }).success, true);
  assert.equal(OrchestratorReloadRequestSchema.safeParse({ scopes: ["bad"] }).success, false);
  assert.equal(OrchestratorReloadRequestSchema.safeParse({ scopes: ["server:core"], surprise: true }).success, false);
  assert.equal(OrchestratorReloadResponseSchema.safeParse({
    appliedScopes: [],
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: ["server:core"],
    requestedScopes: ["server:core"],
    startedAt: 1,
    state: "running",
  }).success, true);
  assert.equal(OrchestratorReloadResponseSchema.safeParse({ ok: true, state: "running" }).success, false);
});
