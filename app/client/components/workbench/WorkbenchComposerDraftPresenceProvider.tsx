/*
 * Exports:
 * - default WorkbenchComposerDraftPresenceProvider: derive sidebar composer-draft presence from durable client state. Keywords: sidebar, composer, draft, project, thread.
 * - useWorkbenchComposerDraftPresence: report whether one project-qualified thread has unsent composer content. Keywords: sidebar, composer, draft, project, thread.
 * - Local helpers: recognise sendable composer content and collect project-qualified thread ids. Keywords: text, attachment, client state.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";

type ComposerDraftPresence = ReadonlyMap<string, ReadonlySet<string>>;

const emptyComposerDraftPresence: ComposerDraftPresence = new Map();
const WorkbenchComposerDraftPresenceContext = createContext(emptyComposerDraftPresence);

export default function WorkbenchComposerDraftPresenceProvider({ children }: { children: ReactNode }) {
  const clientState = useWorkbenchClientStateSnapshot();
  const presence = useMemo(() => {
    const nextPresence = new Map<string, Set<string>>();
    for (const record of clientState.records) {
      if (
        record.kind !== "composerDraft"
        || record.daemonRegistrationId !== clientState.daemonRegistrationId
        || (!record.value.text.trim() && record.value.attachments.length === 0)
      ) continue;
      const threadIds = nextPresence.get(record.projectId) ?? new Set<string>();
      threadIds.add(record.threadId);
      nextPresence.set(record.projectId, threadIds);
    }
    return nextPresence;
  }, [clientState.daemonRegistrationId, clientState.records]);

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
