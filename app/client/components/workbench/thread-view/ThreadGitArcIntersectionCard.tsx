/*
 * Exports:
 * - default ThreadGitArcIntersectionCard: render plan, wait, or stashed-claim intersections with sibling threads from supplied intersections.
 * - ObservedThreadGitArcIntersectionCard: observe a thread's claim intersections and render them as the card.
 */
"use client";

import type { LogicalProjectId, ProjectId } from "workbench-shared/workbench/identity";
import {
  type WorkbenchHarnessId,
  type WorkbenchThreadClaimIntersections,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import Disclosure from "../../ui/Disclosure";
import { GitArcUnclaimIcon, GitArcWaitIcon } from "./GitArcIcon";
import WorkbenchThreadReferenceList from "../WorkbenchThreadReferenceList";
import { useThreadClaimIntersections } from "../use-workbench-client";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

type IntersectionMode = "plan" | "wait" | "stashed";

const activeNotice = getThreadMarkdownEmphasisColors("yellow")!;

function formatThreadCount(count: number, state: "active" | "snoozed") {
  return `${count} ${state} ${count === 1 ? "thread" : "threads"}`;
}

export default function ThreadGitArcIntersectionCard({
  chrome = "card",
  intersections,
  logicalProjectId,
  mode = "plan",
  onOpenThread,
  ownerProjectId,
  presentation = "full",
}: {
  /**
   * Flush drops the card frame for hosts that draw their own, such as a status panel section. Notice is flush too,
   * but marks active overlap like a yellow thread notice, for edge-to-edge tooltip sections.
   */
  chrome?: "card" | "flush" | "notice";
  intersections: WorkbenchThreadClaimIntersections;
  logicalProjectId: LogicalProjectId | null;
  mode?: IntersectionMode;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  /** Project owning the observed thread; without one the sibling threads cannot be linked. */
  ownerProjectId?: ProjectId | null;
  presentation?: "compact" | "full";
}) {
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

  // Overlapping live claims is the one state that needs the user before work collides.
  const overlapsActive = !waiting && activeThreadCount > 0;

  const notice = chrome === "notice" && overlapsActive;
  return (
    <section
      className={chrome === "card"
        ? `my-2 w-full overflow-hidden rounded-[0.9rem] border ${overlapsActive
          ? "border-amber-500/35 bg-amber-500/6"
          : "border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2"}`
        : notice
          // Rows inset past the bar, so their hover chrome never meets it.
          ? `relative w-full [&_[data-thread-reference-list]]:px-3 ${activeNotice.background}`
          : `w-full ${chrome === "flush" && overlapsActive ? "bg-amber-500/6" : ""}`}
      data-thread-git-arc-intersection-card={mode}
      data-thread-git-arc-intersection-tone={overlapsActive ? "active" : undefined}
      data-thread-plan-conflict-card={mode === "plan" ? "true" : undefined}
    >
      {notice ? <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[0.22rem] bg-current opacity-60 ${activeNotice.text}`} /> : null}
      <h2 className={`m-0 flex min-w-0 items-center gap-2 px-3 pt-2 text-[0.82em] leading-[1.45]${visibleThreadCount ? "" : " pb-2"}${overlapsActive ? " text-amber-600 dark:text-amber-300" : ""}`}>
        {waiting ? <GitArcWaitIcon className="shrink-0" size={16} /> : <GitArcUnclaimIcon className="shrink-0" size={16} />}
        <span className={`min-w-0 flex-1 truncate font-medium ${overlapsActive ? "" : "text-text"}`}>
          {waiting
            ? "Waiting for Git arc claims"
            : stashed
              ? activeThreadCount ? "Stashed claims overlap active threads" : "No active work intersects stashed claims."
              // Flush and notice hosts announce the overlap themselves, so their heading names the list instead.
              : activeThreadCount ? chrome !== "card" ? "Active threads claiming planned files" : "Planned changes overlap active threads"
                : "No active work intersects this plan."}
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

export function ObservedThreadGitArcIntersectionCard({ harness, mode = "plan", threadId, ...card }: {
  chrome?: "card" | "flush" | "notice";
  harness: WorkbenchHarnessId;
  mode?: IntersectionMode;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  presentation?: "compact" | "full";
  threadId: string;
}) {
  const observed = useThreadClaimIntersections(threadId, harness, mode === "stashed" ? "stashed" : "plan");
  return <ThreadGitArcIntersectionCard {...card} {...observed} mode={mode} />;
}
