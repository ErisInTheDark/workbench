/*
 * Exports:
 * - default ThreadPlanConflictCard: subscribe to and render full or compact sibling work intersecting the current inactive plan. Keywords: thread, plan, claim, intersection, sidebar, tooltip.
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { WorkbenchThreadSidebarStore } from "../../../lib/types";
import {
  createWorkbenchThreadPlanIntersectionSelector,
  type WorkbenchHarnessId,
  type WorkbenchThreadTarget,
} from "../../../lib/workbench/thread/thread-state";
import ThreadDisclosure from "./ThreadDisclosure";
import { GitArcConflictIcon } from "./GitArcIcon";
import ThreadGitArcConflictList from "./ThreadGitArcConflictList";

const EMPTY_UNSUBSCRIBE = () => undefined;

function formatThreadCount(count: number, state: "active" | "snoozed") {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

export default function ThreadPlanConflictCard({
  harness,
  onOpenThread,
  presentation = "full",
  projectId,
  store,
  threadId,
}: {
  harness: WorkbenchHarnessId;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  presentation?: "compact" | "full";
  projectId: string;
  store: WorkbenchThreadSidebarStore | null;
  threadId: string;
}) {
  const selector = useMemo(() => createWorkbenchThreadPlanIntersectionSelector({ harness, threadId }), [harness, threadId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE, [store]);
  const getSelection = useCallback(() => selector(store?.getSnapshot() ?? null), [selector, store]);
  const intersections = useSyncExternalStore(subscribe, getSelection, getSelection);
  if (!intersections.hasPlannedClaims) return null;
  const compact = presentation === "compact";
  const activeThreadCount = intersections.activeEntries.length;
  const plannedThreadCount = intersections.plannedEntries.length;
  const visibleThreadCount = activeThreadCount + (compact ? 0 : plannedThreadCount);
  const snoozedPlannedThreadCount = intersections.plannedEntries.filter((entry) => entry.metadata.snoozed).length;
  const activePlannedThreadCount = plannedThreadCount - snoozedPlannedThreadCount;
  const plannedThreadSummary = [
    activePlannedThreadCount ? formatThreadCount(activePlannedThreadCount, "active") : null,
    snoozedPlannedThreadCount ? formatThreadCount(snoozedPlannedThreadCount, "snoozed") : null,
  ].filter(Boolean).join(" and ");

  return (
    <section
      className="my-2 w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]"
      data-thread-plan-conflict-card="true"
    >
      <h2 className={`m-0 flex min-w-0 items-center gap-2 px-3 pt-2 text-[0.82em] leading-[1.45]${visibleThreadCount ? "" : " pb-2"}`}>
        <GitArcConflictIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {activeThreadCount ? "Planned changes overlap active threads" : "No active work intersects this plan."}
        </span>
      </h2>
      <ThreadGitArcConflictList entries={intersections.activeEntries} onOpenThread={onOpenThread} projectId={projectId} />
      {!compact && plannedThreadCount ? (
        <ThreadDisclosure
          contentClassName="pb-1"
          summary={`Also intersecting planned work in ${plannedThreadSummary}`}
          summaryClassName="px-3 py-2 text-[0.78em] font-medium leading-[1.45]"
        >
          <ThreadGitArcConflictList entries={intersections.plannedEntries} onOpenThread={onOpenThread} projectId={projectId} />
        </ThreadDisclosure>
      ) : null}
    </section>
  );
}
