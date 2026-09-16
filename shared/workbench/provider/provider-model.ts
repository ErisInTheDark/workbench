/*
 * Exports:
 * - WorkbenchModelOptionSchema/WorkbenchModelOption: provider-neutral model display and interaction capabilities.
 */
import { z } from "zod";

export const WorkbenchModelOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  supportsPersonality: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportedReasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().nullable(),
  supportsVision: z.boolean(),
  supportsFastMode: z.boolean(),
  inputModalities: z.array(z.string()),
  maxContextWindowTokens: z.number().nullable(),
  contextWindow: z.object({ defaultTokens: z.number(), maximumTokens: z.number() }).nullable().optional(),
  additionalSpeedTiers: z.array(z.string()),
  policyState: z.string().nullable(),
  billingMultiplier: z.number().nullable(),
});
export type WorkbenchModelOption = z.infer<typeof WorkbenchModelOptionSchema>;
