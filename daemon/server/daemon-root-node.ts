/*
 * Exports:
 * - default reloadable node graph: declare only direct process roots; every parent owns its direct children.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { defineReloadableNodeGraph } from "./ReloadableNode";
import path from "node:path";
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
      require("./CodexConfigurationNode").default,
    ]);
    const repoRoot = path.resolve(__dirname, "../..");
    const observations = completeReloadSourceGeneration(generation)
      .filter(filename => path.relative(repoRoot, filename).replace(/\\/gu, "/").startsWith("instructions/"))
      .map(filename => ({ scope: "server:instructions" as const, path: filename }));
    return { ...graph, sourceObservations: observations };
  } catch (error) {
    cancelReloadSourceGeneration(generation);
    throw error;
  }
})();

export default graph;
