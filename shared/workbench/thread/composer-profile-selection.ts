/*
 * Exports:
 * - WorkbenchComposerSettingsSchema/WorkbenchComposerSettingsState: strict applied composer settings contract.
 * - WorkbenchComposerProfileSelectionSchema/WorkbenchComposerProfileSelectionState: strict selected profile contract, with the optional approval mode beside it.
 */
import { z } from "zod";
import type { WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings } from "../../types.ts";
import { ProviderKeySchema as WorkbenchHarnessSchema } from "../provider/provider-key.ts";
import { WorkbenchApprovalModeSchema } from "../approval-review/approval-mode.ts";

export const WorkbenchComposerSettingsSchema = z.object({
  contextWindowTokens: z.number().int().positive().nullable().optional(),
  agentPath: z.string().nullable(),
  agentSource: z.enum(["library", "project"]).nullable(),
  harness: WorkbenchHarnessSchema,
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  serviceTier: z.literal("fast").nullable(),
}).strict() as z.ZodType<WorkbenchComposerSettings>;
export type WorkbenchComposerSettingsState = WorkbenchComposerSettings;

// The approval mode rides beside `settings`, never inside it, so stored profiles never capture it.
const approvalMode = WorkbenchApprovalModeSchema.optional();
export const WorkbenchComposerProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom"), settings: WorkbenchComposerSettingsSchema, approvalMode }).strict(),
  z.object({ kind: z.literal("profile"), profileId: z.string().trim().min(1), settings: WorkbenchComposerSettingsSchema, approvalMode }).strict(),
]) as z.ZodType<WorkbenchComposerProfileTargetSelection>;
export type WorkbenchComposerProfileSelectionState = WorkbenchComposerProfileTargetSelection;
