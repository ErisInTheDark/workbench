/*
 * No production exports. Node tests protect the production graph's parent-owned declarations and shared-child identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitignoreMatcher } from "workbench-shared/source-pattern-matcher";

import { createReloadableNodeModuleLoader } from "./reloadable-node-loader";
import ReloadableNode from "./ReloadableNode";
import ReloadableNodeHost from "workbench-shared/reload/ReloadableNodeHost";
import {
  DAEMON_PROCESS_REQUIRED_REGISTRATIONS,
  type DaemonProcessContext,
} from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

type Node = ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>;
const graph = createReloadableNodeModuleLoader<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>().load();

function readReloadNodeSourceState() {
  // Exercise production source declarations through the real host without constructing services.
  const copies = new Map<Node, ReloadableNode<null, object, never>>();
  const copy = (node: Node): ReloadableNode<null, object, never> => {
    const existing = copies.get(node);
    if (existing) return existing;
    const result = ReloadableNode.define<null, object, never>()({
      ...node,
      children: node.children.map(copy),
      provides: [] as const,
      requires: [] as const,
      create: () => ({ registrations: {}, start() {}, dispose() {} }),
    });
    copies.set(node, result);
    return result;
  };
  const sources = { ...graph, roots: graph.roots.map(copy) };
  return new ReloadableNodeHost(null, { load: () => sources, reload: () => sources }, {
    topologyScope: "server:topology",
    processScope: {
      descriptor: { scope: "server:process", access: "operator", description: "Process", destructive: true, safeAll: false },
      sources: "",
    },
  }).getSourceState();
}

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
  for (const root of graph.roots) assert.equal(root.requires.length, 0, `${root.scope} requires an absent parent`);
  const { nodes, parents } = flattenParents(graph.roots);

  assert.deepEqual([...parents.get("server:core")!].sort(), ["server:database", "server:turns"]);
  assert.equal(parents.has("server:cli"), false);
  assert.deepEqual(nodes.get("server:cli")!.provides, []);
  assert.deepEqual(nodes.get("server:cli")!.requires, []);
  assert.deepEqual(
    [...parents.get("server:commands")!].sort(),
    ["server:codex/tools", "server:core", "server:database", "server:turns"],
  );
  assert.deepEqual([...parents.get("server:mcp")!].sort(), ["server:commands", "server:core", "server:database", "server:topology", "server:turns"]);
  assert.deepEqual([...parents.get("server:codex")!].sort(), ["harness:codex", "server:codex/configuration", "server:codex/instructions", "server:codex/lifecycle", "server:codex/recovery", "server:core", "server:database", "server:turns"]);
  assert.deepEqual([...parents.get("server:codex/instructions")!], ["server:database"]);
  assert.deepEqual([...parents.get("server:browse")!].sort(), ["server:core", "server:database"]);
  assert.deepEqual([...parents.get("server:websocket")!].sort(), ["server:core", "server:database", "server:turns", "server:voice"]);
  assert.deepEqual([...parents.get("server:voice")!], ["server:core"]);
  assert.deepEqual(nodes.get("server:voice")!.requires, ["voiceSettings"]);
  assert.deepEqual([...parents.get("server:instructions")!], ["server:database"]);
  assert.deepEqual(nodes.get("server:instructions")!.requires, ["database"]);
  assert.equal(nodes.get("server:websocket")!.requires.includes("stats"), true);
  assert.deepEqual([...parents.get("harness:codex")!], ["server:codex/lifecycle"]);
  assert.equal(nodes.get("server:turns")!.lifecycle, "handoff");
  assert.deepEqual({
    lifecycle: nodes.get("server:database")!.lifecycle,
    provides: nodes.get("server:database")!.provides,
  }, {
    lifecycle: "handoff",
    provides: ["database", "threadIdentity", "transcriptIdentity", "transcript"],
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

test("tool reload preserves the executor and executor replacement owns the tool dependant closure", () => {
  const { dependantClosure, descriptors } = readReloadNodeSourceState();
  const catalog = new Map(descriptors.map((descriptor) => [descriptor.scope, descriptor]));
  const tools = dependantClosure(["server:codex/tools"]);
  const execution = dependantClosure(["server:commands/exec"]);
  assert.deepEqual({
    executionIncludesDefinition: execution.includes("server:codex/def"),
    executionIncludesHarness: execution.includes("harness:codex"),
    executionIncludesProcess: execution.includes("server:process"),
    executionIncludesTools: execution.includes("server:codex/tools"),
    executionIncludesVoice: execution.includes("server:voice"),
    toolsIncludesExecutor: tools.includes("server:codex/exec"),
    toolsIncludesHarness: tools.includes("harness:codex"),
    toolsIncludesVoice: tools.includes("server:voice"),
  }, {
    executionIncludesDefinition: true,
    executionIncludesHarness: false,
    executionIncludesProcess: false,
    executionIncludesTools: true,
    executionIncludesVoice: false,
    toolsIncludesExecutor: false,
    toolsIncludesHarness: false,
    toolsIncludesVoice: false,
  });
  assert.equal(catalog.get("server:commands/exec")!.safeAll, true);
  assert.notEqual(catalog.get("server:commands/exec")!.destructive, true);
});

test("provider configuration reload owns its definition without acquiring the harness", () => {
  const { parents } = flattenParents(graph.roots);
  assert.deepEqual([...parents.get("server:codex/configuration")!], ["server:database"]);
  const { dependantClosure } = readReloadNodeSourceState();
  assert.deepEqual(new Set(dependantClosure(["server:codex/def"])), new Set(["server:codex/def"]));
  const configurationClosure = dependantClosure(["server:codex/configuration"]);
  assert.equal(configurationClosure.includes("server:codex/def"), true);
  assert.equal(configurationClosure.includes("harness:codex"), false);
  assert.equal(configurationClosure.includes("server:core"), false);
});

test("the production graph provides every registration consumed by the process shell", () => {
  const { nodes } = flattenParents(graph.roots);
  const provided = new Set([...nodes.values()].flatMap(({ provides }) => provides));
  for (const registration of DAEMON_PROCESS_REQUIRED_REGISTRATIONS) {
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

  assert.deepEqual(owners("daemon/server/WorkbenchCoreNode.ts"), ["server:core", "server:topology"]);
  assert.equal(descriptors.get("server:core")!.paths.includes("daemon/server/WorkbenchGitArcFeature.ts"), true);
  assert.equal(descriptors.get("server:core")!.paths.includes("daemon/server/stats/WorkbenchStatsController.ts"), true);
  assert.equal(descriptors.get("server:commands")!.paths.includes("daemon/server/WorkbenchAgentCommandController.ts"), true);
  assert.deepEqual(owners("wb"), ["server:cli"]);
  assert.deepEqual(owners("daemon/server/WorkbenchAgentCliEnvironment.ts"), ["server:cli"]);
  assert.deepEqual(owners("daemon/server/lib/workbench/cli/workbench-agent-cli.sh"), ["server:cli"]);
  assert.deepEqual(owners("daemon/server/WorkbenchCodexInstructionAdapter.ts"), ["server:codex/instructions"]);
  assert.deepEqual(
    owners("daemon/server/database/transcript/WorkbenchTranscriptRepository.ts"),
    ["server:database"],
  );
  assert.deepEqual(owners("daemon/server/database/stats/WorkbenchStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/server/database/stats/WorkbenchUsageStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/server/database/stats/WorkbenchClaimStatsRepository.ts"), ["server:database"]);
  assert.deepEqual(owners("daemon/server/WorkbenchClaimStatsController.ts"), ["server:commands"]);
  assert.deepEqual(owners("shared/workbench/stats/workbench-stats-contract.ts"), [
    "server:codex/instructions", "server:commands", "server:core", "server:mcp", "server:websocket",
  ]);
  assert.deepEqual(
    owners("daemon/server/lib/workbench/database/schema/codex-sandbox-network-schema.ts"),
    ["server:codex/configuration", "server:database"],
  );
  assert.equal(descriptors.get("server:commands")!.paths.some((sourcePath) => sourcePath.endsWith(".test.ts")), false);
  assert.equal(descriptors.get("server:process")!.paths.includes("daemon/server/WorkbenchCoreNode.ts"), false);
});

test("server branch and topology closures never acquire harness roots", () => {
  const { dependantClosure, descriptors } = readReloadNodeSourceState();
  const catalog = new Map(descriptors.map((descriptor) => [descriptor.scope, descriptor]));
  for (const scope of ["server:turns", "server:database", "server:core", "server:topology", "server:instructions", "server:codex/instructions"] as const) {
    const closure = dependantClosure([scope]);
    assert.equal(closure.includes("harness:codex"), false, `${scope} must preserve the Codex harness root`);
    assert.equal(closure.includes("server:process"), false, `${scope} must not become a process restart`);
  }
  assert.equal(catalog.get("harness:codex")!.destructive, true);
  assert.equal(catalog.get("server:process")!.destructive, true);
  assert.deepEqual(
    dependantClosure(["server:process"]),
    descriptors.map(({ scope }) => scope),
  );
});

test("CLI shim reload stays isolated from domain and provider nodes", () => {
  const { dependantClosure, descriptors } = readReloadNodeSourceState();
  const catalog = new Map(descriptors.map((descriptor) => [descriptor.scope, descriptor]));
  assert.deepEqual(dependantClosure(["server:cli"]), ["server:cli"]);
  assert.equal(catalog.get("server:cli")!.safeAll, true);
  assert.notEqual(catalog.get("server:cli")!.destructive, true);
});
