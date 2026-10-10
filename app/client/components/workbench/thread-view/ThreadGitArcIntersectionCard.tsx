/*
 * Exports:
 * - default ThreadGitArcIntersectionCard: render plan, wait, or stashed-claim intersections with sibling threads.
 */
"use client";

import {
  type WorkbenchHarnessId,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import Disclosure from "../../ui/Disclosure";
import { GitArcConflictIcon, GitArcWaitIcon } from "./GitArcIcon";
import WorkbenchThreadReferenceList from "../WorkbenchThreadReferenceList";
import { useThreadClaimIntersections } from "../use-workbench-client";

function formatThreadCount(count: number, state: "active" | "snoozed") {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

export default function ThreadGitArcIntersectionCard({
  harness,
  mode = "plan",
  onOpenThread,
  presentation = "full",
  threadId,
}: {
  harness: WorkbenchHarnessId;
  mode?: "plan" | "wait" | "stashed";
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  presentation?: "compact" | "full";
  projectId: string;
  threadId: string;
}) {
  const scope = mode === "stashed" ? "stashed" : "plan";
  const { intersections, logicalProjectId, ownerProjectId } = useThreadClaimIntersections(threadId, harness, scope);
  if (!intersections.hasScope || !ownerProjectId) return null;
  const waiting = mode === "wait";
  const stashed = mode === "stashed";
  const compact = presentation === "compact" || waiting || stashed;
  const activeThreadCount = intersections.activeEntries.length;
  const plannedThreadCount = intersections.plannedEntries.length;
  const visibleThreadCount = activeThreadCount + (compact ? 0 : plannedThreadCount);
  const snoozedPlannedThreadCount = intersections.plannedEntries.filter(({ entry }) => entry.metadata.snoozed).length;
  const activePlannedThreadCount = plannedThreadCount - snoozedPlannedThreadCount;
  const plannedThreadSummary = [
    activePlannedThreadCount ? formatThreadCount(activePlannedThreadCount, "active") : null,
    snoozedPlannedThreadCount ? formatThreadCount(snoozedPlannedThreadCount, "snoozed") : null,
  ].filter(Boolean).join(" and ");
  const references = (entries: typeof intersections.activeEntries, withPaths: boolean) => entries.map(({ entry, paths }) => ({
    entry, identity: entry.identity, projectId: ownerProjectId,
    logicalProjectId, title: entry.title, paths: withPaths ? paths : [],
  }));

  return (
    <section
      className="my-2 w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2"
      data-thread-git-arc-intersection-card={mode}
      data-thread-plan-conflict-card={mode === "plan" ? "true" : undefined}
    >
      <h2 className={`m-0 flex min-w-0 items-center gap-2 px-3 pt-2 text-[0.82em] leading-[1.45]${visibleThreadCount ? "" : " pb-2"}`}>
        {waiting ? <GitArcWaitIcon className="shrink-0" size={16} /> : <GitArcConflictIcon className="shrink-0" size={16} />}
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {waiting
            ? "Waiting for Git arc claims"
            : stashed
              ? activeThreadCount ? "Stashed claims overlap active threads" : "No active work intersects stashed claims."
              : activeThreadCount ? "Planned changes overlap active threads" : "No active work intersects this plan."}
        </span>
      </h2>
      <WorkbenchThreadReferenceList references={references(intersections.activeEntries, !stashed)} onOpenThread={onOpenThread} />
      {!waiting && !compact && plannedThreadCount ? (
        <Disclosure
          contentClassName="pb-1"
          summary={`Also intersecting planned work in ${plannedThreadSummary}`}
          summaryClassName="px-3 py-2 text-[0.78em] font-medium leading-[1.45]"
        >
          <WorkbenchThreadReferenceList references={references(intersections.plannedEntries, true)} onOpenThread={onOpenThread} />
        </Disclosure>
      ) : null}
    </section>
  );
}
