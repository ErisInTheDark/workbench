/*
 * No production exports. Node tests protect the production graph's parent-owned declarations and shared-child identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitignoreMatcher } from "workbench-shared/source-pattern-matcher";

import graph from "./orchestrator-root-node";
import { readReloadNodeSourceState } from "./reload-node-source-map";
import type ReloadableNode from "./ReloadableNode";
import {
  ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS,
  type OrchestratorProcessContext,
} from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";

type Node = ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>;

function flattenParents(roots: readonly Node[]) {
  const nodes = new Map<string, Node>();
  const parents = new Map<string, Set<string>>();
  const visit = (node: Node, parent: string | null) => {
    const existing = nodes.get(node.scope);
    if (existing) assert.equal(existing, node, `${node.scope} must be one shared node object`);
    else nodes.set(node.scope, node);
    if (parent) {
      const current = parents.get(node.scope) ?? new Set<string>();
      current.add(parent);
      parents.set(node.scope, current);
    }
    if (!existing) for (const child of node.children) visit(child, node.scope);
  };
  for (const root of roots) visit(root, null);
  return { nodes, parents };
}

test("the root knows only direct roots and parents declare every dependant", () => {
  assert.deepEqual(graph.roots.map(({ scope }) => scope), [
    "server:turns",
    "server:database",
    "harness:codex",
    "harness:opencode",
    "server:instructions",
    "server:codex/instructions",
  ]);
  const { nodes, parents } = flattenParents(graph.roots);

  assert.deepEqual([...nodes.keys()].sort(), [
    "harness:codex",
    "harness:opencode",
    "server:browse",
    "server:codex",
    "server:codex/instructions",
    "server:commands",
    "server:core",
    "server:database",
    "server:instructions",
    "server:mcp",
    "server:opencode",
    "server:topology",
    "server:turns",
    "server:websocket",
  ]);
  assert.deepEqual([...parents.get("server:core")!].sort(), ["server:database", "server:turns"]);
  assert.deepEqual([...parents.get("server:commands")!].sort(), ["server:core", "server:database", "server:turns"]);
  assert.deepEqual([...parents.get("server:mcp")!].sort(), ["server:commands", "server:core", "server:database", "server:topology", "server:turns"]);
  assert.deepEqual([...parents.get("server:codex")!].sort(), ["harness:codex", "server:codex/instructions", "server:core", "server:database", "server:turns"]);
  assert.equal(parents.has("server:codex/instructions"), false);
  assert.deepEqual([...parents.get("server:opencode")!].sort(), ["harness:opencode", "server:core", "server:database", "server:turns"]);
  assert.deepEqual([...parents.get("server:browse")!].sort(), ["server:core", "server:database"]);
  assert.deepEqual([...parents.get("server:websocket")!].sort(), ["server:core", "server:database", "server:turns"]);
  assert.equal(nodes.get("server:websocket")!.requires.includes("stats"), true);
  assert.equal(parents.has("harness:codex"), false);
  assert.equal(parents.has("harness:opencode"), false);
  assert.deepEqual({
    lifecycle: nodes.get("server:turns")!.lifecycle,
    provides: nodes.get("server:turns")!.provides,
  }, {
    lifecycle: "handoff",
    provides: ["codexMcpGeneration", "reloadController", "reloadDirt", "turnRecovery"],
  });
  assert.deepEqual({
    lifecycle: nodes.get("server:database")!.lifecycle,
    provides: nodes.get("server:database")!.provides,
  }, {
    lifecycle: "handoff",
    provides: ["codexSandboxNetwork", "database", "threadIdentity", "transcriptIdentity", "transcript"],
  });
  assert.deepEqual({
    lifecycle: nodes.get("server:codex/instructions")!.lifecycle,
    provides: nodes.get("server:codex/instructions")!.provides,
  }, {
    lifecycle: "atomic",
    provides: ["codexInstructions"],
  });
});

test("every child requirement is registered by one of its direct parents", () => {
  const { nodes, parents } = flattenParents(graph.roots);
  for (const node of nodes.values()) {
    const parentRegistrations = new Set([...(parents.get(node.scope) ?? [])].flatMap((scope) => nodes.get(scope)!.provides));
    for (const requirement of node.requires) {
      assert.equal(parentRegistrations.has(requirement), true, `${node.scope} requires ${String(requirement)} from no direct parent`);
    }
  }
});

test("the production graph provides every registration consumed by the process shell", () => {
  const { nodes } = flattenParents(graph.roots);
  const provided = new Set([...nodes.values()].flatMap(({ provides }) => provides));
  for (const registration of ORCHESTRATOR_PROCESS_REQUIRED_REGISTRATIONS) {
    assert.equal(provided.has(registration), true, `the process shell requires unprovided ${registration}`);
  }
});

test("loaded modules and hostile boundaries generate narrow source ownership without mapping test files", () => {
  const descriptors = new Map(readReloadNodeSourceState().descriptors.map((descriptor) => [descriptor.scope, descriptor]));
  const owners = (sourcePath: string) => [...descriptors.values()]
    .filter(({ boundaryPatterns, paths }) => (
      paths.includes(sourcePath)
      || createGitignoreMatcher((boundaryPatterns ?? []).join("\n")).matches(sourcePath)
    ))
    .map(({ scope }) => scope)
    .sort();

  assert.deepEqual(owners("daemon/orchestrator/WorkbenchCoreNode.ts"), ["server:core", "server:topology"]);
  assert.equal(descriptors.get("server:core")!.paths.includes("daemon/orchestrator/WorkbenchGitArcFeature.ts"), true);
  assert.equal(descriptors.get("server:core")!.paths.includes("daemon/orchestrator/stats/WorkbenchStatsController.ts"), true);
  assert.equal(descriptors.get("server:commands")!.paths.includes("daemon/orchestrator/WorkbenchAgentCommandController.ts"), true);
  assert.deepEqual(owners("daemon/orchestrator/WorkbenchCodexInstructionAdapter.ts"), ["server:codex/instructions"]);
  assert.deepEqual(
    owners("daemon/orchestrator/database/transcript/WorkbenchTranscriptRepository.ts"),
    ["server:database"],
  );
  assert.deepEqual(owners("daemon/orchestrator/database/stats/WorkbenchStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/orchestrator/database/stats/WorkbenchUsageStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/orchestrator/database/stats/WorkbenchClaimStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/orchestrator/WorkbenchClaimStatsController.ts"), ["server:commands"]);
  assert.deepEqual(owners("shared/workbench/stats/workbench-stats-contract.ts"), ["server:core"]);
  assert.deepEqual(
    owners("daemon/lib/workbench/database/schema/codex-sandbox-network-schema.ts"),
    ["server:database"],
  );
  assert.equal(descriptors.get("server:commands")!.paths.some((sourcePath) => sourcePath.endsWith(".test.ts")), false);
  assert.equal(descriptors.get("server:process")!.paths.includes("daemon/orchestrator/WorkbenchCoreNode.ts"), false);
});

test("server branch and topology closures never acquire harness roots", () => {
  const { dependantClosure, descriptors } = readReloadNodeSourceState();
  const catalog = new Map(descriptors.map((descriptor) => [descriptor.scope, descriptor]));
  for (const scope of ["server:turns", "server:database", "server:core", "server:topology", "server:codex/instructions"] as const) {
    const closure = dependantClosure([scope]);
    assert.equal(closure.includes("harness:codex"), false, `${scope} must preserve the Codex harness root`);
    assert.equal(closure.includes("harness:opencode"), false, `${scope} must preserve the OpenCode harness root`);
    assert.equal(closure.includes("server:process"), false, `${scope} must not become a process restart`);
  }
  assert.equal(catalog.get("harness:codex")!.destructive, true);
  assert.equal(catalog.get("harness:opencode")!.destructive, true);
  assert.equal(catalog.get("server:process")!.destructive, true);
  assert.deepEqual(
    dependantClosure(["server:process"]),
    descriptors.map(({ scope }) => scope),
  );
});
