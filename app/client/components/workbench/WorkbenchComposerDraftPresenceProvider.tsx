/*
 * Exports:
 * - default WorkbenchComposerDraftPresenceProvider: derive sidebar composer-draft presence from durable client state. Keywords: sidebar, composer, draft, project, thread.
 * - useWorkbenchComposerDraftPresence: report whether one project-qualified thread has unsent composer content. Keywords: sidebar, composer, draft, project, thread.
 * - Local helpers: recognise sendable composer content and collect project-qualified thread ids. Keywords: text, attachment, client state.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useWorkbenchClientState } from "./workbench-client-state-context";

type ComposerDraftPresence = ReadonlyMap<string, ReadonlySet<string>>;

const emptyComposerDraftPresence: ComposerDraftPresence = new Map();
const WorkbenchComposerDraftPresenceContext = createContext(emptyComposerDraftPresence);

export default function WorkbenchComposerDraftPresenceProvider({ children }: { children: ReactNode }) {
  // Only which threads have content counts, so typing in a draft that already has some changes nothing here.
  const drafted = useWorkbenchClientState(state => state.records.flatMap(record => record.kind === "composerDraft"
    && record.daemonRegistrationId === state.daemonRegistrationId
    && (record.value.text.trim() || record.value.attachments.length) ? [[record.projectId, record.threadId] as const] : []));
  const presence = useMemo(() => {
    const nextPresence = new Map<string, Set<string>>();
    for (const [projectId, threadId] of drafted) {
      const threadIds = nextPresence.get(projectId) ?? new Set<string>();
      threadIds.add(threadId);
      nextPresence.set(projectId, threadIds);
    }
    return nextPresence;
  }, [drafted]);

  return (
    <WorkbenchComposerDraftPresenceContext.Provider value={presence}>
      {children}
    </WorkbenchComposerDraftPresenceContext.Provider>
  );
}

export function useWorkbenchComposerDraftPresence(projectId: string, threadId: string | null) {
  const presence = useContext(WorkbenchComposerDraftPresenceContext);
  return Boolean(threadId && presence.get(projectId)?.has(threadId));
}
