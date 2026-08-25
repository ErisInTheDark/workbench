/* No production exports. Tests protect the concrete Workbench reload tree and the generic future-leaf registration seam. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type CodexAppServer from "./CodexAppServer";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import OrchestratorFeatureHost, { type OrchestratorFeatureNodeBuild, type OrchestratorFeatureNodeInstance } from "./OrchestratorFeatureHost";
import * as opencodeLiveThreadState from "./opencode-live-thread-state";
import type { OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification, OrchestratorReloadableModules } from "./orchestrator-feature-registry";
import { createOrchestratorFeatureNodes } from "./orchestrator-feature-registry";
import { createOrchestratorProviderFeatureNodes } from "./orchestrator-provider-feature-nodes";
import { PROCESS_FEATURE_NODE_ID } from "./orchestrator-runtime-feature-nodes";
import { WORKBENCH_CORE_FEATURE_NODE_ID } from "./WorkbenchCoreFeature";

test("declares scopes on concrete runtime nodes with provider parents and core dependants", () => {
  const nodes = createOrchestratorFeatureNodes({} as OrchestratorFeatureContext);
  assert.deepEqual(nodes.map(({ dependencies, id, lifecycle, scope }) => ({ dependencies, id, lifecycle, scope })), [
    { dependencies: [], id: "orchestrator-process", lifecycle: "handoff", scope: "server:process" },
    { dependencies: ["orchestrator-process"], id: "workbench-core", lifecycle: "atomic", scope: "server:core" },
    { dependencies: ["workbench-core"], id: "workbench-mcp", lifecycle: "atomic", scope: "server:mcp" },
    { dependencies: ["orchestrator-process"], id: "codex-app-server", lifecycle: "handoff", scope: "harness:codex" },
    { dependencies: ["workbench-core", "codex-app-server"], id: "codex-bridge", lifecycle: "handoff", scope: "server:codex" },
    { dependencies: ["orchestrator-process"], id: "opencode-app-server", lifecycle: "handoff", scope: "harness:opencode" },
    { dependencies: ["workbench-core", "opencode-app-server"], id: "opencode-bridge", lifecycle: "handoff", scope: "server:opencode" },
    { dependencies: ["orchestrator-process"], id: "reload-coordinator", lifecycle: "handoff", scope: "server:reloader" },
    { dependencies: ["workbench-core"], id: "browse-execution", lifecycle: "handoff", scope: "server:browse" },
    { dependencies: ["orchestrator-process"], id: "next-client", lifecycle: "handoff", scope: "client:all" },
  ]);
});

function createBuild(
  features: Partial<OrchestratorFeatures>,
  handoffState: unknown,
  replacing: readonly string[],
  mode: OrchestratorFeatureNodeBuild<OrchestratorFeatures>["mode"],
) {
  return {
    get: (key: keyof OrchestratorFeatures) => features[key],
    handoffState,
    isReplacing: (nodeId: string) => replacing.includes(nodeId),
    lease: { isCurrent: () => true },
    mode,
  } as OrchestratorFeatureNodeBuild<OrchestratorFeatures>;
}

function createProviderContext(
  modules: OrchestratorReloadableModules,
  callbacks: { ready?: boolean[]; unavailable?: boolean[] } = {},
) {
  return {
    codexAppServerOptions: {
      createChild: () => { throw new Error("The provider graph ward must not start Codex."); },
      log: () => undefined,
      logError: () => undefined,
      projectRoot: process.cwd(),
    },
    createCodexBridgeOptions: (appServer: CodexAppServer, initialState?: CodexStdioBridgeReloadState) => ({
      appServer,
      bridgeUrl: "ws://127.0.0.1:4500",
      handleWorkbenchRequest: async () => ({ id: 0, result: {} }),
      initialState,
      onNotification: () => undefined,
      resolveProjectFromCwd: async () => { throw new Error("unused"); },
      sendToClient: () => undefined,
      storageRoot: process.cwd(),
    }),
    openCodeBridgeOptions: {
      onNotification: () => undefined,
      projectRoot: process.cwd(),
    },
    onCodexBridgeActivated: async (restartedAppServer: boolean) => { callbacks.ready?.push(restartedAppServer); },
    onCodexBridgeReady: async () => undefined,
    onCodexBridgeUnavailable: (restartingAppServer: boolean) => { callbacks.unavailable?.push(restartingAppServer); },
    onCodexFatalExit: () => undefined,
    openCodeAppServerOptions: { getReloadableModules: () => modules },
  } as unknown as OrchestratorFeatureContext;
}

test("constructs the real provider graph from dependency-owned module values", async () => {
  const initializeResult = { userAgent: "host-construction-ward" };
  const modules = {
    opencodeLiveThreadState,
    opencodeThreadState: { OPENCODE_INITIALIZE_RESULT: initializeResult },
  } as unknown as OrchestratorReloadableModules;
  const context = createProviderContext(modules);
  const codexHealth = { start: () => undefined } as OrchestratorFeatures["codexHealth"];
  const graphModule = {
    createOrchestratorFeatureNodes: () => [
      {
        create: () => ({ dispose: () => undefined, features: {}, start: () => undefined }),
        dependencies: [], featureKeys: [], id: PROCESS_FEATURE_NODE_ID, lifecycle: "handoff" as const, scope: "server:process",
      },
      {
        create: () => ({ dispose: () => undefined, features: { codexHealth, modules }, start: () => undefined }),
        dependencies: [PROCESS_FEATURE_NODE_ID], featureKeys: ["codexHealth", "modules"] as const,
        id: WORKBENCH_CORE_FEATURE_NODE_ID, lifecycle: "atomic" as const, scope: "server:core",
      },
      ...createOrchestratorProviderFeatureNodes(context),
    ],
  };
  const host = new OrchestratorFeatureHost(context, { load: () => graphModule, reload: () => graphModule });
  try {
    assert.equal(host.get("openCodeBridge").getInitializeResult(), initializeResult);
  } finally {
    await host.dispose();
  }
});

test("provider scopes replace concrete parent and bridge values according to their dependency edges", async () => {
  const unavailable: boolean[] = [];
  const ready: boolean[] = [];
  const initializeResult = { userAgent: "graph-owned-modules" };
  const modules = {
    opencodeLiveThreadState,
    opencodeThreadState: { OPENCODE_INITIALIZE_RESULT: initializeResult },
  } as unknown as OrchestratorReloadableModules;
  const context = createProviderContext(modules, { ready, unavailable });
  const nodes = createOrchestratorFeatureNodes(context);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const health = { start: () => undefined } as OrchestratorFeatures["codexHealth"];
  const create = (nodeId: string, features: Partial<OrchestratorFeatures>, state: unknown, replacing: readonly string[], mode: OrchestratorFeatureNodeBuild<OrchestratorFeatures>["mode"]): OrchestratorFeatureNodeInstance<OrchestratorFeatures, OrchestratorProviderNotification> => {
    return byId.get(nodeId)!.create(context, createBuild(features, state, replacing, mode));
  };

  const codexParentOne = create("codex-app-server", {}, undefined, [], "initial");
  const codexBridgeOne = create("codex-bridge", { codexAppServer: codexParentOne.features.codexAppServer, codexHealth: health }, undefined, [], "initial");
  await codexBridgeOne.start();
  const directCodexState = await codexBridgeOne.detachForReload?.({ isReplacing: (id) => id === "codex-bridge" });
  const codexBridgeTwo = create("codex-bridge", { codexAppServer: codexParentOne.features.codexAppServer, codexHealth: health }, directCodexState, ["codex-bridge"], "replacement");
  await codexBridgeTwo.start();
  await codexBridgeTwo.activate?.();
  assert.notEqual(codexBridgeTwo.features.codexBridge, codexBridgeOne.features.codexBridge);

  const parentCodexState = await codexBridgeTwo.detachForReload?.({ isReplacing: (id) => id === "codex-app-server" || id === "codex-bridge" });
  await codexParentOne.detachForReload?.({ isReplacing: () => true });
  const codexParentTwo = create("codex-app-server", {}, undefined, ["codex-app-server", "codex-bridge"], "replacement");
  const codexBridgeThree = create("codex-bridge", { codexAppServer: codexParentTwo.features.codexAppServer, codexHealth: health }, parentCodexState, ["codex-app-server", "codex-bridge"], "replacement");
  await codexBridgeThree.start();
  await codexBridgeThree.activate?.();
  assert.notEqual(codexParentTwo.features.codexAppServer, codexParentOne.features.codexAppServer);
  assert.notEqual(codexBridgeThree.features.codexBridge, codexBridgeTwo.features.codexBridge);
  assert.deepEqual(unavailable, [false, true]);
  assert.deepEqual(ready, [false, true]);

  const openCodeParentOne = create("opencode-app-server", {}, undefined, [], "initial");
  const openCodeBridgeOne = create("opencode-bridge", { modules, openCodeAppServer: openCodeParentOne.features.openCodeAppServer }, undefined, [], "initial");
  assert.equal(openCodeBridgeOne.features.openCodeBridge?.getInitializeResult(), initializeResult);
  const directOpenCodeState = await openCodeBridgeOne.detachForReload?.({ isReplacing: (id) => id === "opencode-bridge" });
  const openCodeBridgeTwo = create("opencode-bridge", { modules, openCodeAppServer: openCodeParentOne.features.openCodeAppServer }, directOpenCodeState, ["opencode-bridge"], "replacement");
  await openCodeBridgeTwo.start();
  await openCodeBridgeTwo.activate?.();
  assert.notEqual(openCodeBridgeTwo.features.openCodeBridge, openCodeBridgeOne.features.openCodeBridge);

  const parentOpenCodeState = await openCodeBridgeTwo.detachForReload?.({ isReplacing: () => true });
  await openCodeParentOne.detachForReload?.({ isReplacing: () => true });
  const openCodeParentTwo = create("opencode-app-server", {}, undefined, ["opencode-app-server", "opencode-bridge"], "replacement");
  const openCodeBridgeThree = create("opencode-bridge", { modules, openCodeAppServer: openCodeParentTwo.features.openCodeAppServer }, parentOpenCodeState, ["opencode-app-server", "opencode-bridge"], "replacement");
  await openCodeBridgeThree.start();
  await openCodeBridgeThree.activate?.();
  assert.notEqual(openCodeParentTwo.features.openCodeAppServer, openCodeParentOne.features.openCodeAppServer);
  assert.notEqual(openCodeBridgeThree.features.openCodeBridge, openCodeBridgeTwo.features.openCodeBridge);

  await openCodeBridgeThree.dispose();
  await openCodeParentTwo.dispose();
  await codexBridgeThree.dispose();
  await codexParentTwo.dispose();
});
