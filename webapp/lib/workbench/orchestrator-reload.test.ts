import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expandOrchestratorReloadScopes,
  normalizeOrchestratorReloadScopes,
  resolveOrchestratorReloadSelections,
  type OrchestratorReloadScopeDescriptor,
  validateOrchestratorReloadScopeCombination,
} from "./orchestrator-reload";

const catalog: OrchestratorReloadScopeDescriptor[] = [
  { access: "agent", description: "Core", safeAll: true, scope: "server:core" },
  { access: "agent", description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli", description: "Codex harness", safeAll: false, scope: "harness:codex" },
];

test("canonical scope parsing owns syntax without freezing topology", () => {
  assert.deepEqual(normalizeOrchestratorReloadScopes(["server:new-node", "bad", "server:new-node"]), ["server:new-node"]);
  assert.deepEqual(expandOrchestratorReloadScopes(["server:core+topology"]), ["server:core", "server:topology"]);
});

test("the active catalog owns scope access and safe-all expansion", () => {
  assert.deepEqual(resolveOrchestratorReloadSelections({ all: true }, catalog, "agent"), ["server:core"]);
  assert.deepEqual(resolveOrchestratorReloadSelections({ scopes: ["harness:codex"] }, catalog, "cli"), ["harness:codex"]);
  assert.throws(() => resolveOrchestratorReloadSelections({ scopes: ["harness:codex"] }, catalog, "agent"), /unavailable/u);
  assert.throws(() => resolveOrchestratorReloadSelections({ scopes: ["server:missing"] }, catalog, "operator"), /Unknown/u);
});

test("full orchestrator process restart is exclusive", () => {
  assert.equal(validateOrchestratorReloadScopeCombination(["server:process"]), null);
  assert.match(validateOrchestratorReloadScopeCombination(["server:process", "server:core"]) ?? "", /by itself/u);
});
