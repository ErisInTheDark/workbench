/*
 * Exports:
 * - default reloadable node graph: declare only direct process roots; every parent owns its direct children. Keywords: root, graph, topology.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { defineReloadableNodeGraph } from "./ReloadableNode";
import { observeReloadNodeGraphSources } from "./reload-node-source-map";
import {
  beginReloadSourceGeneration,
  cancelReloadSourceGeneration,
  completeReloadSourceGeneration,
} from "../lib/workbench/reload-source-observer";

const generation = beginReloadSourceGeneration();
const graph = (() => {
  try {
    const graph = defineReloadableNodeGraph<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>([
      require("./WorkbenchTurnLifecycleNode").default,
      require("./WorkbenchDatabaseNode").default,
      require("./CodexAppServerNode").default,
      require("./OpenCodeAppServerNode").default,
      require("./WorkbenchClientNode").default,
      require("./WorkbenchInstructionsNode").default,
    ]);
    return observeReloadNodeGraphSources(graph, module, completeReloadSourceGeneration(generation));
  } catch (error) {
    cancelReloadSourceGeneration(generation);
    throw error;
  }
})();

export default graph;
