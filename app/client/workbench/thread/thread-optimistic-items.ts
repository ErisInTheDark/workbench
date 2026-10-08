/*
 * Exports:
 * - OptimisticInputPlacement/OptimisticInputStatus: optimistic user-input rendering state.
 * - isPendingInitialOptimisticInputItem: derive pre-admission connecting state from optimistic item truth.
 * - isUndeliveredInitialOptimisticInputItem: detect visible initial input awaiting canonical transcript delivery.
 * - createOptimisticItem: the visible user-message item for one optimistic input.
 */

import type { ThreadItem, UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getWorkbenchInputState, withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

export type OptimisticInputPlacement = "initial" | "steer";
export type OptimisticInputStatus = "pending" | "sent" | "failed" | "interrupted";

function cloneUserInput(input: UserInput): UserInput {
  switch (input.type) {
    case "text":
      return { text: input.text, text_elements: input.text_elements.map((element) => ({ byteRange: { ...element.byteRange }, placeholder: element.placeholder })), type: input.type };
    case "image":
      return { type: input.type, url: input.url };
    case "localImage":
      return { path: input.path, type: input.type };
    case "skill":
      return { name: input.name, path: input.path, type: input.type };
    case "mention":
      return { name: input.name, path: input.path, type: input.type };
  }
  throw new Error("Unsupported optimistic user input.");
}

export function isPendingInitialOptimisticInputItem(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return input?.kind === "optimistic" && input.placement === "initial" && input.status === "pending";
}

export function isUndeliveredInitialOptimisticInputItem(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return input?.kind === "optimistic"
    && input.placement === "initial"
    && (input.status === "pending" || input.status === "sent");
}

export function createOptimisticItem(entry: {
  clientUserMessageId: string | null;
  handle: string;
  input: readonly UserInput[];
  placement: OptimisticInputPlacement;
  status: OptimisticInputStatus;
}): UserMessageItem {
  return withWorkbenchInputState({
    clientId: entry.clientUserMessageId,
    content: entry.input.map(cloneUserInput),
    id: entry.handle,
    type: "userMessage",
  }, { kind: "optimistic", placement: entry.placement, status: entry.status });
}
