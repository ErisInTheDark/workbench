/*
 * Exports:
 * - ThreadTodoSelection: the todos picked for the next message and how to change the pick.
 * - default useThreadTodoSelection: keep one thread's picked todos, following the published list so removed todos drop out.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";

export interface ThreadTodoSelection {
  selected: readonly WorkbenchThreadTodo[];
  isSelected(id: number): boolean;
  toggle(id: number): void;
  deselect(ids: readonly number[]): void;
}

const NO_TODOS: readonly WorkbenchThreadTodo[] = [];

export default function useThreadTodoSelection(threadId: string, todos: readonly WorkbenchThreadTodo[] = NO_TODOS): ThreadTodoSelection {
  const [state, setState] = useState<{ threadId: string; ids: ReadonlySet<number> }>({ threadId, ids: new Set() });
  // A pick belongs to one thread; switching threads starts empty.
  const ids = state.threadId === threadId ? state.ids : null;
  const selected = useMemo(() => ids?.size ? todos.filter(todo => ids.has(todo.id)) : NO_TODOS, [ids, todos]);
  const toggle = useCallback((id: number) => setState(current => {
    const next = new Set(current.threadId === threadId ? current.ids : []);
    if (!next.delete(id)) next.add(id);
    return { threadId, ids: next };
  }), [threadId]);
  const deselect = useCallback((removed: readonly number[]) => setState(current => {
    if (current.threadId !== threadId) return current;
    const next = new Set(current.ids);
    for (const id of removed) next.delete(id);
    return { threadId, ids: next };
  }), [threadId]);
  return useMemo(() => ({
    selected, isSelected: (id: number) => selected.some(todo => todo.id === id), toggle, deselect,
  }), [deselect, selected, toggle]);
}
