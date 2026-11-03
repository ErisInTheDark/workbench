/*
 * Exports:
 * - RemoteSubagentNetwork: relayed calls a parent's daemon makes to its children's daemons.
 * - RemoteSubagentCaller: the local parent thread behind one cross-folder subagent command.
 * - default WorkbenchRemoteSubagents: own subagents whose parent and child live in different folders or daemons: the parent side
 *   creates, reads, stops, settles, promotes, decides approvals and pushes sibling rosters through relayed calls; the child side
 *   executes those calls and tells the parent's daemon when a child changes. The child's daemon owns its lifecycle; the parent's
 *   owns the relationship.
 */
import { randomUUID } from "node:crypto";
import type {
  WorkbenchComposerProfile, WorkbenchHarness, WorkbenchPendingUserInputRequest, WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  ThreadReferenceSchema, WorkbenchThreadIdSchema, type DaemonId, type ProjectId, type ThreadReference, type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import type { NetworkTarget } from "workbench-shared/workbench/network/network-access";
import {
  RemoteChildApprovalSchema, RemoteChildRowSchema, type RemoteCall, type RemoteCaller, type RemoteChildApproval, type RemoteChildRow,
  type SiblingRosterEntry,
} from "workbench-shared/workbench/network/network-remote-calls";
import type { WorkbenchApprovalDecision } from "workbench-shared/workbench/provider/provider-approval";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { copyComposerSettings } from "workbench-shared/workbench/thread/thread-profile";
import { renderSubagentQuestionnaireOutput, renderSubagentTurnOutput } from "../lib/workbench/subagent/subagent-output";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import type WorkbenchSubagentStore from "./WorkbenchSubagentStore";

type FolderTarget = Extract<NetworkTarget, { kind: "folder" }>;
type Outcome = { text: string | null; data: unknown };

export interface RemoteSubagentCaller {
  threadId: WorkbenchThreadId;
  cwd: string;
  title: string;
  projectId: ProjectId;
}

export interface RemoteSubagentNetwork {
  self(): { daemonId: DaemonId; hostname: string } | null;
  resolveFolder(caller: RemoteSubagentCaller, address: string, signal: AbortSignal): Promise<FolderTarget>;
  /** A call the target authorizes against a folder grant; refusals prompt the user once. */
  call(caller: RemoteSubagentCaller, input: { daemonId: DaemonId; call: RemoteCall; reason: string; target: () => Promise<NetworkTarget> },
    signal: AbortSignal): Promise<Outcome>;
  /** A call the target authorizes from its own family records; it never prompts. */
  family(caller: { threadId: WorkbenchThreadId; title: string }, daemonId: DaemonId, call: RemoteCall, signal: AbortSignal): Promise<Outcome>;
}

const PARENT_AGENT_NAME = "parent agent";
/** Handover never crosses folders, so these children propose their own work under the default workflow. */
const subagentContext = (name: string, workbenchOrigin: string | null): WorkbenchMessageContext => ({
  subagentName: name, workbenchOrigin, workflowIds: ["default"],
});

export default class WorkbenchRemoteSubagents {
  readonly #changes = new Set<(parentThreadIds: readonly WorkbenchThreadId[]) => void>();
  readonly #stops: Array<() => void> = [];

  constructor(private readonly ports: {
    network: RemoteSubagentNetwork;
    store: Pick<WorkbenchSubagentStore, "list" | "reserve" | "replace" | "remove" | "setRemoteSettled" | "writeRoster" | "parentsOfRemoteChild">;
    provider(harness: WorkbenchHarness): Pick<WorkbenchProvider, "threads" | "interactions">;
    profiles(): Promise<{ profiles: WorkbenchComposerProfile[] }>;
    resolveProject(projectId: ProjectId): Promise<{ id: ProjectId; rootPath: string; daemonProject: boolean }>;
    publicThreadId(threadId: WorkbenchThreadId | ThreadReference, projectId: ProjectId): Promise<WorkbenchThreadId>;
    resolveThread(threadId: WorkbenchThreadId): Promise<{ projectId: ProjectId; harness: WorkbenchHarness } | null>;
    installChild(relationship: WorkbenchSubagentRelationship): Promise<void>;
    threadState: {
      getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
      mutate(request: WorkbenchThreadStateRequest): Promise<{ accepted: boolean }>;
      subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
    };
    stopThread(threadId: WorkbenchThreadId): Promise<void>;
    /** One way into a top-level thread; a former parent on another daemon stays in its network history. */
    promoteThread(threadId: WorkbenchThreadId, formerParent: NetworkTarget | null): Promise<void>;
    approvals: {
      list(): readonly WorkbenchPendingUserInputRequest[];
      pendingFor(threadId: WorkbenchThreadId): RemoteChildApproval[];
      decide(input: { threadId: WorkbenchThreadId; requestKey: string; decision: WorkbenchApprovalDecision }): Promise<unknown>;
    };
    workbenchOrigin: string | null;
    warn(message: string): void;
  }) {
    // Each lifecycle change of a child whose parent lives elsewhere wakes that parent's waits on its daemon.
    const reported = new Map<WorkbenchThreadId, string>();
    this.#stops.push(ports.threadState.subscribe((_projectId, entry) => {
      if (entry.entryKind !== "subagent" || !entry.parentDaemonId) return;
      const key = `${entry.lifecycle.kind}:${entry.lifecycle.settled}:${entry.pinned}`;
      if (reported.get(entry.identity.threadId) === key) return;
      reported.set(entry.identity.threadId, key);
      void ports.network.family({ threadId: entry.identity.threadId, title: entry.title }, entry.parentDaemonId, { kind: "childChanged" },
        AbortSignal.timeout(60_000)).catch(error => ports.warn(`Remote parent was not told about a child change: ${String(error).slice(0, 300)}`));
    }));
  }

  dispose() { for (const stop of this.#stops.splice(0)) stop(); }

  /** Wakes waits on any of `parentThreadIds` when a remote child reports a change. */
  subscribeChanges(listener: (parentThreadIds: readonly WorkbenchThreadId[]) => void) {
    this.#changes.add(listener);
    return () => { this.#changes.delete(listener); };
  }

  childChanged(parentThreadIds: readonly WorkbenchThreadId[]) {
    for (const listener of [...this.#changes]) listener(parentThreadIds);
  }

  // Parent side.

  async profiles(caller: RemoteSubagentCaller, address: string, signal: AbortSignal) {
    const target = await this.ports.network.resolveFolder(caller, address, signal);
    return { target, profiles: await this.remoteProfiles(caller, target, signal) };
  }

  async create(caller: RemoteSubagentCaller, input: {
    address: string; profileId: string; name: string; title: string; message: string; userVisibleSimpleVersion: string;
  }, signal: AbortSignal) {
    const { target, profiles } = await this.profiles(caller, input.address, signal);
    const profile = profiles.find(candidate => candidate.id === input.profileId);
    if (!profile) throw new Error(`${input.profileId} is not a profile on ${target.hostname}; list them with wb subagent profiles --folder ${input.address}.`);
    const now = Date.now();
    const reservationId = randomUUID();
    const reservation = await this.ports.store.reserve({
      createdAt: now, cwd: target.rootPath, harness: profile.harness, name: input.name, parentThreadId: caller.threadId,
      profileId: profile.id, profileName: profile.name, projectId: caller.projectId, reservationId, title: input.title, updatedAt: now,
    });
    let childId: WorkbenchThreadId | null = null;
    try {
      const created = await this.ports.network.call(caller, {
        daemonId: target.daemonId, target: async () => target, reason: this.reason(caller, target),
        call: {
          kind: "subagentCreate", projectId: target.projectId, profileId: profile.id, name: input.name, title: input.title,
          message: input.message, userVisibleSimpleVersion: input.userVisibleSimpleVersion,
          directSubagentIndex: reservation.directSubagentIndex, siblings: await this.roster(caller),
        },
      }, signal);
      const child = created.data as { threadId: WorkbenchThreadId; cwd: string; harness: WorkbenchHarness };
      childId = WorkbenchThreadIdSchema.parse(child.threadId);
      const { reservationId: _reservation, ...metadata } = reservation;
      await this.ports.store.replace(caller.threadId, reservationId, {
        ...metadata, threadId: childId, harness: child.harness, cwd: child.cwd, updatedAt: Date.now(),
        location: { daemonId: target.daemonId, hostname: target.hostname, projectId: target.projectId, settledAt: null },
      });
    } catch (error) {
      await this.ports.store.remove(caller.threadId, reservationId);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${childId ? ` (subagent thread ${childId} on ${target.hostname})` : ""}`);
    }
    await this.pushRosters(caller, signal);
    return { threadId: childId };
  }

  /** Lifecycle rows of remote children, grouped per daemon; settlements they report free the children's names. */
  async read(caller: RemoteSubagentCaller, records: readonly WorkbenchSubagentRelationship[], signal: AbortSignal) {
    const rows = new Map<WorkbenchThreadId, RemoteChildRow>();
    for (const [daemonId, group] of Map.groupBy(records.filter(record => record.location), record => record.location!.daemonId)) {
      const outcome = await this.ports.network.family(caller, daemonId, { kind: "childRead", threadIds: group.map(record => record.threadId) }, signal);
      for (const row of RemoteChildRowSchema.array().parse(outcome.data)) {
        rows.set(row.threadId, row);
        const record = group.find(item => item.threadId === row.threadId)!;
        const settledAt = row.lifecycle.settled ? record.location!.settledAt ?? Date.now() : null;
        if (settledAt !== record.location!.settledAt) await this.ports.store.setRemoteSettled(caller.threadId, row.threadId, settledAt);
      }
    }
    return rows;
  }

  async stop(caller: RemoteSubagentCaller, records: readonly WorkbenchSubagentRelationship[], signal: AbortSignal) {
    for (const [daemonId, group] of Map.groupBy(records.filter(record => record.location), record => record.location!.daemonId)) {
      await this.ports.network.family(caller, daemonId, { kind: "childStop", threadIds: group.map(record => record.threadId) }, signal);
    }
  }

  /** Settles one remote child on its own daemon; a refusal names why. */
  async settle(caller: RemoteSubagentCaller, record: WorkbenchSubagentRelationship, signal: AbortSignal) {
    const outcome = await this.ports.network.family(caller, record.location!.daemonId, { kind: "childSettle", threadId: record.threadId }, signal);
    await this.ports.store.setRemoteSettled(caller.threadId, record.threadId, Date.now());
    await this.pushRosters(caller, signal);
    return outcome.text ?? "Settled.";
  }

  /** Turns a remote child into a top-level thread on its own daemon; ending the relationship stays with the caller. */
  async promote(caller: RemoteSubagentCaller, record: WorkbenchSubagentRelationship, signal: AbortSignal) {
    await this.ports.network.family(caller, record.location!.daemonId, { kind: "childPromote", threadId: record.threadId }, signal);
  }

  async approvals(caller: RemoteSubagentCaller, record: WorkbenchSubagentRelationship, signal: AbortSignal) {
    const outcome = await this.ports.network.family(caller, record.location!.daemonId, { kind: "childApprovals", threadId: record.threadId }, signal);
    return RemoteChildApprovalSchema.array().parse(outcome.data);
  }

  async decideApproval(caller: RemoteSubagentCaller, record: WorkbenchSubagentRelationship, requestKey: string,
    decision: WorkbenchApprovalDecision, signal: AbortSignal) {
    await this.ports.network.family(caller, record.location!.daemonId, {
      kind: "childApprovalDecide", threadId: record.threadId, requestKey, decision,
    }, signal);
  }

  /** Pushes the full unsettled family to every remote child's daemon; a failed push leaves that child's older roster. */
  async pushRosters(caller: RemoteSubagentCaller, signal: AbortSignal) {
    const children = (await this.ports.store.list({ parentThreadId: caller.threadId, projectId: caller.projectId })).subagents;
    const siblings = await this.roster(caller);
    for (const child of children.filter(record => record.location && record.location.settledAt === null)) {
      await this.ports.network.family(caller, child.location!.daemonId, { kind: "siblingRoster", threadId: child.threadId, siblings }, signal)
        .catch(error => this.ports.warn(`Sibling roster push to ${child.location!.hostname} failed: ${String(error).slice(0, 300)}`));
    }
  }

  private async roster(caller: RemoteSubagentCaller): Promise<SiblingRosterEntry[]> {
    const self = this.ports.network.self();
    const children = (await this.ports.store.list({ parentThreadId: caller.threadId, projectId: caller.projectId })).subagents;
    return children.filter(record => !record.location?.settledAt).flatMap(record => {
      const daemonId = record.location?.daemonId ?? self?.daemonId;
      return daemonId ? [{ daemonId, threadId: record.threadId, name: record.name }] : [];
    });
  }

  private async remoteProfiles(caller: RemoteSubagentCaller, target: FolderTarget, signal: AbortSignal) {
    const outcome = await this.ports.network.call(caller, {
      daemonId: target.daemonId, target: async () => target, reason: this.reason(caller, target),
      call: { kind: "subagentProfiles", projectId: target.projectId },
    }, signal);
    return ((outcome.data as { profiles?: WorkbenchComposerProfile[] } | null)?.profiles ?? []);
  }

  private reason(caller: RemoteSubagentCaller, target: FolderTarget) {
    return `"${caller.title}" wants to create subagents in ${target.rootPath} on ${target.hostname}.`;
  }

  // Child side: calls a parent's daemon relayed here, already authorized by WorkbenchRemoteCallController.

  /** This daemon's profiles a folder's children may use. */
  async profilesFor(projectId: ProjectId) {
    const project = await this.ports.resolveProject(projectId);
    const { profiles } = await this.ports.profiles();
    return { profiles: profiles.filter(profile => profile.scope.kind === "global" || profile.scope.projectId === project.id) };
  }

  async createForRemoteParent(caller: RemoteCaller, call: Extract<RemoteCall, { kind: "subagentCreate" }>) {
    const project = await this.ports.resolveProject(call.projectId);
    if (project.daemonProject) throw new Error("Subagents cannot be created in a daemon's own project from another daemon.");
    const profile = (await this.ports.profiles()).profiles.find(candidate => candidate.id === call.profileId
      && (candidate.scope.kind === "global" || candidate.scope.projectId === project.id));
    if (!profile) throw new Error("That profile is not visible in the target folder.");
    const context = subagentContext(call.name, this.ports.workbenchOrigin);
    const threads = this.ports.provider(profile.harness).threads;
    const start = await threads.create({
      cwd: project.rootPath, profile: { kind: "profile", profileId: profile.id, settings: copyComposerSettings(profile) }, context,
    });
    const threadId = await this.ports.publicThreadId(ThreadReferenceSchema.parse(start.id), project.id);
    const now = Date.now();
    await this.ports.installChild({
      threadId, parentThreadId: caller.threadId, projectId: project.id, harness: profile.harness, cwd: project.rootPath,
      name: call.name, title: call.title, profileId: profile.id, profileName: profile.name,
      directSubagentIndex: call.directSubagentIndex, createdAt: now, updatedAt: now,
      parent: { daemonId: caller.daemonId, hostname: caller.hostname },
    });
    await this.ports.store.writeRoster(threadId, call.siblings);
    await threads.rename(threadId, call.title);
    await threads.messageAgent({
      threadId, cwd: project.rootPath, context,
      message: {
        message: call.message, senderName: PARENT_AGENT_NAME, senderThreadId: caller.threadId, senderHost: caller.hostname,
        userVisibleSimpleVersion: call.userVisibleSimpleVersion,
      },
    });
    return { threadId, cwd: project.rootPath, harness: profile.harness };
  }

  async readChildren(threadIds: readonly WorkbenchThreadId[]): Promise<RemoteChildRow[]> {
    return await Promise.all(threadIds.map(async threadId => {
      const resolved = await this.ports.resolveThread(threadId);
      const entry = resolved ? await this.ports.threadState.getEntry(resolved.projectId, resolved.harness, threadId) : null;
      if (!resolved || entry?.entryKind !== "subagent") throw new Error(`Subagent ${threadId} is not on this daemon.`);
      const working = entry.lifecycle.kind === "working";
      const pending = entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"
        ? [...this.ports.approvals.list(), ...await this.ports.provider(resolved.harness).interactions?.pending({ background: true }) ?? []]
          .find(item => item.threadId === threadId) ?? null
        : null;
      const thread = working ? null : await this.ports.provider(resolved.harness).threads.readLatest(threadId);
      return {
        threadId, lifecycle: entry.lifecycle, activityAt: entry.activityAt, pinned: entry.pinned, needsInteraction: Boolean(pending),
        output: !thread ? null : pending ? renderSubagentQuestionnaireOutput(thread, pending.request) : renderSubagentTurnOutput(thread, entry.lifecycle),
      };
    }));
  }

  async stopChildren(threadIds: readonly WorkbenchThreadId[]) {
    for (const threadId of threadIds) await this.ports.stopThread(threadId);
  }

  async settleChild(threadId: WorkbenchThreadId) {
    const resolved = await this.ports.resolveThread(threadId);
    if (!resolved) throw new Error(`Subagent ${threadId} is not on this daemon.`);
    const { accepted } = await this.ports.threadState.mutate({
      identity: { harness: resolved.harness, threadId }, method: "workbench/thread-state/settle", projectId: resolved.projectId,
    });
    if (!accepted) throw new Error("It must be Completed or Stopped, with no live Git claims, required todos or addressed feedback, to settle.");
    return "Settled.";
  }

  writeRoster(threadId: WorkbenchThreadId, siblings: readonly SiblingRosterEntry[]) {
    return this.ports.store.writeRoster(threadId, siblings);
  }

  async promoteForRemoteParent(caller: RemoteCaller, threadId: WorkbenchThreadId) {
    // The thread may hold what its parent sent, so a parent on another daemon keeps it networked with that daemon.
    const formerParent: NetworkTarget | null = this.ports.network.self()?.daemonId === caller.daemonId ? null : {
      kind: "thread", daemonId: caller.daemonId, hostname: caller.hostname, threadId: caller.threadId,
      title: caller.title, projectName: "former parent", daemonProject: false,
    };
    await this.ports.promoteThread(threadId, formerParent);
  }

  approvalsOf(threadId: WorkbenchThreadId) {
    return this.ports.approvals.pendingFor(threadId);
  }

  async decideApprovalOf(call: Extract<RemoteCall, { kind: "childApprovalDecide" }>) {
    await this.ports.approvals.decide({ threadId: call.threadId, requestKey: call.requestKey, decision: call.decision });
  }

  parentsOf(caller: RemoteCaller) {
    return this.ports.store.parentsOfRemoteChild(caller.daemonId, caller.threadId);
  }
}
