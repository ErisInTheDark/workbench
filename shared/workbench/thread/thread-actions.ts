/*
 * Exports:
 * - WorkbenchThreadMessageSchema/WorkbenchThreadMessage: user intent submitted to a WB thread.
 * - WorkbenchThreadMessageResultSchema/WorkbenchThreadMessageResult: accepted start or steer.
 * - WorkbenchThreadCreateSchema/WorkbenchThreadCreate: project/profile selection for creation.
 * - WorkbenchThreadTargetSchema/WorkbenchThreadTarget: existing WB thread selection.
 * - WorkbenchThreadPageSchema/WorkbenchThreadPage: opaque history continuation.
 * - WorkbenchThreadReconciliationTargetSchema/WorkbenchThreadReconciliationTarget: demanded native recovery window.
 * - WorkbenchThreadReconcileSchema/WorkbenchThreadReconcile: explicit canonical reconciliation intent.
 * - WorkbenchThreadReconcileResultSchema/WorkbenchThreadReconcileResult: recorded recovery outcome, never native content.
 * - WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED/WorkbenchTranscriptRecoveryRequiredError: a valid requested window needs explicit reconciliation.
 * - WorkbenchThreadStopSchema/WorkbenchThreadStop: shared stop versus snooze intent.
 * - WorkbenchThreadPayloadSchema: validate the public metadata envelope.
 * - WorkbenchThreadPageResult/WorkbenchThreadPageResultSchema: WB page and domain-history facts.
 * - workbenchThreadActions/WorkbenchThreadActionMap: shared request and result contract registry.
 */
import { z } from "zod";
import type {
  ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry, WorkbenchThreadContextEntryScope, WorkbenchPendingUserInputRequest,
} from "../../types.ts";
import type { Turn } from "./workbench-thread-turn.ts";
import { WorkbenchThreadCreationProfileSchema } from "./thread-profile.ts";
import { WorkbenchMessageContextSchema, WorkbenchUserInputSchema } from "../provider/provider-input.ts";
import { WorkbenchProviderGoalSchema, WorkbenchProviderGoalUpdateSchema } from "../provider/provider-goal.ts";
import { WorkbenchDurableQuestionnaireSchema, WorkbenchQuestionnaireHistoryEntrySchema } from "./thread-state.ts";

const threadId = z.string().trim().min(1);
export const WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED = -32011;
export class WorkbenchTranscriptRecoveryRequiredError extends Error {}
const turnEnvelope = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  items: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()),
}).passthrough();
const turn = z.custom<Turn>(value => turnEnvelope.safeParse(value).success);

export const WorkbenchThreadTargetSchema = z.object({ threadId });
export type WorkbenchThreadTarget = z.infer<typeof WorkbenchThreadTargetSchema>;
export const WorkbenchThreadReconciliationTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("latest") }),
  z.object({ mode: z.literal("previous"), beforeTurnId: z.string().min(1) }),
  z.object({ mode: z.literal("exact"), turnId: z.string().min(1) }),
]);
export type WorkbenchThreadReconciliationTarget = z.infer<typeof WorkbenchThreadReconciliationTargetSchema>;
export const WorkbenchThreadReconcileSchema = WorkbenchThreadTargetSchema.extend({
  target: WorkbenchThreadReconciliationTargetSchema,
  refresh: z.boolean().default(false),
}).transform(({ threadId, target, refresh }): WorkbenchThreadReconcile => ({ threadId, target, refresh }));
export type WorkbenchThreadReconcile = {
  threadId: string;
  target: WorkbenchThreadReconciliationTarget;
  refresh: boolean;
};
export const WorkbenchThreadReconcileResultSchema = z.object({
  turnIds: z.array(z.string()),
  exhausted: z.boolean().default(false),
});
export type WorkbenchThreadReconcileResult = z.infer<typeof WorkbenchThreadReconcileResultSchema>;
const message = {
  threadId,
  clientMessageId: z.string().min(1),
  input: z.array(WorkbenchUserInputSchema),
  context: WorkbenchMessageContextSchema.optional(),
};
export const WorkbenchThreadMessageSchema = z.discriminatedUnion("intent", [
  z.object({ ...message, intent: z.literal("continue") }),
  z.object({ ...message, intent: z.literal("newTurn") }),
  z.object({ ...message, intent: z.literal("steer"), expectedTurnId: z.string().min(1) }),
]);
export type WorkbenchThreadMessage = z.infer<typeof WorkbenchThreadMessageSchema>;
export const WorkbenchThreadMessageResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), turn, warning: z.string().optional() }),
  z.object({ kind: z.literal("steered"), turnId: z.string().min(1), warning: z.string().optional() }),
]);
export type WorkbenchThreadMessageResult = z.infer<typeof WorkbenchThreadMessageResultSchema>;

export const WorkbenchThreadCreateSchema = z.object({
  projectId: z.string().min(1),
  profile: WorkbenchThreadCreationProfileSchema,
  context: WorkbenchMessageContextSchema.optional(),
  additionalWritableRoots: z.array(z.string().min(1)).optional(),
});
export type WorkbenchThreadCreate = z.infer<typeof WorkbenchThreadCreateSchema>;
export const WorkbenchThreadPageSchema = WorkbenchThreadTargetSchema.extend({
  cursor: z.string().min(1).nullable(),
  readScope: z.literal("subagentBackground").optional(),
  recoveryAware: z.boolean().optional(),
});
export type WorkbenchThreadPage = z.infer<typeof WorkbenchThreadPageSchema>;
export const WorkbenchThreadStopSchema = WorkbenchThreadTargetSchema.extend({
  intent: z.enum(["stop", "snooze"]),
  turnId: z.string().min(1).optional(),
  requestKey: z.string().min(1).optional(),
});
export type WorkbenchThreadStop = z.infer<typeof WorkbenchThreadStopSchema>;

const threadEnvelope = z.object({
  id: threadId,
  harness: z.string().min(1),
  isDraft: z.literal(false),
  cwd: z.string(),
  status: z.string(),
  turns: z.array(turn),
  turnHistory: z.array(z.object({ turnId: z.string().min(1) }).passthrough()),
}).passthrough();
export const WorkbenchThreadPayloadSchema = z.custom<ThreadPayload>(
  value => threadEnvelope.safeParse(value).success,
);
export interface WorkbenchThreadPageResult {
  thread: ThreadPayload;
  nextCursor: string | null;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  browseResultEntries: WorkbenchBrowseResultEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  recovery?: WorkbenchThreadReconciliationTarget | null;
}
const pageEnvelope = z.object({
  thread: WorkbenchThreadPayloadSchema,
  nextCursor: z.string().nullable(),
  questionnaireEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  steerEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  browseResultEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  recovery: WorkbenchThreadReconciliationTargetSchema.nullable().default(null),
}).passthrough();
export const WorkbenchThreadPageResultSchema = z.custom<WorkbenchThreadPageResult>(
  value => pageEnvelope.safeParse(value).success,
);
const ok = z.object({ ok: z.literal(true) });
const goalResult = z.object({ goal: WorkbenchProviderGoalSchema.nullable() });
const questionnaireRequest = WorkbenchDurableQuestionnaireSchema.shape.request.extend({
  questions: z.array(WorkbenchDurableQuestionnaireSchema.shape.request.shape.questions.element),
}).passthrough();
const pendingQuestionnaire = WorkbenchDurableQuestionnaireSchema.extend({
  harness: z.string(), threadId, request: questionnaireRequest,
}).passthrough() as z.ZodType<WorkbenchPendingUserInputRequest>;
const questionnaireHistory = WorkbenchQuestionnaireHistoryEntrySchema.extend({
  request: questionnaireRequest,
  // Compatibility history places a question before the first provider item at -1.
  insertAfterItemIndex: z.number().int().min(-1).nullable(),
}).passthrough() as z.ZodType<WorkbenchQuestionnaireHistoryEntry>;
const steerHistory = z.object({
  itemId: z.string().optional(), entryKey: z.string(), threadId, turnId: z.string(),
  input: z.array(WorkbenchUserInputSchema), status: z.enum(["pending", "sent", "interrupted", "failed"]),
  attemptedAt: z.number(), resolvedAt: z.number().nullable(), requestId: z.string().nullable(),
  canonicalItemId: z.string().nullable(), clientUserMessageId: z.string().nullable().optional(),
  dispatchSequence: z.number().nullable().optional(), error: z.string().nullable(),
}).passthrough() as z.ZodType<WorkbenchSteerHistoryEntry>;
const browseHistory = z.object({
  action: z.string(), actionIndex: z.number(), assetUrl: z.string().nullable(), commandItemId: z.string().nullable(),
  detailKind: z.enum(["error", "result", "text"]).nullable().optional(),
  detailLabel: z.string().nullable().optional(), detailText: z.string().nullable().optional(),
  durationMs: z.number().nullable(), entryKey: z.string(), recordedAt: z.number(), session: z.string().nullable(),
  state: z.enum(["completed", "failed", "inProgress", "queued"]), threadId, turnId: z.string(),
}).passthrough() as z.ZodType<WorkbenchBrowseResultEntry>;

export const workbenchThreadActions = {
  "questionnaires/pending/read": { params: z.object({}), result: z.object({ data: z.array(pendingQuestionnaire) }) },
  "thread/questionnaires/read": { params: WorkbenchThreadTargetSchema, result: z.object({ data: z.array(questionnaireHistory) }) },
  "thread/steers/read": { params: WorkbenchThreadTargetSchema, result: z.object({ data: z.array(steerHistory) }) },
  "thread/browse/read": { params: WorkbenchThreadTargetSchema, result: z.object({ data: z.array(browseHistory) }) },
  "thread/create": { params: WorkbenchThreadCreateSchema, result: WorkbenchThreadPayloadSchema },
  "thread/metadata/read": { params: WorkbenchThreadTargetSchema, result: WorkbenchThreadPayloadSchema },
  "thread/page/read": { params: WorkbenchThreadPageSchema, result: WorkbenchThreadPageResultSchema },
  "thread/reconcile": { params: WorkbenchThreadReconcileSchema, result: WorkbenchThreadReconcileResultSchema },
  "thread/message/submit": { params: WorkbenchThreadMessageSchema, result: WorkbenchThreadMessageResultSchema },
  "thread/title/set": { params: WorkbenchThreadTargetSchema.extend({ title: z.string() }), result: ok },
  "thread/compact": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/provider/delete": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/stop": { params: WorkbenchThreadStopSchema, result: ok },
  "thread/goal/read": { params: WorkbenchThreadTargetSchema, result: goalResult },
  "thread/goal/update": { params: WorkbenchProviderGoalUpdateSchema, result: goalResult },
  "thread/goal/remove": { params: WorkbenchThreadTargetSchema, result: ok },
} as const;
export type WorkbenchThreadActionMap = {
  [Method in keyof typeof workbenchThreadActions]: {
    params: z.infer<typeof workbenchThreadActions[Method]["params"]>;
    result: z.infer<typeof workbenchThreadActions[Method]["result"]>;
  };
};
