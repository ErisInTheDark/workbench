/*
 * Exports:
 * - default WorkbenchBrowseNode: own warm Browse execution while preserving browser sessions across code replacement. Keywords: browse, drain, reload.
 */
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorBrowseExecution, OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchBrowseController from "./WorkbenchBrowseController";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";

class BrowseExecution implements OrchestratorBrowseExecution {
  private controller: WorkbenchBrowseController | null = null;
  private readonly runtime: WorkbenchBrowseRuntime;

  constructor(private readonly context: OrchestratorProcessContext) {
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

  async listSessions(request: object) {
    return await this.getController().listSessions(request as import("workbench-shared/types").WorkbenchBrowseSessionListRequest);
  }

  async controlSession(request: object) {
    return await this.getController().controlSession(request as import("workbench-shared/types").WorkbenchBrowseSessionControlRequest);
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
    this.beginDrain();
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

  beginDrain() {
    this.controller?.beginDrain();
  }

  private getController() {
    this.controller ??= new WorkbenchBrowseController(new WorkbenchBrowseResultController(this.context.browseResultCallbacks), this.runtime);
    return this.controller;
  }
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const execution = build.mode === "restore"
      ? (build.handoffState as { execution: BrowseExecution }).execution
      : new BrowseExecution(context);
    let detached = false;
    const unregisterBrowse = build.get("daemonRequests").registerBrowse({
      controlSession: async (request) => await execution.controlSession(request),
      listSessions: async (request) => await execution.listSessions(request),
    });
    return {
      beginRuntimeDrain: () => { execution.beginDrain(); },
      detachForReload: async () => {
        await execution.detach();
        detached = true;
        return { execution };
      },
      dispose: async () => {
        unregisterBrowse();
        if (!detached) await execution.detach();
      },
      registrations: { browseExecution: execution },
      start: async () => {
        if (build.mode === "restore") execution.resume();
        else await execution.initialize();
      },
    };
  },
  description: "Reload orchestrator-owned Browse execution without restarting browser sessions.",
  lifecycle: "handoff",
  provides: ["browseExecution"],
  requires: ["daemonRequests"],
  safeAll: true,
  scope: "server:browse",
  sources: [
    "webapp/orchestrator/WorkbenchBrowseNode.ts",
    "webapp/orchestrator/WorkbenchBrowseController.ts",
    "webapp/orchestrator/WorkbenchBrowseResultController.ts",
    "webapp/lib/workbench/browse/**",
  ].join("\n"),
});
