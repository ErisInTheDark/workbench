/*
 * Exports:
 * - default reloadable node graph: declare only direct process roots; every parent owns its direct children. Keywords: root, graph, topology.
 */
import CodexAppServerNode from "./CodexAppServerNode";
import OpenCodeAppServerNode from "./OpenCodeAppServerNode";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { defineReloadableNodeGraph } from "./ReloadableNode";
import WorkbenchClientNode from "./WorkbenchClientNode";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchInstructionsNode from "./WorkbenchInstructionsNode";

export default defineReloadableNodeGraph<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>([
  WorkbenchCoreNode,
  CodexAppServerNode,
  OpenCodeAppServerNode,
  WorkbenchClientNode,
  WorkbenchInstructionsNode,
]);
