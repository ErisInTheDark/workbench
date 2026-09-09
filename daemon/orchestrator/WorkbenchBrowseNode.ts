/*
 * Keywords: browse, reversible handoff, registration, results, cancellation.
 * Exports:
 * - default WorkbenchBrowseNode: own warm Browse execution while preserving browser sessions across code replacement. Keywords: browse, drain, reload.
 */
import WorkbenchBrowseRuntime from "../lib/workbench/browse/WorkbenchBrowseRuntime";
import WorkbenchBrowseRequestHandler from "../lib/workbench/browse/WorkbenchBrowseRequestHandler";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorBrowseExecution, OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchBrowseController, { type WorkbenchBrowseIdentityPort } from "./WorkbenchBrowseController";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";
import type { WorkbenchBrowseResultCallbacks } from "./WorkbenchBrowseResultController";
import { WORKBENCH_TOOL_CONTEXT_METHOD, WorkbenchToolContextResponseSchema } from "workbench-shared/workbench/thread/thread-tool-output";

class BrowseExecution implements OrchestratorBrowseExecution {
  private controller: WorkbenchBrowseController | null = null;
  private readonly runtime: WorkbenchBrowseRuntime;

  constructor(
    context: OrchestratorProcessContext,
    private readonly resultCallbacks: WorkbenchBrowseResultCallbacks,
    private readonly identity: WorkbenchBrowseIdentityPort,
    private readonly publicTurnId: (threadId: string, turnId: string) => Promise<string>,
  ) {
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
    await this.controller.waitForIdle();
  }

  resume() {
    this.controller?.resume();
  }

  beginDrain() {
    this.getController().beginDrain();
  }

  expire() {
    this.controller?.expire();
  }

  private getController() {
    if (!this.controller) {
      const nativeResults = new WorkbenchBrowseResultController(this.resultCallbacks);
      const results = {
        expire: nativeResults.expire.bind(nativeResults),
        resume: nativeResults.resume.bind(nativeResults),
        record: nativeResults.record.bind(nativeResults),
        waitForIdle: nativeResults.waitForIdle.bind(nativeResults),
        deliverScreenshot: async (threadId: string, imageUrl: string) => {
          const result = await nativeResults.deliverScreenshot(threadId, imageUrl);
          return { ...result, turnId: await this.publicTurnId(threadId, result.turnId) };
        },
      };
      this.controller = new WorkbenchBrowseController(results, this.runtime,
        new WorkbenchBrowseRequestHandler(results, this.runtime, (threadId) => this.identity.publicThreadId(threadId)),
        this.identity);
    }
    return this.controller;
  }
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const harnesses = build.get("harnesses");
    const threads = build.get("threadIdentity");
    const projects = build.get("projectCatalog");
    const identity: WorkbenchBrowseIdentityPort = {
      nativeTarget: async (request) => {
        const project = request.cwd
          ? await projects.resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "Browse" }) : null;
        const thread = await harnesses.resolveThreadIdentity({
          threadId: request.threadId,
          ...(project ? { projectId: project.project.id } : request.projectId ? { projectId: request.projectId } : {}),
        });
        const binding = thread?.bindings[0];
        if (!binding) throw new Error("Browse target has no native execution.");
        return { threadId: binding.nativeThreadId, projectId: thread.projectId, cwd: request.cwd ?? binding.nativeLocation };
      },
      publicThreadId: async (threadId, projectId) => {
        const thread = await threads.resolve({ threadId, ...(projectId ? { projectId } : {}) });
        if (!thread) throw new Error("Browse session has no observed Workbench thread identity.");
        return thread.threadId;
      },
    };
    const publicTurnId = async (threadId: string, turnId: string) => {
      const canonicalThreadId = await identity.publicThreadId(threadId);
      const turn = await threads.resolveTurn({ threadId: canonicalThreadId, turnId });
      if (!turn) throw new Error("Browse result has no observed Workbench turn identity.");
      return turn.turnId;
    };
    const callbacks: WorkbenchBrowseResultCallbacks = {
      ...context.browseResultCallbacks,
      injectToolContext: async (params) => {
        const response = await harnesses.request("codex", { method: WORKBENCH_TOOL_CONTEXT_METHOD, params });
        if (response.error) throw new Error(response.error.message);
        return WorkbenchToolContextResponseSchema.parse(response.result);
      },
    };
    const execution = new BrowseExecution(context, callbacks, identity, publicTurnId);
    let unregisterBrowse: (() => void) | null = null;
    return {
      afterCommit: () => {
        unregisterBrowse = build.get("daemonRequests").registerBrowse({
          controlSession: async (request) => await execution.controlSession(request),
          listSessions: async (request) => await execution.listSessions(request),
        });
        void execution.initialize().catch((error: unknown) => callbacks.logError(`Browse initialisation failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
      },
      beginRuntimeDrain: () => { execution.beginDrain(); },
      expireRuntimeDrain: () => execution.expire(),
      beginHandoff: () => {
        execution.beginDrain();
        return {
          waitForIdle: () => execution.detach(),
          expire: () => execution.expire(),
          detach: async () => { await execution.detach(); },
          resume: () => execution.resume(),
          commit: async () => {
            unregisterBrowse?.();
            execution.expire();
            await execution.detach();
          },
        };
      },
      detachForReload: async () => {
        await execution.detach();
      },
      dispose: async () => {
        unregisterBrowse?.();
        execution.expire();
        await execution.detach();
      },
      registrations: { browseExecution: execution },
      start: async () => {},
    };
  },
  description: "Reload orchestrator-owned Browse execution without restarting browser sessions.",
  lifecycle: "handoff",
  provides: ["browseExecution"],
  requires: ["daemonRequests", "harnesses", "projectCatalog", "threadIdentity"],
  safeAll: true,
  scope: "server:browse",
  sources: [
    "daemon/orchestrator/WorkbenchBrowseNode.ts",
    "daemon/orchestrator/WorkbenchBrowseController.ts",
    "daemon/orchestrator/WorkbenchBrowseResultController.ts",
    "daemon/lib/workbench/browse/**",
  ].join("\n"),
});
