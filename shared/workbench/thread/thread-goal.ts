/*
 * Exports:
 * - WORKBENCH_THREAD_GOAL_MAX_LENGTH: longest accepted goal objective.
 * - WorkbenchThreadGoalSchema/WorkbenchThreadGoal: a thread's user-set Workbench goal.
 * - WorkbenchThreadGoalObjectiveSchema: one accepted objective.
 * - createWorkbenchGoalSetText: silent notice that the user set or changed the goal.
 * - createWorkbenchGoalClearedText: silent notice that the user cleared the goal.
 * - createWorkbenchGoalReminderText: re-send the current goal after context compaction.
 */
import { z } from "zod";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const WORKBENCH_THREAD_GOAL_MAX_LENGTH = 4_000;

export const WorkbenchThreadGoalObjectiveSchema = z.string().trim().min(1).max(WORKBENCH_THREAD_GOAL_MAX_LENGTH);
export const WorkbenchThreadGoalSchema = z.object({
  objective: WorkbenchThreadGoalObjectiveSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type WorkbenchThreadGoal = z.infer<typeof WorkbenchThreadGoalSchema>;

const GOAL_UPDATED_TAG_WRAPPER = defineTagWrapper("wb:goal-updated", { attributes: [] });
const GOAL_CLEARED_TAG_WRAPPER = defineTagWrapper("wb:goal-cleared", { attributes: [] });
const GOAL_TAG_WRAPPER = defineTagWrapper("wb:goal", { attributes: [] });

const SILENT = "Do not acknowledge this notice visibly; keep working.";

export function createWorkbenchGoalSetText(objective: string) {
  return GOAL_UPDATED_TAG_WRAPPER.wrap(`The user set this thread's goal. Work toward it. ${SILENT}\n\n${objective.trim()}`, {});
}

export function createWorkbenchGoalClearedText() {
  return GOAL_CLEARED_TAG_WRAPPER.wrap(`The user cleared this thread's goal; it no longer applies. ${SILENT}`, {});
}

export function createWorkbenchGoalReminderText(objective: string) {
  return GOAL_TAG_WRAPPER.wrap(`This thread's goal, set by the user. Keep working toward it.\n\n${objective.trim()}`, {});
}
