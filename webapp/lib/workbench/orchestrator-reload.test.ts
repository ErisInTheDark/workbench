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
  assert.deepEqual(ORCHESTRATOR_ALL_RELOAD_SCOPES, [
    "orchestrator-logic",
    "browse-controller",
    "codex-bridge",
    "opencode-bridge",
    "next-dev",
  ]);
});

test("normalization deduplicates known internal scopes", () => {
  assert.deepEqual(normalizeOrchestratorReloadScopes([
    "codex-bridge",
    "orchestrator-server",
    "codex-bridge",
    "unknown",
  ]), ["codex-bridge", "orchestrator-server"]);
});

test("full orchestrator restart is exclusive", () => {
  assert.equal(validateOrchestratorReloadScopeCombination(["orchestrator-server"]), null);
  assert.equal(
    validateOrchestratorReloadScopeCombination(["orchestrator-server", "codex-bridge"]),
    "orchestrator-server must be requested by itself.",
  );
});
