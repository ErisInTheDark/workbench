/*
 * Exports:
 * - RemoteCallPorts: what this daemon's owners offer relayed calls; none of them can relay further.
 * - RemoteCallEntry/remoteCallRegistry: per call kind, how this daemon authorizes it against its own records and executes it.
 */
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { NetworkGrant, type NetworkNeed, type NetworkGrant as Grant } from "workbench-shared/workbench/network/network-grants";
import type {
  RemoteCall, RemoteCaller, RemoteCallOutcome, RemoteChildApproval, RemoteChildRow, SiblingRosterEntry,
} from "workbench-shared/workbench/network/network-remote-calls";

/** A local thread's subagent facts, as authorization reads them. */
export interface RemoteCallThread {
  threadId: WorkbenchThreadId;
  /** Present for subagents; `parentDaemonId` only when the parent lives on another daemon. */
  parent: { threadId: WorkbenchThreadId; daemonId: string | null } | null;
}

export interface RemoteCallPorts {
  /** This daemon's id; a child whose parent is local names no parent daemon. */
  selfDaemonId(): string | null;
  grants(caller: RemoteCaller): Promise<Grant[]>;
  thread(threadId: WorkbenchThreadId): Promise<RemoteCallThread | null>;
  roster(threadId: WorkbenchThreadId): Promise<SiblingRosterEntry[]>;
  /** Whether `caller` is a child of local `parentThreadId` that lives on the caller's daemon. */
  isRemoteChild(parentThreadId: WorkbenchThreadId, caller: RemoteCaller): Promise<boolean>;
  /** Local threads whose remote children include `caller`. */
  remoteParentsOf(caller: RemoteCaller): Promise<WorkbenchThreadId[]>;
  recall(input: Extract<RemoteCall, { kind: "recall" }>, signal: AbortSignal): Promise<string>;
  transcript(body: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  feedbackStats(projectId: ProjectId | null, body: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  message(caller: RemoteCaller, input: Extract<RemoteCall, { kind: "message" }>): Promise<void>;
  subagentProfiles(projectId: ProjectId): Promise<unknown>;
  subagentCreate(caller: RemoteCaller, input: Extract<RemoteCall, { kind: "subagentCreate" }>): Promise<{ threadId: WorkbenchThreadId; cwd: string; harness: string }>;
  childRead(threadIds: readonly WorkbenchThreadId[]): Promise<RemoteChildRow[]>;
  childStop(threadIds: readonly WorkbenchThreadId[]): Promise<void>;
  childSettle(threadId: WorkbenchThreadId): Promise<string>;
  writeRoster(threadId: WorkbenchThreadId, siblings: readonly SiblingRosterEntry[]): Promise<void>;
  childPromote(caller: RemoteCaller, threadId: WorkbenchThreadId): Promise<void>;
  childApprovals(threadId: WorkbenchThreadId): RemoteChildApproval[];
  childApprovalDecide(input: Extract<RemoteCall, { kind: "childApprovalDecide" }>): Promise<void>;
  childChanged(parentThreadIds: readonly WorkbenchThreadId[]): void;
  queue(caller: RemoteCaller, parentThreadId: WorkbenchThreadId, body: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  release(caller: RemoteCaller): Promise<number>;
}

type Authorization = { allowed: true } | { allowed: false; need: NetworkNeed | null; failure: string };
type Ok = Extract<RemoteCallOutcome, { kind: "ok" }>;

export interface RemoteCallEntry<Call extends RemoteCall> {
  authorize(ports: RemoteCallPorts, caller: RemoteCaller, call: Call): Promise<Authorization>;
  execute(ports: RemoteCallPorts, caller: RemoteCaller, call: Call, signal: AbortSignal): Promise<Ok>;
}

const allowed: Authorization = { allowed: true };
const text = (value: string): Ok => ({ kind: "ok", text: value, data: null });
const data = (value: unknown): Ok => ({ kind: "ok", text: null, data: value as Ok["data"] });

async function grant(ports: RemoteCallPorts, caller: RemoteCaller, need: NetworkNeed, failure: string): Promise<Authorization> {
  return NetworkGrant.authorizes(await ports.grants(caller), caller, need) ? allowed : { allowed: false, need, failure };
}

async function threadsGranted(ports: RemoteCallPorts, caller: RemoteCaller, threadIds: readonly WorkbenchThreadId[]) {
  for (const threadId of threadIds) {
    if (!await ports.thread(threadId)) return { allowed: false as const, need: null, failure: `Thread ${threadId} does not exist on this daemon.` };
    const result = await grant(ports, caller, { kind: "thread", threadId }, `This daemon has not granted you thread ${threadId}.`);
    if (!result.allowed) return result;
  }
  return allowed;
}

/** Child operations come only from the parent recorded on each child. */
function isParent(ports: RemoteCallPorts, thread: RemoteCallThread, caller: RemoteCaller) {
  return Boolean(thread.parent) && (thread.parent!.daemonId ?? ports.selfDaemonId()) === caller.daemonId
    && thread.parent!.threadId === caller.threadId;
}

async function ownChildren(ports: RemoteCallPorts, caller: RemoteCaller, threadIds: readonly WorkbenchThreadId[]): Promise<Authorization> {
  for (const threadId of threadIds) {
    const thread = await ports.thread(threadId);
    if (!thread || !isParent(ports, thread, caller)) {
      return { allowed: false, need: null, failure: `Thread ${threadId} is not your subagent on this daemon.` };
    }
  }
  return allowed;
}

/**
 * Messages need a grant, or a family tie this daemon can verify from its own records: the caller is the target's
 * recorded parent, a remote child of the target, or a sibling on the target's parent-pushed roster.
 */
async function messageAllowed(ports: RemoteCallPorts, caller: RemoteCaller, threadId: WorkbenchThreadId): Promise<Authorization> {
  const thread = await ports.thread(threadId);
  if (!thread) return { allowed: false, need: null, failure: `Thread ${threadId} does not exist on this daemon.` };
  const parent = thread.parent;
  if (isParent(ports, thread, caller)) return allowed;
  if (await ports.isRemoteChild(threadId, caller)) return allowed;
  if (parent?.daemonId && (await ports.roster(threadId)).some(sibling =>
    sibling.daemonId === caller.daemonId && sibling.threadId === caller.threadId)) return allowed;
  if (parent && !parent.daemonId && await ports.isRemoteChild(parent.threadId, caller)) return allowed;
  return await grant(ports, caller, { kind: "message", threadId }, `This daemon has not granted you messaging thread ${threadId}.`);
}

export const remoteCallRegistry: { [Kind in RemoteCall["kind"]]: RemoteCallEntry<Extract<RemoteCall, { kind: Kind }>> } = {
  recall: {
    authorize: (ports, caller, call) => threadsGranted(ports, caller, [call.threadId]),
    execute: async (ports, _caller, call, signal) => text(await ports.recall(call, signal)),
  },
  transcript: {
    authorize: (ports, caller, call) => threadsGranted(ports, caller, call.threadIds),
    execute: async (ports, _caller, call, signal) => text(await ports.transcript({ ...call.body, threads: call.threadIds }, signal)),
  },
  feedbackStats: {
    authorize: (ports, caller, call) => grant(ports, caller, { kind: "feedback", projectId: call.projectId },
      "This daemon has not granted you its feedback."),
    execute: async (ports, _caller, call, signal) => text(await ports.feedbackStats(call.projectId, call.body, signal)),
  },
  message: {
    authorize: (ports, caller, call) => messageAllowed(ports, caller, call.threadId),
    execute: async (ports, caller, call) => {
      await ports.message(caller, call);
      return text("Delivered.");
    },
  },
  subagentProfiles: {
    authorize: (ports, caller, call) => grant(ports, caller, { kind: "folder", projectId: call.projectId },
      "This daemon has not granted you that folder."),
    execute: async (ports, _caller, call) => data(await ports.subagentProfiles(call.projectId)),
  },
  subagentCreate: {
    authorize: (ports, caller, call) => grant(ports, caller, { kind: "folder", projectId: call.projectId },
      "This daemon has not granted you that folder."),
    execute: async (ports, caller, call) => data(await ports.subagentCreate(caller, call)),
  },
  childRead: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, call.threadIds),
    execute: async (ports, _caller, call) => data(await ports.childRead(call.threadIds)),
  },
  childStop: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, call.threadIds),
    execute: async (ports, _caller, call) => {
      await ports.childStop(call.threadIds);
      return text("Stopped.");
    },
  },
  childSettle: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, [call.threadId]),
    execute: async (ports, _caller, call) => text(await ports.childSettle(call.threadId)),
  },
  siblingRoster: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, [call.threadId]),
    execute: async (ports, _caller, call) => {
      await ports.writeRoster(call.threadId, call.siblings);
      return text("Recorded.");
    },
  },
  childPromote: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, [call.threadId]),
    execute: async (ports, caller, call) => {
      await ports.childPromote(caller, call.threadId);
      return text("Promoted.");
    },
  },
  childApprovals: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, [call.threadId]),
    execute: async (ports, _caller, call) => data(ports.childApprovals(call.threadId)),
  },
  childApprovalDecide: {
    authorize: (ports, caller, call) => ownChildren(ports, caller, [call.threadId]),
    execute: async (ports, _caller, call) => {
      await ports.childApprovalDecide(call);
      return text("Decided.");
    },
  },
  childChanged: {
    authorize: async (ports, caller) => (await ports.remoteParentsOf(caller)).length
      ? allowed : { allowed: false, need: null, failure: "You are not a subagent of any thread on this daemon." },
    execute: async (ports, caller) => {
      ports.childChanged(await ports.remoteParentsOf(caller));
      return text("Noted.");
    },
  },
  queue: {
    authorize: async (ports, caller, call) => await ports.isRemoteChild(call.parentThreadId, caller)
      ? allowed : { allowed: false, need: null, failure: "You are not a subagent of that thread." },
    execute: async (ports, caller, call, signal) => text(await ports.queue(caller, call.parentThreadId, call.body, signal)),
  },
  release: {
    authorize: async () => allowed,
    execute: async (ports, caller) => text(`Released ${await ports.release(caller)} grants.`),
  },
};
