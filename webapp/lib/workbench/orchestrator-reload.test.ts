/* No production exports. Tests protect grouped normalization, path derivation, safe --all membership, and process-restart exclusivity. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  expandOrchestratorReloadScopes,
  getReloadScopesForPaths,
  normalizeOrchestratorReloadScopes,
  ORCHESTRATOR_ALL_RELOAD_SCOPES,
  validateOrchestratorReloadScopeCombination,
} from "./orchestrator-reload";

test("--all excludes external harness, process, and reloader scopes", () => {
  const allScopes: readonly string[] = ORCHESTRATOR_ALL_RELOAD_SCOPES;
  assert.equal(allScopes.includes("server:process"), false);
  assert.equal(allScopes.includes("harness:codex"), false);
  assert.equal(allScopes.includes("harness:opencode"), false);
  assert.equal(allScopes.includes("server:reloader"), false);
  assert.equal(allScopes.includes("server:mcp"), true);
});

test("normalization keeps canonical atoms and drops legacy or unknown projection values", () => {
  assert.deepEqual(normalizeOrchestratorReloadScopes([
    "codex-bridge", "orchestrator-server", "server:codex", "server:unknown", "server:core+browse", "x".repeat(65),
  ]), ["server:codex"]);
});

test("request groups expand into canonical atomic scopes", () => {
  assert.deepEqual(expandOrchestratorReloadScopes(["server:core+browse+mcp", "client:all"]), [
    "server:core", "server:browse", "server:mcp", "client:all",
  ]);
  assert.deepEqual(expandOrchestratorReloadScopes(["server:core", "server:core+browse"]), ["server:core", "server:browse"]);
  assert.throws(() => expandOrchestratorReloadScopes(["server:haunted"]), /Unknown reload scopes/u);
});

test("source and directory touch paths derive additive reload scopes", () => {
  assert.deepEqual(getReloadScopesForPaths(["webapp/lib/workbench/commands/git-arc-command-definitions.ts"]), ["server:mcp", "client:all"]);
  assert.deepEqual(getReloadScopesForPaths(["webapp/orchestrator/WorkbenchBrowseController.ts"]), ["server:browse"]);
  assert.deepEqual(getReloadScopesForPaths(["webapp/orchestrator"]), [
    "server:core", "server:browse", "server:codex", "server:mcp", "server:opencode", "server:reloader", "server:process",
  ]);
  assert.deepEqual(getReloadScopesForPaths(["webapp/lib/workbench/orchestrator-reload.test.ts"]), []);
});

test("full orchestrator process restart is exclusive", () => {
  assert.equal(validateOrchestratorReloadScopeCombination(["server:process"]), null);
  assert.equal(validateOrchestratorReloadScopeCombination(["server:process", "server:codex"]), "server:process must be requested by itself.");
});
