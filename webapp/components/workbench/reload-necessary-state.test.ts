/*
 * No production exports. Tests protect destructive reload confirmation duration. Keywords: reload, hold, destructive, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESTRUCTIVE_RELOAD_HOLD_MS,
  getAffectedReloadScopes,
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
  mergeReloadDirt,
  NORMAL_RELOAD_HOLD_MS,
  partitionReloadScopes,
} from "./reload-necessary-state";

const regular = { description: "Core", destructive: false, scope: "server:core" } as const;
const destructive = { description: "Codex harness", destructive: true, scope: "harness:codex" } as const;

test("destructive scopes require the long hold and reload all uses the longest hold", () => {
  assert.equal(getReloadScopeHoldMs(regular), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadScopeHoldMs(destructive), DESTRUCTIVE_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular]), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular, destructive]), DESTRUCTIVE_RELOAD_HOLD_MS);
});

test("merges app and daemon dirt while routing each namespace to its owner", () => {
  const merged = mergeReloadDirt(
    { dirtyScopes: [{ description: "HTTP", destructive: false, scope: "client:http" }], error: null, pendingScopes: [] },
    { dirtyScopes: [regular], error: "daemon warning", pendingScopes: ["server:core"] },
  );
  assert.deepEqual(merged?.dirtyScopes.map(({ scope }) => scope), ["client:http", "server:core"]);
  assert.equal(merged?.error, "daemon warning");
  assert.deepEqual(partitionReloadScopes(merged?.dirtyScopes.map(({ scope }) => scope) ?? []), {
    client: ["client:http"],
    server: ["server:core"],
  });
});

test("full app restart subsumes client reloads without swallowing daemon scopes", () => {
  const process = { description: "Process", destructive: true, scope: "client:process" };
  assert.deepEqual(partitionReloadScopes([
    "client:http",
    process.scope,
    regular.scope,
  ]), {
    client: ["client:process"],
    server: ["server:core"],
  });
});

test("derives sibling highlights from owner metadata and reload all affects every visible scope", () => {
  const scopes = [
    { ...regular, dependantScopes: ["server:websocket", "server:mcp"] },
    { description: "WebSocket", destructive: false, scope: "server:websocket" },
    { description: "MCP", destructive: false, scope: "server:mcp" },
    { description: "Browse", destructive: false, scope: "server:browse" },
  ];
  assert.deepEqual([...getAffectedReloadScopes("server:core", scopes)], ["server:websocket", "server:mcp"]);
  assert.deepEqual([...getAffectedReloadScopes("server:browse", scopes)], []);
  assert.deepEqual([...getAffectedReloadScopes("all", scopes)], scopes.map(({ scope }) => scope));
  assert.deepEqual([...getAffectedReloadScopes(null, scopes)], []);
});
