/*
 * Exports:
 * - WorkbenchSubagentFeatureContext: current-generation project, relationship, settle handover, promotion, approval and thread-state ports.
 * - default WorkbenchSubagentFeature: own the reloadable subagent controller, its cross-folder and cross-daemon children, the
 *   durable relationship-store wrapper, and the user taking a promoted child back.
 */
import type { WorkbenchHarness, WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { AgentEndpointProjectResolver } from "../lib/workbench/project/agent-endpoint-project";
import type { JsonRpcRequest, JsonRpcResponse } from "../bridge-types";
import type WorkbenchComposerProfileStore from "../store/WorkbenchComposerProfileStore";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import type WorkbenchThreadIdentityController from "../thread/WorkbenchThreadIdentityController";
import type { WorkbenchSubagentControllerOptions } from "./WorkbenchSubagentController";
import type { WorkbenchSubagentPersistence } from "../database/thread-state/workbench-thread-state-persistence";
import type { ProjectId, ThreadReference, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { NetworkTarget } from "workbench-shared/workbench/network/network-access";
import WorkbenchRemoteSubagents, { type RemoteSubagentNetwork } from "./WorkbenchRemoteSubagents";

export interface WorkbenchSubagentFeatureContext {
  identities: WorkbenchThreadIdentityController;
  provider: WorkbenchSubagentControllerOptions["provider"];
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: WorkbenchComposerProfileStore;
  resolveProjectFromCwd: AgentEndpointProjectResolver;
  persistence: WorkbenchSubagentPersistence;
  stopThread: WorkbenchSubagentControllerOptions["stopThread"];
  queueReleaseNote: NonNullable<WorkbenchSubagentControllerOptions["queueReleaseNote"]>;
  settlementHold: NonNullable<WorkbenchSubagentControllerOptions["settlementHold"]>;
  adoptChildGitWork: NonNullable<WorkbenchSubagentControllerOptions["adoptChildGitWork"]>;
  moveTodos: NonNullable<WorkbenchSubagentControllerOptions["moveTodos"]>;
  messageWaits: NonNullable<WorkbenchSubagentControllerOptions["messageWaits"]>;
  threadState: {
    getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
    mutate(request: WorkbenchThreadStateRequest): Promise<{ accepted: boolean }>;
    subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
  };
  /** One way into a top-level thread; a former parent on another daemon stays in its network history. */
  promoteThread(threadId: WorkbenchThreadId, formerParent: NetworkTarget | null): Promise<void>;
  /** Live Workbench-owned approvals: listed, read and decided per thread, and asked on a parent's thread. */
  approvals: NonNullable<WorkbenchSubagentControllerOptions["approvals"]> & {
    list: NonNullable<WorkbenchSubagentControllerOptions["liveApprovals"]>;
  };
  /** Relayed calls to other folders and daemons. */
  network: RemoteSubagentNetwork;
  resolveProject(projectId: ProjectId): Promise<{ id: ProjectId; rootPath: string; daemonProject: boolean }>;
  workbenchOrigin: string | null;
}

export default class WorkbenchSubagentFeature {
  private readonly controller: WorkbenchSubagentController;
  private readonly store: WorkbenchSubagentStore;
  /** Children whose parent and child live in different folders or daemons. */
  readonly remote: WorkbenchRemoteSubagents;

  constructor(private readonly context: WorkbenchSubagentFeatureContext) {
    this.store = new WorkbenchSubagentStore(context.persistence);
    const publicThreadId = async (threadId: WorkbenchThreadId | ThreadReference, projectId: ProjectId) => {
      const identity = await context.identities.resolve({ threadId, projectId });
      if (!identity) throw new Error("Subagent metadata is unavailable for public output.");
      return identity.threadId;
    };
    this.remote = new WorkbenchRemoteSubagents({
      network: context.network,
      store: this.store,
      provider: context.provider,
      profiles: () => context.profileStore.read(),
      resolveProject: context.resolveProject,
      publicThreadId,
      resolveThread: async threadId => {
        const identity = await context.identities.resolve({ threadId });
        const harness = identity?.bindings[0]?.harness;
        return identity && harness ? { projectId: identity.projectId, harness: harness as WorkbenchHarness } : null;
      },
      installChild: context.onRelationshipCommitted,
      threadState: context.threadState,
      stopThread: context.stopThread,
      promoteThread: context.promoteThread,
      approvals: {
        list: context.approvals.list,
        pendingFor: threadId => [...context.approvals.pendingFor(threadId)],
        decide: context.approvals.decide,
      },
      workbenchOrigin: context.workbenchOrigin,
      warn: message => { console.warn("[remote-subagents]", message.slice(0, 500)); },
    });
    this.controller = new WorkbenchSubagentController({
      provider: context.provider,
      liveApprovals: context.approvals.list,
      identities: context.identities,
      remote: this.remote,
      network: context.network,
      publicThreadId,
      onRelationshipCommitted: context.onRelationshipCommitted,
      profileStore: context.profileStore,
      resolveProjectFromCwd: context.resolveProjectFromCwd,
      subagentStore: this.store,
      stopThread: context.stopThread,
      queueReleaseNote: context.queueReleaseNote,
      settlementHold: context.settlementHold,
      adoptChildGitWork: context.adoptChildGitWork,
      moveTodos: context.moveTodos,
      threadState: context.threadState,
      messageWaits: context.messageWaits,
      promoteThread: threadId => context.promoteThread(threadId, null),
      approvals: context.approvals,
    });
  }

  beginRuntimeDrain() { this.controller.beginRuntimeDrain(); }
  dispose() {
    this.remote.dispose();
    return this.controller.dispose();
  }
  handleRequest(request: JsonRpcRequest, signal?: AbortSignal, invocation?: AbortSignal): Promise<JsonRpcResponse> {
    return this.controller.handleRequest(request, signal, invocation);
  }
  listRelationships(projectId: ProjectId) { return this.store.list({ projectId }); }
  takeBack(input: Parameters<WorkbenchSubagentController["takeBack"]>[0]) { return this.controller.takeBack(input); }
  readRoster(threadId: WorkbenchThreadId) { return this.store.readRoster(threadId); }
  getOwned(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadId: WorkbenchThreadId) {
    return this.store.getOwned(parentThreadId, projectId, threadId);
  }
  resolveGitArcPeer(input: { cwd: string; parentThreadId: WorkbenchThreadId; name: string }) {
    return this.controller.resolveGitArcPeer(input);
  }
  /** A thread's unsettled relatives in this folder: a remote parent or other-folder child never shares its Git arcs. */
  async resolveGitArcFamily(input: { projectId: ProjectId; threadId: WorkbenchThreadId }) {
    const { subagents } = await this.store.list({ projectId: input.projectId });
    const own = subagents.find(({ threadId }) => threadId === input.threadId);
    return {
      childThreadIds: subagents.filter(({ location, parentThreadId }) => parentThreadId === input.threadId && !location).map(({ threadId }) => threadId),
      parentThreadId: own && !own.parent ? own.parentThreadId : null,
    };
  }
}
