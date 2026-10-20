/*
 * Exports:
 * - ThreadTodoControls: the viewed thread's live todos, their pick for the next message, and how to change them.
 * - ThreadTodoControlsContext: provided by the thread view, so todo cards in its transcript act on the real list; null elsewhere.
 */
"use client";

import { createContext } from "react";

import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import type { ThreadReferenceSelection } from "./use-thread-reference-selection";

export interface ThreadTodoControls {
  todos: readonly WorkbenchThreadTodo[];
  selection: ThreadReferenceSelection;
  remove(id: number): Promise<void>;
  setRequired(id: number, required: boolean): Promise<void>;
  setText(id: number, text: string): Promise<void>;
}

export const ThreadTodoControlsContext = createContext<ThreadTodoControls | null>(null);
