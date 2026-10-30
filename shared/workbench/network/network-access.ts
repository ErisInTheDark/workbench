/*
 * Exports:
 * - NetworkTargetSchema/NetworkTarget: one remote thread, folder or feedback source an agent asks to network with, labelled for prompts.
 * - NetworkHistoryEntrySchema/NetworkHistoryEntry: a requesting thread's approved target, kept after revocation for presentation.
 * - WorkbenchUserInputNetworkAccessContextSchema/WorkbenchUserInputNetworkAccessContext: the questionnaire attachment of a network prompt.
 * - NetworkAccessDecision: the approve/deny questionnaire a network prompt is stored as, and reading or writing its answer.
 * - ThreadNetworkAccess: which daemons a thread is networked with and whether an app's reach can open it.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, type DaemonId } from "../identity";

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

export const NetworkHistoryEntrySchema = z.object({
  id: z.uuid(),
  target: NetworkTargetSchema,
  approvedAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();
export type NetworkHistoryEntry = z.infer<typeof NetworkHistoryEntrySchema>;

export const WorkbenchUserInputNetworkAccessContextSchema = z.object({ target: NetworkTargetSchema }).strict();
export type WorkbenchUserInputNetworkAccessContext = z.infer<typeof WorkbenchUserInputNetworkAccessContextSchema>;

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
