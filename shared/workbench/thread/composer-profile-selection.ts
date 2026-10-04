/*
 * Exports:
 * - WorkbenchComposerSettingsSchema/WorkbenchComposerSettingsState: strict applied composer settings contract.
 * - WorkbenchComposerProfileSelectionSchema/WorkbenchComposerProfileSelectionState: strict selected profile contract.
 */
import { z } from "zod";
import type { WorkbenchComposerProfileTargetSelection, WorkbenchComposerSettings } from "../../types.ts";
import { ProviderKeySchema as WorkbenchHarnessSchema } from "../provider/provider-key.ts";

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

export const WorkbenchComposerProfileSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom"), settings: WorkbenchComposerSettingsSchema }).strict(),
  z.object({ kind: z.literal("profile"), profileId: z.string().trim().min(1), settings: WorkbenchComposerSettingsSchema }).strict(),
]) as z.ZodType<WorkbenchComposerProfileTargetSelection>;
export type WorkbenchComposerProfileSelectionState = WorkbenchComposerProfileTargetSelection;
