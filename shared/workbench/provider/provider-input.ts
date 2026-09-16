/*
 * Exports:
 * - WorkbenchUserInputSchema/WorkbenchUserInput: submitted content, independent of provider packets.
 * - WorkbenchMessageContextSchema/WorkbenchMessageContext: instruction selections accompanying user intent.
 * - createWorkbenchTextInput: plain text input without annotation spans.
 */
import { z } from "zod";

const imageDetail = z.enum(["auto", "low", "high", "original"]).optional();
export const WorkbenchUserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(z.object({
      byteRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
      placeholder: z.string().nullable(),
    })).default([]),
  }),
  z.object({ type: z.literal("image"), url: z.string(), detail: imageDetail }),
  z.object({ type: z.literal("localImage"), path: z.string(), detail: imageDetail }),
  z.object({ type: z.literal("audio"), url: z.string() }),
  z.object({ type: z.literal("localAudio"), path: z.string() }),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }),
]);
export type WorkbenchUserInput = z.infer<typeof WorkbenchUserInputSchema>;

export function createWorkbenchTextInput(text: string): Extract<WorkbenchUserInput, { type: "text" }> {
  return { type: "text", text, text_elements: [] };
}

export const WorkbenchMessageContextSchema = z.object({
  subagentName: z.string().optional(),
  activatedSkillPaths: z.array(z.string()).optional(),
  instructionInjections: z.record(z.string(), z.string()).optional(),
  instructionScope: z.enum(["full", "threadUtilities"]).optional(),
  workflowIds: z.array(z.string()).optional(),
  workbenchOrigin: z.string().nullable().optional(),
});
export type WorkbenchMessageContext = z.infer<typeof WorkbenchMessageContextSchema>;
