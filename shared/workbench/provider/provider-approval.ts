/*
 * Exports:
 * - WorkbenchApprovalSubjectSchema/WorkbenchApprovalSubject: provider-neutral description of one action awaiting approval.
 * - WorkbenchApprovalDecisionSchema/WorkbenchApprovalDecision: Workbench decision a transport carries back to its native request.
 * - WorkbenchApprovalOutcome/WORKBENCH_APPROVAL_OUTCOMES: recorded per-tool-item approval result.
 * - WorkbenchApprovalOutcomeEntry: one recorded outcome bound to a stable transcript item identity.
 */
import { z } from "zod";
import { CommandActionSchema } from "../thread/thread-state.ts";

const text = z.string().max(100_000);

export const WorkbenchApprovalSubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    command: text,
    cwd: text,
    commandActions: z.array(CommandActionSchema),
    justification: text.nullable(),
    networkTarget: text.nullable(),
    /** Whether saved command rules may decide or be offered for this request. */
    rememberable: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal("fileChange"), reason: text.nullable(), grantRoot: text.nullable() }).strict(),
  z.object({ kind: z.literal("permissions"), cwd: text, reason: text.nullable(), permissions: text.nullable() }).strict(),
  z.object({ kind: z.literal("patch"), reason: text.nullable(), grantRoot: text.nullable(), paths: z.array(text) }).strict(),
]);
export type WorkbenchApprovalSubject = z.infer<typeof WorkbenchApprovalSubjectSchema>;

export const WorkbenchApprovalDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["allowOnce", "allowSession"]) }).strict(),
  z.object({ kind: z.literal("decline"), feedback: text.optional() }).strict(),
]);
export type WorkbenchApprovalDecision = z.infer<typeof WorkbenchApprovalDecisionSchema>;

export const WORKBENCH_APPROVAL_OUTCOMES = ["approved", "autoApproved", "denied"] as const;
export type WorkbenchApprovalOutcome = typeof WORKBENCH_APPROVAL_OUTCOMES[number];

export interface WorkbenchApprovalOutcomeEntry {
  threadId: string;
  turnId: string;
  itemId: string;
  outcome: WorkbenchApprovalOutcome;
  resolvedAt: number;
}
