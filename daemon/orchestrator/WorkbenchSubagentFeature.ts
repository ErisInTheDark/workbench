/*
 * Exports:
 * - WorkbenchSubagentFeatureContext: current-generation project, relationship, and thread-state ports. Keywords: subagent, feature, dependency injection, reload.
 * - default WorkbenchSubagentFeature: own the reloadable subagent controller and durable relationship-store wrapper. Keywords: subagent, feature, lifecycle, store, controller.
 */
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import type WorkbenchThreadStateShadowController from "./WorkbenchThreadStateShadowController";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapNativeSubagentResult } from "./thread-identity-workbench-mapping";

export interface WorkbenchSubagentFeatureContext {
  bridgeUrl: string;
  identities?: NativeTranscriptIdentityOwners;
  requestNativeHarness?: (harness: WorkbenchHarness, request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: WorkbenchComposerProfileStore;
  resolveProjectFromCwd(cwd: string | null | undefined, options?: { endpointName?: string }): Promise<AgentEndpointProjectResolution>;
  shadow: Pick<WorkbenchThreadStateShadowController, "replaceSubagentParents">;
  storageRoot: string;
  threadState: {
    getEntry(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<WorkbenchThreadSidebarEntry | null>;
    mutate(request: WorkbenchThreadStateRequest): Promise<void>;
    subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
  };
}

export default class WorkbenchSubagentFeature {
  private readonly controller: WorkbenchSubagentController;
  private readonly store: WorkbenchSubagentStore;

  constructor(private readonly context: WorkbenchSubagentFeatureContext) {
    this.store = new WorkbenchSubagentStore(context.storageRoot, { shadow: context.shadow });
    this.controller = new WorkbenchSubagentController({
      bridgeUrl: context.bridgeUrl,
      requestNativeHarness: context.requestNativeHarness,
      publicThreadId: context.identities ? async (threadId, projectId) => {
        const identity = await context.identities!.threads.resolve({ threadId, projectId });
        if (!identity) throw new Error("Subagent metadata is unavailable for public output.");
        return identity.threadId;
      } : undefined,
      onRelationshipCommitted: context.onRelationshipCommitted,
      profileStore: context.profileStore,
      resolveProjectFromCwd: context.resolveProjectFromCwd,
      subagentStore: this.store,
      threadState: context.threadState,
    });
  }

  beginRuntimeDrain() { this.controller.beginRuntimeDrain(); }
  dispose() { this.controller.dispose(); }
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.context.identities || request.method === "workbench/subagent/waitCancel") return this.controller.handleRequest(request);
    try {
      const params = { ...(request.params as Record<string, unknown>) };
      const project = await this.context.resolveProjectFromCwd(typeof params.cwd === "string" ? params.cwd : undefined);
      const nativeId = async (threadId: string) => {
        const identity = await this.context.identities!.threads.resolve({ threadId, projectId: project.project.id });
        if (!identity?.bindings[0]) throw new Error("Subagent target has no native execution in this project.");
        return identity.bindings[0].nativeThreadId;
      };
      for (const key of ["callerThreadId", "parentThreadId", "threadId"] as const) {
        if (typeof params[key] === "string") params[key] = await nativeId(params[key]);
      }
      if (Array.isArray(params.threadIds)) params.threadIds = await Promise.all(params.threadIds.map((id) => {
        if (typeof id !== "string") throw new Error("Subagent thread IDs must be strings.");
        return nativeId(id);
      }));
      const response = await this.controller.handleRequest({ ...request, params });
      return response.error ? response : {
        ...response, result: await mapNativeSubagentResult(this.context.identities, response.result, project.project.id),
      };
    } catch (error) {
      return { id: request.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : "Subagent identity resolution failed." } };
    }
  }
  listRelationships(projectId: string) { return this.store.list({ projectId }); }
  start() { return this.store.initialize(); }
}
