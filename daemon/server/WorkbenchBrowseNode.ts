/*
 * Exports:
 * - default WorkbenchBrowseNode: own warm Browse execution while preserving browser sessions across code replacement.
 */
import WorkbenchBrowseRuntime from "./lib/workbench/browse/WorkbenchBrowseRuntime";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchBrowseRequestHandler from "./lib/workbench/browse/WorkbenchBrowseRequestHandler";
import WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";
import WorkbenchBrowseProfileStore from "./lib/workbench/browse/WorkbenchBrowseProfileStore";
import WorkbenchBrowseSessionRegistry from "./lib/workbench/browse/WorkbenchBrowseSessionRegistry";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonBrowseExecution, DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchBrowseController, { type WorkbenchBrowseIdentityPort } from "./WorkbenchBrowseController";
import WorkbenchBrowseResultController from "./WorkbenchBrowseResultController";
import type { WorkbenchBrowseResultCallbacks } from "./WorkbenchBrowseResultController";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { logError } from "./process-helpers";

class BrowseExecution implements DaemonBrowseExecution {
  private controller: WorkbenchBrowseController | null = null;
  private readonly runtime: WorkbenchBrowseRuntime;
  private readonly profiles: WorkbenchBrowseProfileStore;
  private readonly sessions: WorkbenchBrowseSessionRegistry;

  constructor(
    context: DaemonProcessContext,
    private readonly resultCallbacks: WorkbenchBrowseResultCallbacks,
    private readonly identity: WorkbenchBrowseIdentityPort,
    private readonly settings: WorkbenchServerSettings,
    private readonly database: Pick<WorkbenchDatabaseController, "query" | "executeTransaction" | "writeTranscriptAsset">,
  ) {
    this.profiles = new WorkbenchBrowseProfileStore(database);
    this.sessions = new WorkbenchBrowseSessionRegistry(database);
    this.runtime = new WorkbenchBrowseRuntime({ ...context.browseProjectResolvers, profileStore: this.profiles });
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
      const results = new WorkbenchBrowseResultController(this.resultCallbacks);
      this.controller = new WorkbenchBrowseController(results, this.runtime,
        new WorkbenchBrowseRequestHandler(results, this.runtime, { profileStore: this.profiles, registry: this.sessions },
          (threadId) => this.identity.publicThreadId(threadId), () => this.settings.readLocalCapabilities(), this.database),
        this.identity);
    }
    return this.controller;
  }
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, build) => {
    const harnesses = build.get("harnesses");
    const providers = new WorkbenchProviderDispatcher(build.run);
    const provider = (harness: string) => {
      const key = installedProviderKeys.find(key => key === harness);
      if (!key) throw new Error(`Provider ${harness} is unavailable.`);
      return providers.get(key);
    };
    const threads = build.get("threadIdentity");
    const projects = build.get("projectCatalog");
    const identity: WorkbenchBrowseIdentityPort = {
      nativeTarget: async (request) => {
        const project = request.cwd
          ? await projects.resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "Browse" }) : null;
        const thread = await harnesses.resolveThreadIdentity({
          threadId: ThreadReferenceSchema.parse(request.threadId),
          ...(project ? { projectId: project.project.id } : request.projectId ? { projectId: ProjectIdSchema.parse(request.projectId) } : {}),
        });
        const binding = thread?.bindings[0];
        if (!binding) throw new Error("Browse target has no native execution.");
        return { threadId: binding.nativeThreadId, projectId: thread.projectId, cwd: request.cwd ?? binding.nativeLocation };
      },
      publicThreadId: async (threadId, projectId) => {
        const thread = await threads.resolve({ threadId: ThreadReferenceSchema.parse(threadId), ...(projectId ? { projectId: ProjectIdSchema.parse(projectId) } : {}) });
        if (!thread) throw new Error("Browse session has no observed Workbench thread identity.");
        return thread.threadId;
      },
    };
    const callbacks: WorkbenchBrowseResultCallbacks = {
      logError: message => logError("browse-results", message),
      listHarnesses: () => installedProviderKeys,
      readThread: async (harness, threadId) => ({
        thread: await provider(harness).threads.readLatest(await identity.publicThreadId(threadId)),
      }),
      recordResult: async (entry, harness) => {
        await provider(harness).browse.record({ ...entry, threadId: await identity.publicThreadId(entry.threadId) });
      },
      screenshot: async (harness, input) => {
        return provider(harness).browse.screenshot({ ...input, threadId: await identity.publicThreadId(input.threadId) });
      },
    };
    const execution = new BrowseExecution(context, callbacks, identity, new WorkbenchServerSettings(build.get("database")), build.get("database"));
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
  description: "Reload daemon-owned Browse execution without restarting browser sessions.",
  lifecycle: "handoff",
  provides: ["browseExecution"],
  requires: ["database", "daemonRequests", "harnesses", "projectCatalog", "threadIdentity"],
  safeAll: true,
  scope: "server:browse",
  sources: [
    "daemon/server/WorkbenchBrowseNode.ts",
    "daemon/server/WorkbenchBrowseController.ts",
    "daemon/server/WorkbenchBrowseResultController.ts",
    "daemon/server/lib/workbench/browse/**",
  ].join("\n"),
});
