/*
 * Exports:
 * - WorkbenchSubagentFeatureContext: current-generation project, relationship, and thread-state ports. Keywords: subagent, feature, dependency injection, reload.
 * - default WorkbenchSubagentFeature: own the reloadable subagent controller and durable relationship-store wrapper. Keywords: subagent, feature, lifecycle, store, controller.
 */
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "../lib/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "../lib/workbench/thread/thread-state";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { JsonRpcRequest } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";

export interface WorkbenchSubagentFeatureContext {
  bridgeUrl: string;
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: WorkbenchComposerProfileStore;
  resolveProjectFromCwd(cwd: string | null | undefined, options?: { endpointName?: string }): Promise<AgentEndpointProjectResolution>;
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

  constructor(context: WorkbenchSubagentFeatureContext) {
    this.store = new WorkbenchSubagentStore(context.storageRoot);
    this.controller = new WorkbenchSubagentController({
      bridgeUrl: context.bridgeUrl,
      onRelationshipCommitted: context.onRelationshipCommitted,
      profileStore: context.profileStore,
      resolveProjectFromCwd: context.resolveProjectFromCwd,
      storageRoot: context.storageRoot,
      subagentStore: this.store,
      threadState: context.threadState,
    });
  }

  beginRuntimeDrain() { this.controller.beginRuntimeDrain(); }
  dispose() { this.controller.dispose(); }
  handleRequest(request: JsonRpcRequest) { return this.controller.handleRequest(request); }
  listRelationships(projectId: string) { return this.store.list({ projectId }); }
  start() { return this.store.initialize(); }
}
