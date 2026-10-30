/*
 * Exports:
 * - NetworkTargetSchema/NetworkTarget: one remote thread, folder or feedback source an agent asks to network with, labelled for prompts.
 * - NetworkNeedSchema/NetworkNeed: what one relayed call requires of the target daemon's grants.
 * - NetworkGrantKindSchema/NetworkGrantKind, NetworkGrantSchema/NetworkGrant: a target daemon's inbound grant and its utilities.
 * - NetworkGrantCreateSchema/NetworkGrantCreate, NetworkGrantRevokeSchema/NetworkGrantRevoke: app-only grant writes on a target daemon.
 * - NetworkHistoryEntrySchema/NetworkHistoryEntry: a requesting thread's approved target, kept after revocation for presentation.
 * - WorkbenchUserInputNetworkAccessContextSchema/WorkbenchUserInputNetworkAccessContext: the questionnaire attachment of a network prompt.
 * - ThreadNetworkAccess: which daemons a thread is networked with and whether an app's reach can open it.
 * - NetworkAccessDecision: the approve/deny questionnaire a network prompt is stored as, and reading or writing its answer.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, type DaemonId, type WorkbenchThreadId } from "../identity";

const label = z.string().max(512);

export const NetworkTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"), daemonId: DaemonIdSchema, hostname: label, threadId: WorkbenchThreadIdSchema,
    title: label, projectName: label,
    /** The thread belongs to its daemon's own project and can run commands outside the sandbox there. */
    daemonProject: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("folder"), daemonId: DaemonIdSchema, hostname: label, projectId: ProjectIdSchema, rootPath: label,
  }).strict(),
  z.object({
    kind: z.literal("feedback"), daemonId: DaemonIdSchema, hostname: label,
    /** Null reads the `wb` channel across all projects; a folder reads that project's channel. */
    projectId: ProjectIdSchema.nullable(), rootPath: label.nullable(),
  }).strict(),
]);
export type NetworkTarget = z.infer<typeof NetworkTargetSchema>;

export const NetworkNeedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: WorkbenchThreadIdSchema }).strict(),
  z.object({ kind: z.literal("message"), threadId: WorkbenchThreadIdSchema }).strict(),
  z.object({ kind: z.literal("folder"), projectId: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("feedback"), projectId: ProjectIdSchema.nullable() }).strict(),
]);
export type NetworkNeed = z.infer<typeof NetworkNeedSchema>;

export const NetworkGrantKindSchema = z.enum(["thread", "message", "folder", "feedback"]);
export type NetworkGrantKind = z.infer<typeof NetworkGrantKindSchema>;

export const NetworkGrantSchema = z.object({
  id: z.uuid(),
  kind: NetworkGrantKindSchema,
  callerDaemonId: DaemonIdSchema,
  callerThreadId: WorkbenchThreadIdSchema,
  callerHostname: label,
  callerTitle: label,
  /** The granted thread for `thread` and `message` grants. */
  targetThreadId: WorkbenchThreadIdSchema.nullable(),
  /** The granted folder for `folder` grants; the feedback project, or null for all projects, for `feedback` grants. */
  targetProjectId: ProjectIdSchema.nullable(),
  /** What the grant names, for audit lists. */
  targetLabel: label,
  createdAt: z.number().int().nonnegative(),
}).strict();
export type NetworkGrant = z.infer<typeof NetworkGrantSchema>;

/** What an app writes onto a target daemon when the user approves a network prompt. */
export const NetworkGrantCreateSchema = NetworkGrantSchema.omit({ id: true, createdAt: true });
export type NetworkGrantCreate = z.infer<typeof NetworkGrantCreateSchema>;

/** Grant ids, or one caller thread's grants covering `need` (every grant it holds when absent). */
export const NetworkGrantRevokeSchema = z.union([
  z.object({ grantIds: z.array(z.uuid()).min(1).max(256) }).strict(),
  z.object({ callerDaemonId: DaemonIdSchema, callerThreadId: WorkbenchThreadIdSchema, need: NetworkNeedSchema.optional() }).strict(),
]);
export type NetworkGrantRevoke = z.infer<typeof NetworkGrantRevokeSchema>;

export const NetworkHistoryEntrySchema = z.object({
  id: z.uuid(),
  target: NetworkTargetSchema,
  approvedAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();
export type NetworkHistoryEntry = z.infer<typeof NetworkHistoryEntrySchema>;

export const WorkbenchUserInputNetworkAccessContextSchema = z.object({ target: NetworkTargetSchema }).strict();
export type WorkbenchUserInputNetworkAccessContext = z.infer<typeof WorkbenchUserInputNetworkAccessContextSchema>;

interface Caller { daemonId: DaemonId; threadId: WorkbenchThreadId }

const NETWORK_ACCESS_QUESTION_ID = "decision";
const NETWORK_ACCESS_APPROVE = "Approve";
const NETWORK_ACCESS_DENY = "Deny";

/** The fixed decision a network prompt is stored as; apps answer it once the grant is written. */
export namespace NetworkAccessDecision {
  export function questions(reason: string) {
    return [{
      id: NETWORK_ACCESS_QUESTION_ID, header: "Agent network access", question: reason,
      options: [
        { label: NETWORK_ACCESS_APPROVE, description: "Let this thread reach the target." },
        { label: NETWORK_ACCESS_DENY, description: "Keep the target out of reach." },
      ],
    }];
  }

  export function response(approved: boolean) {
    return { answers: { [NETWORK_ACCESS_QUESTION_ID]: { answers: [approved ? NETWORK_ACCESS_APPROVE : NETWORK_ACCESS_DENY] } } };
  }

  export function approved(response: { answers: Record<string, { answers: string[] }> } | null | undefined) {
    const answers = response?.answers[NETWORK_ACCESS_QUESTION_ID]?.answers ?? [];
    return answers.length === 1 && answers[0] === NETWORK_ACCESS_APPROVE;
  }
}

export namespace NetworkGrant {
  /** Whether any grant held by `caller` covers `need`; `thread` grants include messaging. */
  export function authorizes(grants: readonly NetworkGrant[], caller: Caller, need: NetworkNeed) {
    return grants.some(grant => grant.callerDaemonId === caller.daemonId && grant.callerThreadId === caller.threadId
      && covers(grant, need));
  }

  function covers(grant: NetworkGrant, need: NetworkNeed) {
    switch (need.kind) {
      case "thread": return grant.kind === "thread" && grant.targetThreadId === need.threadId;
      case "message": return (grant.kind === "thread" || grant.kind === "message") && grant.targetThreadId === need.threadId;
      case "folder": return grant.kind === "folder" && grant.targetProjectId === need.projectId;
      case "feedback": return grant.kind === "feedback" && grant.targetProjectId === need.projectId;
    }
  }

  /** The need a target answers once approved; a thread target grants full thread access. */
  export function needFor(target: NetworkTarget): NetworkNeed {
    if (target.kind === "thread") return { kind: "thread", threadId: target.threadId };
    if (target.kind === "folder") return { kind: "folder", projectId: target.projectId };
    return { kind: "feedback", projectId: target.projectId };
  }

  export function targetLabel(target: NetworkTarget) {
    if (target.kind === "thread") return `${target.title} (${target.projectName})`;
    if (target.kind === "folder") return target.rootPath;
    return target.rootPath ?? "wb feedback, all projects";
  }

  /** Whether revoking `need` removes `grant`. */
  export function matchesNeed(grant: NetworkGrant, need: NetworkNeed) {
    return covers(grant, need) && (need.kind !== "message" || grant.kind === "message");
  }

  export function sameTarget(left: NetworkTarget, right: NetworkTarget) {
    if (left.kind !== right.kind || left.daemonId !== right.daemonId) return false;
    if (left.kind === "thread" && right.kind === "thread") return left.threadId === right.threadId;
    if (left.kind === "folder" && right.kind === "folder") return left.projectId === right.projectId;
    return left.kind === "feedback" && right.kind === "feedback" && left.projectId === right.projectId;
  }
}

export namespace ThreadNetworkAccess {
  /**
   * Daemons whose content a thread may hold: every approved target, revoked or not, plus a remote parent. Revocation
   * stops new access but cannot remove what the thread already read. Same-daemon targets may appear; an app always
   * reaches the daemon holding the thread, so they never restrict it.
   */
  export function daemonIds(history: readonly Pick<NetworkHistoryEntry, "target">[], parentDaemonId: DaemonId | null = null): DaemonId[] {
    const ids = new Set(history.map(entry => entry.target.daemonId));
    if (parentDaemonId) ids.add(parentDaemonId);
    return [...ids].sort();
  }

  /** Networked daemons an app cannot reach; any one restricts the thread to its summary. */
  export function missing(networkDaemonIds: readonly DaemonId[] | undefined, reach: ReadonlySet<DaemonId>) {
    return (networkDaemonIds ?? []).filter(id => !reach.has(id));
  }

  export function isRestricted(networkDaemonIds: readonly DaemonId[] | undefined, reach: ReadonlySet<DaemonId>) {
    return missing(networkDaemonIds, reach).length > 0;
  }
}
