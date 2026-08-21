/*
 * Exports:
 * - default ThreadPlanConflictCard: subscribe to and render collapsed sibling threads whose live claims overlap the current inactive plan. Keywords: thread, plan, claim, conflict, sidebar.
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { WorkbenchThreadSidebarStore } from "../../../lib/types";
import { createThreadHref } from "../../../lib/workbench/navigation/workbench-route";
import {
  createWorkbenchThreadPlanConflictSelector,
  type WorkbenchHarnessId,
  type WorkbenchThreadTarget,
} from "../../../lib/workbench/thread/thread-state";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import { GitArcConflictIcon } from "./GitArcIcon";

const EMPTY_UNSUBSCRIBE = () => undefined;

export default function ThreadPlanConflictCard({
  harness,
  onOpenThread,
  projectId,
  store,
  threadId,
}: {
  harness: WorkbenchHarnessId;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectId: string;
  store: WorkbenchThreadSidebarStore | null;
  threadId: string;
}) {
  const selector = useMemo(() => createWorkbenchThreadPlanConflictSelector({ harness, threadId }), [harness, threadId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE, [store]);
  const getSelection = useCallback(() => selector(store?.getSnapshot() ?? null), [selector, store]);
  const conflicts = useSyncExternalStore(subscribe, getSelection, getSelection);
  if (!conflicts.length) return null;

  return (
    <section className="my-2 w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]" data-thread-plan-conflict-card="true">
      <h2 className="m-0 flex min-w-0 items-center gap-2 px-3 pt-2 text-[0.82em] leading-[1.45]">
        <GitArcConflictIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-text">Planned changes overlap active threads</span>
      </h2>
      <ul className="m-0 flex flex-col gap-1 p-2">
        {conflicts.map((entry) => (
          <WorkbenchThreadListItem
            className="pb-px"
            compact
            entry={entry}
            href={createThreadHref(projectId, { harness: entry.identity.harness, kind: "provider", threadId: entry.identity.threadId })}
            key={`${entry.identity.harness}:${entry.identity.threadId}`}
            onActivate={onOpenThread}
            projectId={projectId}
            showTooltip={false}
          />
        ))}
      </ul>
    </section>
  );
}
