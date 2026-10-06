/*
 * Exports:
 * - SubagentQueueMember: one queued thread; the first member holds the queue once promoted.
 * - SubagentQueueState: one parent-owned queue, retained across core reloads.
 * - WorkbenchSubagentQueueHandoff: queue data one core generation hands its successor.
 * - WorkbenchSubagentQueuePorts: project, identity, relationship, lifecycle and notice ports.
 * - default WorkbenchSubagentQueueController: own parent-scoped turn-taking queues, holds, lifecycle pauses, freezes and handoffs.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadLifecycle, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";

import { createWorkbenchAgentMcpRuntimeReloadInterruption } from "./lib/workbench/commands/workbench-agent-command-definition";
import {
  SUBAGENT_QUEUE_PARENT_NAME,
  WorkbenchSubagentQueueRequestSchema,
} from "./lib/workbench/subagent/subagent-queue-contract";
import {
  renderSubagentQueueGranted,
  renderSubagentQueueInfo,
  renderSubagentQueueLeft,
  renderSubagentQueueNotice,
  renderSubagentQueueReleaseNote,
} from "./lib/workbench/subagent/subagent-queue-output";

const PARENT_DISPLAY_NAME = "parent agent";

export interface SubagentQueueMember {
  threadId: WorkbenchThreadId;
  name: string;
  description: string;
  enqueuedAt: number;
  /** Set only on the first member, while it holds the queue. */
  holdStartedAt: number | null;
  /** A holder whose own turn is over; the queue waits for it or for the parent. */
  pausedReason: string | null;
}

export interface SubagentQueueState {
  name: string;
  ownerThreadId: WorkbenchThreadId;
  projectId: ProjectId;
  /** The owner is not working, so nobody is promoted. */
  frozen: boolean;
  members: SubagentQueueMember[];
  lastRelease: { name: string; reason: string; at: number } | null;
}

export interface WorkbenchSubagentQueueHandoff {
  readonly queues: Map<string, SubagentQueueState>;
  /** Pending lines for the parent's next subagent_wait result about this child. */
  readonly releaseNotes: Map<WorkbenchThreadId, string[]>;
}

export interface WorkbenchSubagentQueuePorts {
  resolveProjectFromCwd(cwd: string): Promise<ProjectId>;
  resolveThreadId(threadId: string, projectId: ProjectId): Promise<WorkbenchThreadId>;
  listRelationships(projectId: ProjectId): Promise<readonly WorkbenchSubagentRelationship[]>;
  readLifecycle(projectId: ProjectId, threadId: WorkbenchThreadId): Promise<WorkbenchThreadLifecycle | null>;
  subscribeLifecycle(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
  sendNotice(input: {
    threadId: WorkbenchThreadId;
    senderThreadId: WorkbenchThreadId;
    senderName: string;
    message: string;
    userVisibleSimpleVersion: string;
  }): Promise<void>;
  warn(message: string): void;
  now?(): number;
}

interface QueueCaller {
  threadId: WorkbenchThreadId;
  name: string;
  ownerThreadId: WorkbenchThreadId;
  projectId: ProjectId;
  isOwner: boolean;
}

interface QueueWaiter {
  resolve(text: string): void;
  reject(error: unknown): void;
}

type Placement = { after: string } | { before: string };
type Activity = "active" | "idle" | "gone";

function classify(lifecycle: WorkbenchThreadLifecycle): Activity {
  if (lifecycle.settled || lifecycle.kind === "stopped") return "gone";
  if (lifecycle.kind === "working" || (lifecycle.kind === "needsAttention" && lifecycle.reason === "pendingInput")) return "active";
  return "idle";
}

function idleReason(lifecycle: WorkbenchThreadLifecycle) {
  if (lifecycle.kind === "completed" && lifecycle.reason === "agentCompleted") return "task completed";
  if (lifecycle.kind === "needsAttention" && lifecycle.reason === "agentBlocked") return "task blocked";
  return "turn ended";
}

function queueKey(ownerThreadId: string, name: string) { return `${ownerThreadId}\0${name}`; }
function waiterKey(queue: SubagentQueueState, threadId: string) { return `${queueKey(queue.ownerThreadId, queue.name)}\0${threadId}`; }

export default class WorkbenchSubagentQueueController {
  private readonly state: WorkbenchSubagentQueueHandoff;
  private readonly waiters = new Map<string, QueueWaiter>();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly ports: WorkbenchSubagentQueuePorts, handoff?: WorkbenchSubagentQueueHandoff) {
    this.state = handoff ?? { queues: new Map(), releaseNotes: new Map() };
    this.now = ports.now ?? Date.now;
    // Synchronous so a child's pause note exists before any subagent_wait renders that child's ended turn.
    this.unsubscribe = ports.subscribeLifecycle((projectId, entry) => this.observeLifecycle(projectId, entry));
  }

  captureReloadState() { return this.state; }

  /** Consume queue lines owed to the parent's next subagent_wait result for this child. */
  takeReleaseNote(threadId: string) {
    const notes = this.state.releaseNotes.get(threadId as WorkbenchThreadId);
    if (!notes?.length) return null;
    this.state.releaseNotes.delete(threadId as WorkbenchThreadId);
    return notes.join("\n");
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
    // Waiters keep their membership; the MCP layer re-enters the join in the next generation.
    const interruption = createWorkbenchAgentMcpRuntimeReloadInterruption();
    for (const waiter of [...this.waiters.values()]) waiter.reject(interruption);
    this.waiters.clear();
  }

  async execute(body: unknown, signal: AbortSignal): Promise<string> {
    const request = WorkbenchSubagentQueueRequestSchema.parse(body);
    this.assertLive(signal);
    const caller = await this.resolveCaller(request.callerThreadId, request.cwd);
    this.assertLive(signal);
    // Everything below mutates queue state synchronously; only the join wait suspends.
    const { queue, declared } = this.findQueue(caller, request.queue);
    if (request.action === "dequeue") {
      return request.name ? this.kick(caller, queue, request.name) : this.leave(caller, queue);
    }
    const placement: Placement | null = request.after ? { after: request.after } : request.before ? { before: request.before } : null;
    if (request.name) return this.move(caller, queue, request.name, placement!);
    if (request.description || placement) return await this.join(caller, queue, request.description ?? null, placement, signal);
    return renderSubagentQueueInfo(queue, this.now(), declared);
  }

  private assertLive(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw createWorkbenchAgentMcpRuntimeReloadInterruption();
  }

  private async resolveCaller(callerThreadId: string, cwd: string): Promise<QueueCaller> {
    const projectId = await this.ports.resolveProjectFromCwd(cwd);
    const threadId = await this.ports.resolveThreadId(callerThreadId, projectId);
    const relationship = (await this.ports.listRelationships(projectId)).find(record => record.threadId === threadId);
    return relationship
      ? { threadId, name: relationship.name, ownerThreadId: relationship.parentThreadId, projectId, isOwner: false }
      : { threadId, name: PARENT_DISPLAY_NAME, ownerThreadId: threadId, projectId, isOwner: true };
  }

  private findQueue(caller: QueueCaller, name: string) {
    const existing = this.state.queues.get(queueKey(caller.ownerThreadId, name));
    if (existing) return { queue: existing, declared: false };
    if (!caller.isOwner) {
      const names = [...this.state.queues.values()].filter(queue => queue.ownerThreadId === caller.ownerThreadId).map(queue => queue.name);
      throw new Error(`Queue "${name}" has not been declared by your parent agent. ${names.length ? `Declared queues: ${names.join(", ")}.` : "Your parent has declared no queues."}`);
    }
    const queue: SubagentQueueState = {
      name, ownerThreadId: caller.ownerThreadId, projectId: caller.projectId, frozen: false, members: [], lastRelease: null,
    };
    this.state.queues.set(queueKey(queue.ownerThreadId, name), queue);
    return { queue, declared: true };
  }

  private member(queue: SubagentQueueState, threadId: string) {
    return queue.members.find(member => member.threadId === threadId) ?? null;
  }

  private resolveMember(queue: SubagentQueueState, reference: string) {
    const wanted = reference.trim().toLocaleLowerCase();
    const member = wanted === SUBAGENT_QUEUE_PARENT_NAME
      ? this.member(queue, queue.ownerThreadId)
      : queue.members.find(candidate => candidate.threadId !== queue.ownerThreadId && candidate.name.toLocaleLowerCase() === wanted) ?? null;
    if (!member) throw new Error(`${reference} is not in queue ${queue.name}.`);
    return member;
  }

  private async join(caller: QueueCaller, queue: SubagentQueueState, description: string | null, placement: Placement | null, signal: AbortSignal) {
    let member = this.member(queue, caller.threadId);
    if (!member) {
      if (!description) throw new Error(`Joining queue ${queue.name} requires a description of the work you will hold it for.`);
      member = { threadId: caller.threadId, name: caller.name, description, enqueuedAt: this.now(), holdStartedAt: null, pausedReason: null };
      this.state.releaseNotes.delete(caller.threadId);
      this.place(queue, member, placement);
    } else {
      if (description) member.description = description;
      // The caller is running a tool, so its turn is live even if the lifecycle event has not landed yet.
      member.pausedReason = null;
      if (placement) this.place(queue, member, placement);
    }
    // The joining caller learns of an immediate hold from this result, never from a notice.
    this.advance(queue, member.threadId);
    if (member.holdStartedAt !== null) return renderSubagentQueueGranted(queue, this.now());
    return await this.waitForHold(queue, member, signal);
  }

  /** Insert or reposition a member; a holder moved off the front yields its hold. */
  private place(queue: SubagentQueueState, member: SubagentQueueMember, placement: Placement | null) {
    const target = placement ? this.resolveMember(queue, "after" in placement ? placement.after : placement.before) : null;
    if (target === member) throw new Error("A member cannot be placed relative to itself.");
    const wasHolder = member.holdStartedAt !== null;
    queue.members = queue.members.filter(candidate => candidate !== member);
    let index = queue.members.length;
    if (target && placement) {
      index = queue.members.indexOf(target) + ("after" in placement ? 1 : 0);
      // Placement never preempts a live holder; only dequeue, kick, stop or settle end a hold.
      const front = queue.members[0];
      if (index === 0 && front && front.holdStartedAt !== null) index = 1;
    }
    queue.members.splice(index, 0, member);
    if (wasHolder && index !== 0) {
      member.holdStartedAt = null;
      member.pausedReason = null;
      queue.lastRelease = { name: member.name, reason: "yielded", at: this.now() };
    }
    return wasHolder && index !== 0;
  }

  private move(caller: QueueCaller, queue: SubagentQueueState, name: string, placement: Placement) {
    if (!caller.isOwner) throw new Error("Only the parent agent can move or remove other members.");
    const member = this.resolveMember(queue, name);
    if (this.place(queue, member, placement)) {
      queue.lastRelease = { name: member.name, reason: "moved back by parent", at: this.now() };
      this.notify(queue, member.threadId, "moved");
    }
    this.advance(queue);
    return renderSubagentQueueInfo(queue, this.now());
  }

  private leave(caller: QueueCaller, queue: SubagentQueueState) {
    const member = this.member(queue, caller.threadId);
    if (!member) return `You are not in queue \`${queue.name}\`.\n\n${renderSubagentQueueInfo(queue, this.now())}`;
    this.remove(queue, member, "dequeued");
    const text = renderSubagentQueueLeft(queue, "left", this.now());
    this.settleWaiter(queue, member, text);
    this.advance(queue);
    return text;
  }

  private kick(caller: QueueCaller, queue: SubagentQueueState, name: string) {
    if (!caller.isOwner) throw new Error("Only the parent agent can move or remove other members.");
    const member = this.resolveMember(queue, name);
    if (member.threadId === caller.threadId) return this.leave(caller, queue);
    this.remove(queue, member, "removed by parent");
    if (!this.settleWaiter(queue, member, renderSubagentQueueLeft(queue, "removed", this.now())) && !member.pausedReason) {
      this.notify(queue, member.threadId, "removed");
    }
    this.state.releaseNotes.delete(member.threadId);
    this.advance(queue);
    return `Removed ${member.name} from queue \`${queue.name}\`.\n\n${renderSubagentQueueInfo(queue, this.now())}`;
  }

  private remove(queue: SubagentQueueState, member: SubagentQueueMember, reason: string) {
    queue.members = queue.members.filter(candidate => candidate !== member);
    if (member.holdStartedAt !== null) queue.lastRelease = { name: member.name, reason, at: this.now() };
  }

  /** Promote the first member unless the queue is frozen or already held. */
  private advance(queue: SubagentQueueState, caller?: WorkbenchThreadId) {
    if (queue.frozen) return;
    const first = queue.members[0];
    if (!first || first.holdStartedAt !== null) return;
    first.holdStartedAt = this.now();
    first.pausedReason = null;
    if (first.threadId === caller) return;
    if (!this.settleWaiter(queue, first, renderSubagentQueueGranted(queue, this.now()))) this.notify(queue, first.threadId, "front");
  }

  private settleWaiter(queue: SubagentQueueState, member: SubagentQueueMember, text: string) {
    const waiter = this.waiters.get(waiterKey(queue, member.threadId));
    waiter?.resolve(text);
    return Boolean(waiter);
  }

  private waitForHold(queue: SubagentQueueState, member: SubagentQueueMember, signal: AbortSignal) {
    const key = waiterKey(queue, member.threadId);
    this.waiters.get(key)?.resolve(`Superseded by a newer subagent_queue call for queue \`${queue.name}\`.`);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (this.waiters.get(key) === waiter) this.waiters.delete(key);
      };
      const waiter: QueueWaiter = {
        resolve: text => { cleanup(); resolve(text); },
        reject: error => { cleanup(); reject(error); },
      };
      // Aborting keeps membership: the caller rejoins to resume waiting at the same place.
      const onAbort = () => waiter.reject(signal.reason);
      this.waiters.set(key, waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private notify(queue: SubagentQueueState, threadId: WorkbenchThreadId, kind: Parameters<typeof renderSubagentQueueNotice>[1]) {
    const notice = renderSubagentQueueNotice(queue.name, kind);
    void (async () => {
      // A notice to a finished thread would start a new turn; finished members learn from the parent instead.
      const lifecycle = await this.ports.readLifecycle(queue.projectId, threadId);
      if (!lifecycle || classify(lifecycle) !== "active") return;
      await this.ports.sendNotice({ threadId, senderThreadId: queue.ownerThreadId, senderName: `queue ${queue.name}`, ...notice });
    })().catch((error: unknown) => {
      this.ports.warn(`Queue ${queue.name} ${kind} notice failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    });
  }

  private addReleaseNote(threadId: WorkbenchThreadId, note: string) {
    this.state.releaseNotes.set(threadId, [...(this.state.releaseNotes.get(threadId) ?? []), note]);
  }

  private observeLifecycle(projectId: string, entry: WorkbenchThreadSidebarEntry) {
    if (this.disposed || entry.entryKind === "draft") return;
    const threadId = entry.identity.threadId;
    const activity = classify(entry.lifecycle);
    for (const queue of this.state.queues.values()) {
      if (queue.projectId !== projectId) continue;
      if (queue.ownerThreadId === threadId) queue.frozen = activity !== "active";
      const member = this.member(queue, threadId);
      if (member) this.observeMember(queue, member, entry.lifecycle, activity);
      this.advance(queue);
    }
  }

  private observeMember(queue: SubagentQueueState, member: SubagentQueueMember, lifecycle: WorkbenchThreadLifecycle, activity: Activity) {
    const isChild = member.threadId !== queue.ownerThreadId;
    if (activity === "active") {
      if (!member.pausedReason) return;
      member.pausedReason = null;
      this.state.releaseNotes.delete(member.threadId);
      this.notify(queue, member.threadId, "resumed");
      return;
    }
    if (activity === "gone") {
      // Stop and settle are deliberate user or parent actions, so the hold hands off.
      this.remove(queue, member, lifecycle.settled ? "settled" : "stopped");
      this.settleWaiter(queue, member, renderSubagentQueueLeft(queue, "stopped", this.now()));
      return;
    }
    const reason = idleReason(lifecycle);
    if (member.holdStartedAt !== null) {
      if (member.pausedReason) return;
      member.pausedReason = reason;
      if (isChild) this.addReleaseNote(member.threadId, renderSubagentQueueReleaseNote(queue.name, member.name, { kind: "paused", reason }));
      return;
    }
    // A waiting member holds nothing, so its ended turn simply drops it.
    this.remove(queue, member, reason);
    this.settleWaiter(queue, member, renderSubagentQueueLeft(queue, "left", this.now()));
    if (isChild) this.addReleaseNote(member.threadId, renderSubagentQueueReleaseNote(queue.name, member.name, { kind: "left", reason }));
  }
}
