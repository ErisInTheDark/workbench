/*
 * Exports:
 * - ThreadComponentStylesContext: the active style owner for one thread view.
 * - default ThreadComponentStyles: load active skill styles and mount one thread-scoped stylesheet.
 */
"use client";

import { createContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import ThreadComponentStylesController from "./thread-component-styles";

export const ThreadComponentStylesContext = createContext<ThreadComponentStylesController | null>(null);

export default function ThreadComponentStyles({ threadId, skills, scope, children }: {
  threadId: string;
  skills: readonly WorkbenchThreadSkill[];
  scope: string;
  children: ReactNode;
}) {
  const daemon = useWorkbenchDaemonClient();
  const owner = useMemo(() => new ThreadComponentStylesController(async signal =>
    (await daemon.threads.components.styles({ threadId: ThreadReferenceSchema.parse(threadId) }, { signal })).styles,
  ), [daemon, threadId]);
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const skillKey = JSON.stringify(skills.map(skill => [skill.path, skill.activatedAt]));
  useLayoutEffect(() => { owner.setSkills(skillKey, skills.length > 0); }, [owner, skillKey, skills.length]);
  useEffect(() => () => owner.dispose(), [owner]);
  const css = [...new Set(state.styles.map(style => style.css))].filter(Boolean).join("\n");
  return <ThreadComponentStylesContext.Provider value={owner}>
    {css ? <style>{`@scope ([data-thread-component-style="${scope}"]) {${css}}`}</style> : null}
    {children}
  </ThreadComponentStylesContext.Provider>;
}
