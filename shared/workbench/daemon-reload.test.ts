import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DaemonReloadRequestSchema,
  DaemonReloadResponseSchema,
  expandDaemonReloadScopes,
  normalizeDaemonReloadScopes,
  resolveDaemonReloadSelections,
  type DaemonReloadScopeDescriptor,
  validateDaemonReloadScopeCombination,
} from "./daemon-reload.ts";

const catalog: DaemonReloadScopeDescriptor[] = [
  { access: "agent", description: "Core", safeAll: true, scope: "server:core" },
  { access: "agent", description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli", description: "Codex harness", destructive: true, safeAll: false, scope: "harness:codex" },
];

test("canonical scope parsing owns syntax without freezing topology", () => {
  assert.deepEqual(normalizeDaemonReloadScopes(["server:new-node", "bad", "server:new-node"]), ["server:new-node"]);
  assert.deepEqual(expandDaemonReloadScopes(["server:core+topology"]), ["server:core", "server:topology"]);
  assert.deepEqual(
    expandDaemonReloadScopes(["server:codex/instructions+mcp"]),
    ["server:codex/instructions", "server:mcp"],
  );
});

test("the active catalog owns scope access and destructive all expansion", () => {
  assert.deepEqual(resolveDaemonReloadSelections({ all: true }, catalog, "agent"), ["server:core", "server:topology"]);
  assert.deepEqual(resolveDaemonReloadSelections({ all: true }, catalog, "cli"), ["server:core", "server:topology"]);
  assert.deepEqual(resolveDaemonReloadSelections({ all: true, unsafe: true }, catalog, "cli"), ["server:core", "server:topology", "harness:codex"]);
  assert.deepEqual(resolveDaemonReloadSelections({ scopes: ["harness:codex"] }, catalog, "cli"), ["harness:codex"]);
  assert.throws(() => resolveDaemonReloadSelections({ scopes: ["harness:codex"] }, catalog, "agent"), /unavailable/u);
  assert.throws(() => resolveDaemonReloadSelections({ unsafe: true }, catalog, "cli"), /only available with --all/u);
  assert.throws(() => resolveDaemonReloadSelections({ scopes: ["server:missing"] }, catalog, "operator"), /Unknown/u);
});

test("full daemon process restart is exclusive", () => {
  assert.equal(validateDaemonReloadScopeCombination(["server:process"]), null);
  assert.match(validateDaemonReloadScopeCombination(["server:process", "server:core"]) ?? "", /by itself/u);
});

test("browser reload protocol rejects malformed and surplus transport fields", () => {
  assert.equal(DaemonReloadRequestSchema.safeParse({ scopes: ["server:core"] }).success, true);
  assert.equal(DaemonReloadRequestSchema.safeParse({ scopes: ["bad"] }).success, false);
  assert.equal(DaemonReloadRequestSchema.safeParse({ scopes: ["server:core"], surprise: true }).success, false);
  assert.equal(DaemonReloadResponseSchema.safeParse({
    appliedScopes: [],
    completedAt: null,
    error: null,
    ok: true,
    queuedScopes: ["server:core"],
    requestedScopes: ["server:core"],
    startedAt: 1,
    state: "running",
  }).success, true);
  assert.equal(DaemonReloadResponseSchema.safeParse({ ok: true, state: "running" }).success, false);
});
