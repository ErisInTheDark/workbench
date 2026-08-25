/*
 * No production exports. Node tests protect the production graph's parent-owned declarations and shared-child identity. Keywords: topology, parent, child, graph, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitignoreMatcher } from "../lib/workbench/gitignore-matcher";
import graph from "./orchestrator-root-node";
import type ReloadableNode from "./ReloadableNode";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
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
  assert.deepEqual(graph.roots.map(({ scope }) => scope), ["server:core", "harness:codex", "harness:opencode", "client:all", "server:instructions"]);
  const { nodes, parents } = flattenParents(graph.roots);

  assert.deepEqual([...nodes.keys()].sort(), [
    "client:all",
    "harness:codex",
    "harness:opencode",
    "server:browse",
    "server:codex",
    "server:core",
    "server:instructions",
    "server:mcp",
    "server:opencode",
    "server:topology",
    "server:websocket",
  ]);
  assert.deepEqual([...parents.get("server:mcp")!].sort(), ["server:core", "server:topology"]);
  assert.deepEqual([...parents.get("server:codex")!].sort(), ["harness:codex", "server:core"]);
  assert.deepEqual([...parents.get("server:opencode")!].sort(), ["harness:opencode", "server:core"]);
  assert.deepEqual([...parents.get("server:browse")!], ["server:core"]);
  assert.deepEqual([...parents.get("server:websocket")!], ["server:core"]);
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

test("each production node matches a representative owned source path", () => {
  const { nodes } = flattenParents(graph.roots);
  const examples = new Map<string, string>([
    ["server:core", "webapp/orchestrator/WorkbenchGitArcFeature.ts"],
    ["server:topology", "webapp/orchestrator/OpenCodeBridgeNode.ts"],
    ["server:mcp", "webapp/orchestrator/WorkbenchAgentMcpController.ts"],
    ["server:codex", "webapp/orchestrator/CodexStdioBridge.ts"],
    ["server:opencode", "webapp/orchestrator/opencode-bridge.ts"],
    ["server:browse", "webapp/orchestrator/WorkbenchBrowseController.ts"],
    ["harness:codex", "webapp/orchestrator/CodexAppServer.ts"],
    ["harness:opencode", "webapp/orchestrator/OpenCodeAppServer.ts"],
    ["client:all", "webapp/components/workbench.tsx"],
    ["server:instructions", "webapp/lib/workbench/instructions/workflows/default-workflow-prompt.md"],
  ]);
  for (const [scope, sourcePath] of examples) {
    assert.equal(createGitignoreMatcher(nodes.get(scope)!.sources).matches(sourcePath), true, `${scope} must match ${sourcePath}`);
  }
  assert.equal(
    createGitignoreMatcher(nodes.get("server:codex")!.sources).matches("webapp/orchestrator/CodexTranscriptStore.ts"),
    true,
    "server:codex must match its PascalCase transcript store owner",
  );
});

test("auto-fresh instruction Markdown has one acknowledgement-only scope", () => {
  const { nodes } = flattenParents(graph.roots);
  const matchingScopes = (sourcePath: string) => [...nodes.values()]
    .filter((node) => createGitignoreMatcher(node.sources).matches(sourcePath))
    .map((node) => node.scope)
    .sort();
  const instructions = nodes.get("server:instructions")!;

  assert.deepEqual({
    access: instructions.access,
    children: instructions.children.length,
    lifecycle: instructions.lifecycle,
    provides: instructions.provides,
    requires: instructions.requires,
    safeAll: instructions.safeAll,
  }, {
    access: "agent",
    children: 0,
    lifecycle: "atomic",
    provides: [],
    requires: [],
    safeAll: false,
  });
  assert.deepEqual(matchingScopes("webapp/lib/workbench/instructions/workflows/default-workflow-prompt.md"), ["server:instructions"]);
  assert.deepEqual(matchingScopes("webapp/lib/workbench/instructions/assembly/WorkbenchPromptFiles.ts"), ["client:all", "server:core"]);
});
