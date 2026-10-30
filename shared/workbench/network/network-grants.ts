/*
 * Exports:
 * - NetworkNeedSchema/NetworkNeed: what one relayed call requires of the target daemon's grants.
 * - NetworkGrantKindSchema/NetworkGrantKind, NetworkGrantSchema/NetworkGrant: a target daemon's inbound grant and its utilities.
 * - NetworkGrantCreateSchema/NetworkGrantCreate, NetworkGrantRevokeSchema/NetworkGrantRevoke: app-only grant writes on a target daemon.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, type DaemonId, type WorkbenchThreadId } from "../identity";
import type { NetworkTarget } from "./network-access";

const label = z.string().max(512);

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
  /** What the grant names, readable without resolving the target. */
  targetLabel: label,
  createdAt: z.number().int().nonnegative(),
}).strict();
export type NetworkGrant = z.infer<typeof NetworkGrantSchema>;

/** What an app writes onto a target daemon when the user approves a network prompt. */
export const NetworkGrantCreateSchema = NetworkGrantSchema.omit({ id: true, createdAt: true });
export type NetworkGrantCreate = z.infer<typeof NetworkGrantCreateSchema>;

/** One caller thread's grants covering `need` (every grant it holds when absent). */
export const NetworkGrantRevokeSchema = z.object({
  callerDaemonId: DaemonIdSchema, callerThreadId: WorkbenchThreadIdSchema, need: NetworkNeedSchema.optional(),
}).strict();
export type NetworkGrantRevoke = z.infer<typeof NetworkGrantRevokeSchema>;

interface Caller { daemonId: DaemonId; threadId: WorkbenchThreadId }

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
