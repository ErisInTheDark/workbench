/*
 * Exports:
 * - ApprovalReviewSettingsSnapshotSchema/ApprovalReviewSettingsSnapshot: selected reviewer and per-reviewer credential readiness.
 * - ApprovalReviewSettingsUpdateSchema/ApprovalReviewSettingsUpdate: reviewer selection and Workbench-held secret changes.
 * - ApprovalReviewVerdict: normalized reviewer outcome used by approval policy.
 */
import { z } from "zod";
import { ApprovalReviewerIdSchema } from "./approval-reviewers.ts";

const reviewer = z.object({
  id: ApprovalReviewerIdSchema,
  /** Whether the reviewer has a usable credential right now. */
  ready: z.boolean(),
  /** Short credential status shown under the reviewer. */
  detail: z.string().max(300),
  /** Decrypted Workbench-held secret, only for `workbench-secret` reviewers; null when unset. */
  secret: z.string().nullable().optional(),
}).strict();

export const ApprovalReviewSettingsSnapshotSchema = z.object({
  selected: ApprovalReviewerIdSchema.nullable(),
  reviewers: z.array(reviewer),
}).strict();
export type ApprovalReviewSettingsSnapshot = z.infer<typeof ApprovalReviewSettingsSnapshotSchema>;

export const ApprovalReviewSettingsUpdateSchema = z.object({
  selected: ApprovalReviewerIdSchema.nullable().optional(),
  /** Set (string) or clear (null) Workbench-held secrets by reviewer id. */
  secrets: z.partialRecord(ApprovalReviewerIdSchema, z.string().trim().min(1).max(4096).nullable()).optional(),
}).strict();
export type ApprovalReviewSettingsUpdate = z.input<typeof ApprovalReviewSettingsUpdateSchema>;

export type ApprovalReviewVerdict =
  | { decision: "allow"; detail: string }
  | { decision: "manual"; detail: string };
