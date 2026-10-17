/*
 * Exports:
 * - WorkbenchUserInputSchema/WorkbenchUserInput: submitted content, independent of provider packets.
 * - WorkbenchMessageContextSchema/WorkbenchMessageContext: instruction selections accompanying user intent.
 * - WorkbenchInstructionSelectionSchema/WorkbenchInstructionSelection: a thread's durable instruction choices, without per-message skills.
 * - readWorkbenchInstructionSelection: the selection a message context carries, or null when it carries none.
 * - createWorkbenchTextInput: plain text input without annotation spans.
 * - toWorkbenchThreadUserInput: normalise submitted text annotations for canonical thread content.
 */
import { z } from "zod";
import type { UserInput } from "../thread/workbench-thread-items.ts";

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

export function toWorkbenchThreadUserInput(parts: readonly WorkbenchUserInput[]): UserInput[] {
  return parts.map(part => part.type === "text" ? {
    ...part, text_elements: part.text_elements.map(element => ({
      ...element, placeholder: element.placeholder ?? "",
    })),
  } : part);
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

export const WorkbenchInstructionSelectionSchema = WorkbenchMessageContextSchema.omit({ activatedSkillPaths: true });
export type WorkbenchInstructionSelection = z.infer<typeof WorkbenchInstructionSelectionSchema>;

/** Skills alone are per-message; any selection field, even an empty workflow list, is a deliberate choice. */
export function readWorkbenchInstructionSelection(context: WorkbenchMessageContext | undefined): WorkbenchInstructionSelection | null {
  if (!context) return null;
  const { activatedSkillPaths: _skills, ...rest } = context;
  const selection = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return Object.keys(selection).length ? WorkbenchInstructionSelectionSchema.parse(selection) : null;
}
