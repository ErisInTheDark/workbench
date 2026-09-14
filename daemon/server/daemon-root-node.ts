/*
 * Exports:
 * - default reloadable node graph: declare only direct process roots; every parent owns its direct children.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { defineReloadableNodeGraph } from "./ReloadableNode";
import { observeReloadNodeGraphSources } from "./reload-node-source-map";
import {
  beginReloadSourceGeneration,
  cancelReloadSourceGeneration,
  completeReloadSourceGeneration,
} from "./lib/workbench/reload-source-observer";

const generation = beginReloadSourceGeneration();
const graph = (() => {
  try {
    const graph = defineReloadableNodeGraph<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>([
      require("./WorkbenchTurnLifecycleNode").default,
      require("./WorkbenchDatabaseNode").default,
      require("./CodexAppServerNode").default,
      require("./OpenCodeAppServerNode").default,
      require("./WorkbenchCodexInstructionNode").default,
      require("./CodexConfigurationNode").default,
    ]);
    return observeReloadNodeGraphSources(graph, module, completeReloadSourceGeneration(generation));
  } catch (error) {
    cancelReloadSourceGeneration(generation);
    throw error;
  }
})();

export default graph;
