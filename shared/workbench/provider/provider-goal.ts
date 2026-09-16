/*
 * Exports:
 * - WorkbenchProviderGoalSchema/WorkbenchProviderGoal: provider-maintained goal display facts.
 * - WorkbenchProviderGoalUpdateSchema/WorkbenchProviderGoalUpdate: explicit goal edits.
 * - WorkbenchProviderGoals: optional provider goal operations using WB thread IDs.
 */
import { z } from "zod";

const goalStatus = z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
export const WorkbenchProviderGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string(),
  status: goalStatus,
  tokenBudget: z.number().nullable(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkbenchProviderGoal = z.infer<typeof WorkbenchProviderGoalSchema>;

export const WorkbenchProviderGoalUpdateSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().nullable().optional(),
  status: goalStatus.nullable().optional(),
  tokenBudget: z.number().nullable().optional(),
});
export type WorkbenchProviderGoalUpdate = z.infer<typeof WorkbenchProviderGoalUpdateSchema>;

export interface WorkbenchProviderGoals {
  read(threadId: string): Promise<WorkbenchProviderGoal | null>;
  update(input: WorkbenchProviderGoalUpdate): Promise<WorkbenchProviderGoal | null>;
  clear(threadId: string): Promise<void>;
}
