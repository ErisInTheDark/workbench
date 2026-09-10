/*
 * Exports:
 * - WorkbenchSubagentFeatureContext: current-generation project, relationship, and thread-state ports.
 * - default WorkbenchSubagentFeature: own the reloadable subagent controller and durable relationship-store wrapper.
 */
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./thread-identity-workbench-mapping";
import type { WorkbenchSubagentPersistence } from "./database/thread-state/workbench-thread-state-persistence";

export interface WorkbenchSubagentFeatureContext {
  bridgeUrl: string;
  identities?: NativeTranscriptIdentityOwners;
  requestNativeHarness?: (harness: WorkbenchHarness, request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: WorkbenchComposerProfileStore;
  resolveProjectFromCwd(cwd: string | null | undefined, options?: { endpointName?: string }): Promise<AgentEndpointProjectResolution>;
  persistence: WorkbenchSubagentPersistence;
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
    this.store = new WorkbenchSubagentStore(context.persistence);
    this.controller = new WorkbenchSubagentController({
      bridgeUrl: context.bridgeUrl,
      identities: context.identities?.threads,
      requestNativeHarness: context.requestNativeHarness && context.identities ? async (harness, request) => {
        const mapped = await mapWorkbenchProviderRequest(context.identities!.threads, harness, request);
        const response = await context.requestNativeHarness!(mapped.harness, mapped.request);
        return mapNativeProviderResponse(context.identities!, mapped.harness, mapped.request, response);
      } : context.requestNativeHarness,
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
  dispose() { return this.controller.dispose(); }
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> { return this.controller.handleRequest(request); }
  listRelationships(projectId: string) { return this.store.list({ projectId }); }
}
