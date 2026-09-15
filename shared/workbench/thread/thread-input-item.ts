/*
 * Keywords: user input, optimistic, steer, delivery, metadata.
 * Exports:
 * - WorkbenchInputStateSchema/WorkbenchInputState: explicit input presentation truth.
 * - getWorkbenchInputState: read admitted Workbench input metadata.
 * - withWorkbenchInputState: project an owner's input state without changing item identity.
 */
import { z } from "zod";

import type { ThreadItem } from "./workbench-thread-items.ts";

const delivery = z.enum(["pending", "sent", "failed", "interrupted"]);

export const WorkbenchInputStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("optimistic"), placement: z.enum(["initial", "steer"]), status: delivery }),
  z.object({ kind: z.literal("steer"), status: delivery }),
]);

export type WorkbenchInputState = z.infer<typeof WorkbenchInputStateSchema>;

type UserMessage = Extract<ThreadItem, { type: "userMessage" }>;
type WorkbenchInputItem = UserMessage & { workbenchInput?: WorkbenchInputState };

export function getWorkbenchInputState(item: ThreadItem): WorkbenchInputState | null {
  return item.type === "userMessage" ? (item as WorkbenchInputItem).workbenchInput ?? null : null;
}

export function withWorkbenchInputState<Item extends UserMessage>(item: Item, state: WorkbenchInputState): Item {
  return { ...item, workbenchInput: state };
}
