/*
 * Exports:
 * - ThreadReferenceSelection: the thread-owned references (todos, addressed feedback) picked for the next message and how to change the pick.
 * - default useThreadReferenceSelection: keep one thread's picks, following the published references so removed ones drop out and edited ones stay current.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { composerReferenceKey, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";

export interface ThreadReferenceSelection {
  selected: readonly ComposerReference[];
  isSelected(reference: ComposerReference): boolean;
  toggle(reference: ComposerReference): void;
  deselect(references: readonly ComposerReference[]): void;
}

const NONE: readonly ComposerReference[] = [];

export default function useThreadReferenceSelection(threadId: string, available: readonly ComposerReference[]): ThreadReferenceSelection {
  const [state, setState] = useState<{ threadId: string; keys: ReadonlySet<string> }>({ threadId, keys: new Set() });
  // A pick belongs to one thread; switching threads starts empty.
  const keys = state.threadId === threadId ? state.keys : null;
  const selected = useMemo(() => keys?.size ? available.filter(reference => keys.has(composerReferenceKey(reference))) : NONE, [available, keys]);
  const toggle = useCallback((reference: ComposerReference) => setState(current => {
    const next = new Set(current.threadId === threadId ? current.keys : []);
    const key = composerReferenceKey(reference);
    if (!next.delete(key)) next.add(key);
    return { threadId, keys: next };
  }), [threadId]);
  const deselect = useCallback((removed: readonly ComposerReference[]) => setState(current => {
    if (current.threadId !== threadId) return current;
    const next = new Set(current.keys);
    for (const reference of removed) next.delete(composerReferenceKey(reference));
    return { threadId, keys: next };
  }), [threadId]);
  return useMemo(() => {
    const selectedKeys = new Set(selected.map(composerReferenceKey));
    return { selected, isSelected: reference => selectedKeys.has(composerReferenceKey(reference)), toggle, deselect };
  }, [deselect, selected, toggle]);
}
