/*
 * Exports:
 * - PROCESS_FEATURE_NODE_ID: stable process-root id. Keywords: process, graph, id.
 * - RELOADER_FEATURE_NODE_ID: stable reload-coordinator id. Keywords: reloader, graph, id.
 * - BROWSE_FEATURE_NODE_ID: stable Browse execution id. Keywords: browse, graph, id.
 * - CLIENT_FEATURE_NODE_ID: stable Next client id. Keywords: client, graph, id.
 * - createOrchestratorRuntimeFeatureNodes: declare process, reload coordinator, node-owned Browse execution, and Next client nodes. Keywords: scope, dependency, handoff.
 */
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import type { OrchestratorFeatureNodeDefinition } from "./OrchestratorFeatureHost";
import WorkbenchBrowseController from "./WorkbenchBrowseController";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";
import type {
  OrchestratorBrowseExecution,
  OrchestratorFeatureContext,
  OrchestratorFeatures,
  OrchestratorProviderNotification,
} from "./orchestrator-feature-registry";
import { WORKBENCH_CORE_FEATURE_NODE_ID } from "./WorkbenchCoreFeature";

export const PROCESS_FEATURE_NODE_ID = "orchestrator-process";
export const RELOADER_FEATURE_NODE_ID = "reload-coordinator";
export const BROWSE_FEATURE_NODE_ID = "browse-execution";
export const CLIENT_FEATURE_NODE_ID = "next-client";

class BrowseExecution implements OrchestratorBrowseExecution {
  private controller: WorkbenchBrowseController | null = null;
  private readonly runtime: WorkbenchBrowseRuntime;

  constructor(private readonly context: OrchestratorFeatureContext) {
    this.runtime = new WorkbenchBrowseRuntime(context.browseProjectResolvers);
  }

  async cleanupStaleInactiveSessions(options: Parameters<WorkbenchBrowseController["cleanupStaleInactiveSessions"]>[0]) {
    if (this.controller) await this.controller.cleanupStaleInactiveSessions(options);
  }

  async executeBrowseRequest(body: Buffer, signal: AbortSignal) {
    return await this.getController().executeBrowseRequest(body, signal);
  }

  async executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal) {
    return await this.getController().executeSessionRequest(request, signal);
  }

  handleBrowseHttpRequest: WorkbenchBrowseController["handleBrowseHttpRequest"] = async (request, response) => {
    await this.getController().handleBrowseHttpRequest(request, response);
  };

  handleSessionsHttpRequest: WorkbenchBrowseController["handleSessionsHttpRequest"] = async (request, response) => {
    await this.getController().handleSessionsHttpRequest(request, response);
  };

  async initialize() {
    await this.runtime.initialize();
  }

  async detach() {
    if (!this.controller) return;
    this.controller.beginDrain();
    try {
      await this.controller.waitForIdle();
    } catch (error) {
      this.controller.resume();
      throw error;
    }
  }

  resume() {
    this.controller?.resume();
  }

  private getController() {
    this.controller ??= new WorkbenchBrowseController(new WorkbenchBrowseResultController(this.context.browseResultCallbacks), this.runtime);
    return this.controller;
  }
}

function markerNode(
  id: string,
  scope: string,
  dependencies: readonly string[],
  replace: (context: OrchestratorFeatureContext) => Promise<void> | void,
): OrchestratorFeatureNodeDefinition<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification> {
  return {
    create: (context, build) => ({
      detachForReload: () => undefined,
      dispose: () => undefined,
      features: {},
      start: async () => { if (build.mode === "replacement") await replace(context); },
    }),
    dependencies,
    featureKeys: [],
    id,
    lifecycle: "handoff",
    scope,
  };
}

export function createOrchestratorRuntimeFeatureNodes(
  context: OrchestratorFeatureContext,
): readonly OrchestratorFeatureNodeDefinition<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>[] {
  return [
    markerNode(PROCESS_FEATURE_NODE_ID, "server:process", [], async () => undefined),
    markerNode(RELOADER_FEATURE_NODE_ID, "server:reloader", [PROCESS_FEATURE_NODE_ID], async () => undefined),
    {
      create: (_current, build) => {
        const restored = build.mode === "restore"
          ? (build.handoffState as { execution: BrowseExecution }).execution
          : new BrowseExecution(context);
        let detached = false;
        return {
          detachForReload: async () => {
            await restored.detach();
            detached = true;
            return { execution: restored };
          },
          dispose: async () => { if (!detached) await restored.detach(); },
          features: { browseExecution: restored },
          start: async () => {
            if (build.mode === "restore") restored.resume();
            else await restored.initialize();
          },
        };
      },
      dependencies: [WORKBENCH_CORE_FEATURE_NODE_ID],
      featureKeys: ["browseExecution"],
      id: BROWSE_FEATURE_NODE_ID,
      lifecycle: "handoff",
      scope: "server:browse",
    },
    markerNode(CLIENT_FEATURE_NODE_ID, "client:all", [PROCESS_FEATURE_NODE_ID], async (current) => await current.reloadClient()),
  ];
}
