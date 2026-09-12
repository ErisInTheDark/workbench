/*
 * Exports:
 * - default ThreadGitArcIntersectionCard: subscribe to and render plan intersections or active claimants blocking a Git arc wait.
 */
"use client";

import { useMemo } from "react";

import {
  createWorkbenchThreadPlanIntersectionSelector,
  type WorkbenchHarnessId,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import ThreadDisclosure from "./ThreadDisclosure";
import { GitArcConflictIcon, GitArcWaitIcon } from "./GitArcIcon";
import ThreadGitArcConflictList from "./ThreadGitArcConflictList";
import { useWorkbenchProjectThreadSidebar } from "../use-workbench-client";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

function formatThreadCount(count: number, state: "active" | "snoozed") {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

export default function ThreadGitArcIntersectionCard({
  harness,
  mode = "plan",
  onOpenThread,
  presentation = "full",
  projectId,
  threadId,
}: {
  harness: WorkbenchHarnessId;
  mode?: "plan" | "wait";
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  presentation?: "compact" | "full";
  projectId: string;
  threadId: string;
}) {
  const selector = useMemo(() => createWorkbenchThreadPlanIntersectionSelector({ harness, threadId }), [harness, threadId]);
  const projectSidebar = useWorkbenchProjectThreadSidebar(projectId ? ProjectIdSchema.parse(projectId) : "");
  const intersections = useMemo(() => selector(projectSidebar), [projectSidebar, selector]);
  if (!intersections.hasPlannedClaims) return null;
  const waiting = mode === "wait";
  const compact = presentation === "compact" || waiting;
  const activeThreadCount = intersections.activeEntries.length;
  const plannedThreadCount = intersections.plannedEntries.length;
  const visibleThreadCount = activeThreadCount + (compact ? 0 : plannedThreadCount);
  const snoozedPlannedThreadCount = intersections.plannedEntries.filter(({ entry }) => entry.metadata.snoozed).length;
  const activePlannedThreadCount = plannedThreadCount - snoozedPlannedThreadCount;
  const plannedThreadSummary = [
    activePlannedThreadCount ? formatThreadCount(activePlannedThreadCount, "active") : null,
    snoozedPlannedThreadCount ? formatThreadCount(snoozedPlannedThreadCount, "snoozed") : null,
  ].filter(Boolean).join(" and ");

  return (
    <section
      className="my-2 w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]"
      data-thread-git-arc-intersection-card={mode}
      data-thread-plan-conflict-card={waiting ? undefined : "true"}
    >
      <h2 className={`m-0 flex min-w-0 items-center gap-2 px-3 pt-2 text-[0.82em] leading-[1.45]${visibleThreadCount ? "" : " pb-2"}`}>
        {waiting ? <GitArcWaitIcon className="shrink-0" size={16} /> : <GitArcConflictIcon className="shrink-0" size={16} />}
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {waiting
            ? "Waiting for Git arc claims"
            : activeThreadCount ? "Planned changes overlap active threads" : "No active work intersects this plan."}
        </span>
      </h2>
      <ThreadGitArcConflictList entries={intersections.activeEntries} onOpenThread={onOpenThread} projectId={projectId} />
      {!waiting && !compact && plannedThreadCount ? (
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
