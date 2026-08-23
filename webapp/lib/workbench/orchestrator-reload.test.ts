/*
 * No production exports. Node tests protect reload scope normalization, safe --all membership, and hard-restart exclusivity. Keywords: orchestrator, reload, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_ALL_RELOAD_SCOPES,
  normalizeOrchestratorReloadScopes,
  validateOrchestratorReloadScopeCombination,
} from "./orchestrator-reload";

test("--all excludes both server-replacement scopes", () => {
  const allScopes: readonly string[] = ORCHESTRATOR_ALL_RELOAD_SCOPES;
  assert.equal(allScopes.includes("orchestrator-server"), false);
  assert.equal(allScopes.includes("opencode-server"), false);
  assert.equal(allScopes.includes("reload-coordinator"), false);
  assert.equal(allScopes.includes("mcp"), true);
});

test("normalization bounds and deduplicates scope-shaped input for owner validation", () => {
  assert.deepEqual(normalizeOrchestratorReloadScopes([
    "codex-bridge",
    "orchestrator-server",
    "codex-bridge",
    "unknown",
    "NOT-A-SCOPE",
    "x".repeat(65),
  ]), ["codex-bridge", "orchestrator-server", "unknown"]);
});

test("full orchestrator restart is exclusive", () => {
  assert.equal(validateOrchestratorReloadScopeCombination(["orchestrator-server"]), null);
  assert.equal(
    validateOrchestratorReloadScopeCombination(["orchestrator-server", "codex-bridge"]),
    "orchestrator-server must be requested by itself.",
  );
});
