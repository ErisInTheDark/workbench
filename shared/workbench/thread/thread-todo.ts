/*
 * Exports:
 * - WORKBENCH_THREAD_TODO_MAX_LENGTH: longest accepted todo text.
 * - WorkbenchThreadTodoTextSchema: one accepted todo text.
 * - WorkbenchThreadTodoSchema/WorkbenchThreadTodo: one follow-up recorded on a thread by its agent or user.
 * - workbenchThreadTodoReference: the composer reference that hands a todo to the agent.
 */
import { z } from "zod";
import type { ComposerReference } from "./composer-reference.ts";

export const WORKBENCH_THREAD_TODO_MAX_LENGTH = 4_000;

export const WorkbenchThreadTodoTextSchema = z.string().trim().min(1).max(WORKBENCH_THREAD_TODO_MAX_LENGTH);
export const WorkbenchThreadTodoSchema = z.object({
  /** The todo's serial within its thread (#1, #2…); only unique together with the thread. */
  id: z.number().int().nonnegative(),
  text: WorkbenchThreadTodoTextSchema,
  required: z.boolean(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type WorkbenchThreadTodo = z.infer<typeof WorkbenchThreadTodoSchema>;

export function workbenchThreadTodoReference(todo: WorkbenchThreadTodo): Extract<ComposerReference, { kind: "todo" }> {
  return { kind: "todo", id: todo.id, required: todo.required, createdAt: todo.createdAt, text: todo.text };
}
