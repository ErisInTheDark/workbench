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
 * - WorkbenchThreadStopSchema/WorkbenchThreadStop: user stop of a live turn and its seen questionnaire.
 * - WorkbenchThreadInterruptSchema/WorkbenchThreadInterrupt: interrupt that snoozes and keeps a questionnaire.
 * - WorkbenchThreadSteerTargetSchema/WorkbenchThreadSteerTarget: one held steer to resend or dismiss.
 * - WorkbenchThreadShellTargetSchema/WorkbenchThreadShellTarget: one running wb shell item for the user to stop.
 * - WorkbenchThreadHistoryReadSchema: thread history read, optionally narrowed to some turns.
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
import { WorkbenchThreadGoalObjectiveSchema, WorkbenchThreadGoalSchema } from "./thread-goal.ts";
import { WorkbenchThreadTodoSchema, WorkbenchThreadTodoTextSchema } from "./thread-todo.ts";
import { WORKBENCH_APPROVAL_OUTCOMES, type WorkbenchApprovalOutcomeEntry } from "../provider/provider-approval.ts";
import { WorkbenchDurableQuestionnaireSchema, WorkbenchQuestionnaireHistoryEntrySchema } from "./thread-state.ts";
import { WorkbenchThreadSkillSchema } from "./thread-skill-state.ts";

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
  /** False when no transcript commit for the thread landed during reconciliation; absent (older daemons) means unknown. */
  changed: z.boolean().optional(),
});
export type WorkbenchThreadReconcileResult = z.infer<typeof WorkbenchThreadReconcileResultSchema>;
const message = {
  threadId,
  clientMessageId: z.string().min(1),
  input: z.array(WorkbenchUserInputSchema),
  context: WorkbenchMessageContextSchema.optional(),
  skipAutoCompact: z.boolean().optional(),
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
  // Kept so either reload order works with daemons that still require it.
  intent: z.literal("stop"),
  turnId: z.string().min(1).optional(),
  requestKey: z.string().min(1).optional(),
});
export type WorkbenchThreadStop = z.infer<typeof WorkbenchThreadStopSchema>;
/** Interrupt the turn holding this questionnaire and snooze the thread, keeping the questionnaire. */
export const WorkbenchThreadInterruptSchema = WorkbenchThreadTargetSchema.extend({
  requestKey: z.string().min(1),
});
export type WorkbenchThreadInterrupt = z.infer<typeof WorkbenchThreadInterruptSchema>;
export const WorkbenchThreadSteerTargetSchema = WorkbenchThreadTargetSchema.extend({
  itemId: z.string().min(1),
});
export type WorkbenchThreadSteerTarget = z.infer<typeof WorkbenchThreadSteerTargetSchema>;
export const WorkbenchThreadShellTargetSchema = WorkbenchThreadTargetSchema.extend({
  itemId: z.string().min(1),
});
export type WorkbenchThreadShellTarget = z.infer<typeof WorkbenchThreadShellTargetSchema>;

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
  /** Absent from daemons that predate per-item approval outcomes. */
  approvalEntries?: WorkbenchApprovalOutcomeEntry[];
  entryScope?: WorkbenchThreadContextEntryScope;
  recovery?: WorkbenchThreadReconciliationTarget | null;
}
const approvalOutcome = z.object({
  threadId, turnId: z.string().min(1), itemId: z.string().min(1),
  outcome: z.enum(WORKBENCH_APPROVAL_OUTCOMES), resolvedAt: z.number(),
});
const pageEnvelope = z.object({
  thread: WorkbenchThreadPayloadSchema,
  nextCursor: z.string().nullable(),
  questionnaireEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  steerEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  browseResultEntries: z.array(z.object({ threadId, turnId: z.string() }).passthrough()),
  approvalEntries: z.array(approvalOutcome).optional(),
  recovery: WorkbenchThreadReconciliationTargetSchema.nullable().default(null),
}).passthrough();
export const WorkbenchThreadPageResultSchema = z.custom<WorkbenchThreadPageResult>(
  value => pageEnvelope.safeParse(value).success,
);
const ok = z.object({ ok: z.literal(true) });
const goalResult = z.object({ goal: WorkbenchThreadGoalSchema.nullable() });
const skillsResult = z.object({ skills: z.array(WorkbenchThreadSkillSchema) });
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
  input: z.array(WorkbenchUserInputSchema), status: z.enum(["pending", "sent", "interrupted", "failed", "dismissed"]),
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

/** `turnIds` narrows a history read to those turns; daemons that predate it, or cannot scope, read the whole thread. */
export const WorkbenchThreadHistoryReadSchema = WorkbenchThreadTargetSchema.extend({
  turnIds: z.array(z.string().min(1)).min(1).max(50).optional(),
});
/** `turnIds` is present only when the data covers just those turns; absent means the whole thread. */
const historyResult = <Entry extends z.ZodTypeAny>(entry: Entry) => z.object({
  data: z.array(entry), turnIds: z.array(z.string()).optional(),
});

export const workbenchThreadActions = {
  "questionnaires/pending/read": { params: z.object({}), result: z.object({ data: z.array(pendingQuestionnaire) }) },
  "thread/questionnaires/read": { params: WorkbenchThreadHistoryReadSchema, result: historyResult(questionnaireHistory) },
  "thread/steers/read": { params: WorkbenchThreadHistoryReadSchema, result: historyResult(steerHistory) },
  "thread/browse/read": { params: WorkbenchThreadHistoryReadSchema, result: historyResult(browseHistory) },
  "thread/approvals/read": { params: WorkbenchThreadHistoryReadSchema, result: historyResult(approvalOutcome) },
  "thread/create": { params: WorkbenchThreadCreateSchema, result: WorkbenchThreadPayloadSchema },
  "thread/metadata/read": { params: WorkbenchThreadTargetSchema, result: WorkbenchThreadPayloadSchema },
  "thread/page/read": { params: WorkbenchThreadPageSchema, result: WorkbenchThreadPageResultSchema },
  "thread/reconcile": { params: WorkbenchThreadReconcileSchema, result: WorkbenchThreadReconcileResultSchema },
  "thread/message/submit": { params: WorkbenchThreadMessageSchema, result: WorkbenchThreadMessageResultSchema },
  "thread/title/set": { params: WorkbenchThreadTargetSchema.extend({ title: z.string() }), result: ok },
  "thread/compact": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/provider/delete": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/stop": { params: WorkbenchThreadStopSchema, result: ok },
  "thread/interrupt": { params: WorkbenchThreadInterruptSchema, result: ok },
  "thread/steer/resend": { params: WorkbenchThreadSteerTargetSchema, result: WorkbenchThreadMessageResultSchema },
  "thread/steer/dismiss": { params: WorkbenchThreadSteerTargetSchema, result: ok },
  "thread/shell/stop": { params: WorkbenchThreadShellTargetSchema, result: ok },
  "thread/goal/set": { params: WorkbenchThreadTargetSchema.extend({ objective: WorkbenchThreadGoalObjectiveSchema }), result: goalResult },
  "thread/goal/clear": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/todo/add": {
    params: WorkbenchThreadTargetSchema.extend({ text: WorkbenchThreadTodoTextSchema, required: z.boolean() }),
    result: z.object({ todo: WorkbenchThreadTodoSchema }),
  },
  "thread/todo/remove": { params: WorkbenchThreadTargetSchema.extend({ id: z.number().int().nonnegative() }), result: ok },
  "thread/todo/required/set": {
    params: WorkbenchThreadTargetSchema.extend({ id: z.number().int().nonnegative(), required: z.boolean() }), result: ok,
  },
  "thread/todo/text/set": {
    params: WorkbenchThreadTargetSchema.extend({ id: z.number().int().nonnegative(), text: WorkbenchThreadTodoTextSchema }), result: ok,
  },
  "thread/feedback/addressed/clear": { params: WorkbenchThreadTargetSchema, result: ok },
  "thread/skills/read": { params: WorkbenchThreadTargetSchema, result: skillsResult },
  "thread/skills/deactivate": { params: WorkbenchThreadTargetSchema.extend({ path: z.string().min(1) }), result: skillsResult },
} as const;
export type WorkbenchThreadActionMap = {
  [Method in keyof typeof workbenchThreadActions]: {
    params: z.infer<typeof workbenchThreadActions[Method]["params"]>;
    result: z.infer<typeof workbenchThreadActions[Method]["result"]>;
  };
};
