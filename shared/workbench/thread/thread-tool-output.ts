/*
 * Keywords: tool context, native output, acceptance, validation.
 * Exports:
 * - WORKBENCH_TOOL_CONTEXT_METHOD/WorkbenchToolContextRequest: passive-context bridge contract.
 * - WorkbenchToolContextResponseSchema/WorkbenchToolContextResponse: acknowledged queue admission.
 * - WorkbenchToolOutput/SupportedToolOutputPart: supported native output with optional queue-acceptance evidence.
 * - readWorkbenchToolOutput: validate supported persisted/provider output at its boundary.
 * - mergeWorkbenchToolOutput: retain queue acceptance only for matching native evidence.
 * - getWorkbenchToolOutputText: read supported text parts without converting media to text.
 */
import { z } from "zod";
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import type { TurnToolOutput } from "../../codex/generated/app-server/v2/TurnToolOutput.ts";
import type { FunctionCallOutputContentItem } from "../../codex/generated/app-server/FunctionCallOutputContentItem.ts";
import { areDeeplyEqual } from "../deep-equality.ts";

export const WORKBENCH_TOOL_CONTEXT_METHOD = "workbench/thread/inject-tool-context";

export interface WorkbenchToolContextRequest {
  expectedTurnId: string;
  threadId: string;
  toolOutput: TurnToolOutput;
}

export const WorkbenchToolContextResponseSchema = z.object({
  acceptedAt: z.number().int().nonnegative(),
  itemId: z.string().min(1),
  turnId: z.string().min(1),
});
export type WorkbenchToolContextResponse = z.infer<typeof WorkbenchToolContextResponseSchema>;

export type SupportedToolOutputPart = Extract<FunctionCallOutputContentItem, { type: "input_text" | "input_image" }>;
export type WorkbenchToolOutput = Omit<Extract<ThreadItem, { type: "functionCallOutput" }>, "output"> & {
  output: string | SupportedToolOutputPart[];
  workbenchInjectionAcceptedAt?: number;
};

const outputPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({
    type: z.literal("input_image"),
    image_url: z.string().min(1),
    detail: z.enum(["auto", "low", "high", "original"]).optional(),
  }),
]);
const toolOutputSchema = z.object({
  id: z.string().min(1),
  type: z.literal("functionCallOutput"),
  name: z.string().min(1),
  namespace: z.string().nullable().default(null),
  output: z.union([z.string(), z.array(outputPartSchema)]),
  workbenchInjectionAcceptedAt: z.number().int().nonnegative().optional(),
});

export function readWorkbenchToolOutput(value: unknown): WorkbenchToolOutput | null {
  const parsed = toolOutputSchema.safeParse(value);
  if (!parsed.success || parsed.data.output === undefined) return null;
  return { ...parsed.data, output: parsed.data.output };
}

export function mergeWorkbenchToolOutput(
  incoming: Extract<ThreadItem, { type: "functionCallOutput" }>,
  stored: Extract<ThreadItem, { type: "functionCallOutput" }>,
): Extract<ThreadItem, { type: "functionCallOutput" }> & Pick<WorkbenchToolOutput, "workbenchInjectionAcceptedAt"> {
  const previous = stored as WorkbenchToolOutput;
  return incoming.id === stored.id && incoming.name === stored.name && incoming.namespace === stored.namespace
    && previous.workbenchInjectionAcceptedAt !== undefined && areDeeplyEqual(incoming.output, stored.output)
    ? { ...incoming, workbenchInjectionAcceptedAt: (incoming as WorkbenchToolOutput).workbenchInjectionAcceptedAt ?? previous.workbenchInjectionAcceptedAt }
    : incoming;
}

export function getWorkbenchToolOutputText(item: WorkbenchToolOutput) {
  return typeof item.output === "string" ? item.output : item.output
    .flatMap((part) => part.type === "input_text" ? [part.text] : [])
    .join("\n");
}
