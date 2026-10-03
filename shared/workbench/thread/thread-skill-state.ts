/*
 * Exports:
 * - WorkbenchThreadSkillSourceSchema/WorkbenchThreadSkillSource: who activated a thread skill.
 * - WorkbenchThreadSkillSchema/WorkbenchThreadSkill: one active skill recorded for a thread.
 * - collectActivatedSkillPaths: deduped skill paths a submission activates through context and skill parts.
 */
import { z } from "zod";
import type { WorkbenchMessageContext, WorkbenchUserInput } from "../provider/provider-input.ts";
import type { UserInput } from "./workbench-thread-items.ts";

export const WorkbenchThreadSkillSourceSchema = z.enum(["user", "agent"]);
export type WorkbenchThreadSkillSource = z.infer<typeof WorkbenchThreadSkillSourceSchema>;

export const WorkbenchThreadSkillSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  source: WorkbenchThreadSkillSourceSchema,
  activatedAt: z.number().int().nonnegative(),
});
export type WorkbenchThreadSkill = z.infer<typeof WorkbenchThreadSkillSchema>;

export function collectActivatedSkillPaths(
  input: readonly (WorkbenchUserInput | UserInput)[],
  context?: Pick<WorkbenchMessageContext, "activatedSkillPaths">,
): string[] {
  return [...new Set([
    ...(context?.activatedSkillPaths ?? []),
    ...input.flatMap(part => part.type === "skill" ? [part.path] : []),
  ].map(path => path.trim()).filter(Boolean))];
}
