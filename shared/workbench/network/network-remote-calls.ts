/*
 * Exports:
 * - RemoteCallerSchema/RemoteCaller: the thread behind a relayed call; daemon and hostname are stamped by the relaying app.
 * - SiblingRosterEntrySchema/SiblingRosterEntry: one child of a parent, as the parent last pushed it to a sibling's daemon.
 * - RemoteCallSchema/RemoteCall: every call a daemon executes for another daemon's thread; anything else is refused.
 * - RemoteCallOutcomeSchema/RemoteCallOutcome: a call's text or data, a denial naming the grant it needs, or a failure.
 * - RemoteChildRowSchema/RemoteChildRow: a remote child's lifecycle as its own daemon reports it to the parent.
 * - RemoteChildApprovalSchema/RemoteChildApproval: one shown outside-sandbox request of a remote child.
 */
import { z } from "zod";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "../identity";
import { WorkbenchThreadLifecycleSchema } from "../thread/thread-state";
import { WorkbenchApprovalDecisionSchema, WorkbenchApprovalSubjectSchema } from "../provider/provider-approval";
import { NetworkNeedSchema } from "./network-grants";

const text = z.string().trim().min(1);
const json = z.record(z.string(), z.json());

export const RemoteCallerSchema = z.object({
  daemonId: DaemonIdSchema,
  hostname: z.string().max(512),
  threadId: WorkbenchThreadIdSchema,
  title: z.string().max(512),
}).strict();
export type RemoteCaller = z.infer<typeof RemoteCallerSchema>;

export const SiblingRosterEntrySchema = z.object({
  daemonId: DaemonIdSchema,
  threadId: WorkbenchThreadIdSchema,
  name: text,
}).strict();
export type SiblingRosterEntry = z.infer<typeof SiblingRosterEntrySchema>;

export const RemoteCallSchema = z.discriminatedUnion("kind", [
  /** `wb thread recall [search]` against one granted thread; `query` is the recall URL's search string. */
  z.object({ kind: z.literal("recall"), threadId: WorkbenchThreadIdSchema, search: z.boolean(), query: z.string(), body: z.string().nullable() }).strict(),
  /** One `wb transcript` command whose thread ids all belong to the target. */
  z.object({ kind: z.literal("transcript"), threadIds: z.array(WorkbenchThreadIdSchema).min(1), body: json }).strict(),
  z.object({ kind: z.literal("feedbackStats"), projectId: ProjectIdSchema.nullable(), body: json }).strict(),
  z.object({
    kind: z.literal("message"), threadId: WorkbenchThreadIdSchema, senderName: text, message: text, userVisibleSimpleVersion: text,
  }).strict(),
  z.object({ kind: z.literal("subagentProfiles"), projectId: ProjectIdSchema }).strict(),
  z.object({
    kind: z.literal("subagentCreate"), projectId: ProjectIdSchema, profileId: text, name: text, title: text, message: text,
    userVisibleSimpleVersion: text, directSubagentIndex: z.number().int().nonnegative(), siblings: z.array(SiblingRosterEntrySchema),
  }).strict(),
  z.object({ kind: z.literal("childRead"), threadIds: z.array(WorkbenchThreadIdSchema).min(1) }).strict(),
  z.object({ kind: z.literal("childStop"), threadIds: z.array(WorkbenchThreadIdSchema).min(1) }).strict(),
  z.object({ kind: z.literal("childSettle"), threadId: WorkbenchThreadIdSchema }).strict(),
  z.object({ kind: z.literal("siblingRoster"), threadId: WorkbenchThreadIdSchema, siblings: z.array(SiblingRosterEntrySchema) }).strict(),
  /** One way: the child becomes a top-level thread on its own daemon and leaves its parent. */
  z.object({ kind: z.literal("childPromote"), threadId: WorkbenchThreadIdSchema }).strict(),
  /** The child's shown outside-sandbox requests, for its parent to forward or deny. */
  z.object({ kind: z.literal("childApprovals"), threadId: WorkbenchThreadIdSchema }).strict(),
  z.object({
    kind: z.literal("childApprovalDecide"), threadId: WorkbenchThreadIdSchema, requestKey: text, decision: WorkbenchApprovalDecisionSchema,
  }).strict(),
  /** A remote child tells its parent's daemon that its lifecycle changed, waking the parent's waits. */
  z.object({ kind: z.literal("childChanged") }).strict(),
  /** A remote child's `wb subagent queue|dequeue`, executed by its parent's daemon. */
  z.object({ kind: z.literal("queue"), parentThreadId: WorkbenchThreadIdSchema, body: json }).strict(),
  /** The caller settled: drop every grant it holds on the target. */
  z.object({ kind: z.literal("release") }).strict(),
]);
export type RemoteCall = z.infer<typeof RemoteCallSchema>;

export const RemoteChildRowSchema = z.object({
  threadId: WorkbenchThreadIdSchema,
  lifecycle: WorkbenchThreadLifecycleSchema,
  activityAt: z.number().int().nonnegative(),
  pinned: z.boolean(),
  /** The child's latest turn output or pending question, rendered by its own daemon once it stops working. */
  output: z.string().max(200_000).nullable(),
  /** The child waits on a questionnaire rather than having finished. */
  needsInteraction: z.boolean(),
}).strict();
export type RemoteChildRow = z.infer<typeof RemoteChildRowSchema>;

export const RemoteChildApprovalSchema = z.object({ requestKey: text, subject: WorkbenchApprovalSubjectSchema }).strict();
export type RemoteChildApproval = z.infer<typeof RemoteChildApprovalSchema>;

export const RemoteCallOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), text: z.string().nullable(), data: z.json().nullable() }).strict(),
  z.object({ kind: z.literal("denied"), need: NetworkNeedSchema.nullable(), failure: z.string().max(1024) }).strict(),
  z.object({ kind: z.literal("failed"), failure: z.string().max(4096) }).strict(),
]);
export type RemoteCallOutcome = z.infer<typeof RemoteCallOutcomeSchema>;
