/*
 * Exports:
 * - WorkbenchSubagentFeatureContext: current-generation project, relationship, and thread-state ports.
 * - default WorkbenchSubagentFeature: own the reloadable subagent controller and durable relationship-store wrapper.
 */
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type { WorkbenchSubagentControllerOptions } from "./WorkbenchSubagentController";
import type { WorkbenchSubagentPersistence } from "./database/thread-state/workbench-thread-state-persistence";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

export interface WorkbenchSubagentFeatureContext {
  identities: WorkbenchThreadIdentityController;
  provider: WorkbenchSubagentControllerOptions["provider"];
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: WorkbenchComposerProfileStore;
  resolveProjectFromCwd(cwd: string | null | undefined, options?: { endpointName?: string }): Promise<AgentEndpointProjectResolution>;
  persistence: WorkbenchSubagentPersistence;
  threadState: {
    getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
    mutate(request: WorkbenchThreadStateRequest): Promise<void>;
    subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
  };
}

export default class WorkbenchSubagentFeature {
  private readonly controller: WorkbenchSubagentController;
  private readonly store: WorkbenchSubagentStore;

  constructor(private readonly context: WorkbenchSubagentFeatureContext) {
    this.store = new WorkbenchSubagentStore(context.persistence);
    this.controller = new WorkbenchSubagentController({
      provider: context.provider,
      identities: context.identities,
      publicThreadId: async (threadId, projectId) => {
        const identity = await context.identities.resolve({ threadId, projectId });
        if (!identity) throw new Error("Subagent metadata is unavailable for public output.");
        return identity.threadId;
      },
      onRelationshipCommitted: context.onRelationshipCommitted,
      profileStore: context.profileStore,
      resolveProjectFromCwd: context.resolveProjectFromCwd,
      subagentStore: this.store,
      threadState: context.threadState,
    });
  }

  beginRuntimeDrain() { this.controller.beginRuntimeDrain(); }
  dispose() { return this.controller.dispose(); }
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> { return this.controller.handleRequest(request); }
  listRelationships(projectId: ProjectId) { return this.store.list({ projectId }); }
}
