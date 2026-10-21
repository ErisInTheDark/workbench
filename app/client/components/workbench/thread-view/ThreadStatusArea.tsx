/*
 * Exports:
 * - getThreadStatusAttention: the panel an idle thread opens by itself: pending proposals, then required todos or addressed feedback, then dirty claims.
 * - default ThreadStatusArea: compose a thread's status row from its live activity, skills, live vis, Git arc work
 *   (claim intersections, proposals, claims, stash, accepted commits) and goal/todos with addressed feedback.
 */
"use client";

import type { ReactNode } from "react";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { VisLiveSession } from "workbench-shared/workbench/vis/vis-contract";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import {
  isWorkbenchThreadStatusProviderOwned,
  type WorkbenchHarnessId,
  type WorkbenchThreadGitCommitHistory,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import LoaderIcon from "../LoaderIcon";
import Tooltip from "../../ui/Tooltip";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";
import { useThread } from "../use-thread";
import {
  CheckCheckIcon, ClipboardListIcon, FlagFilledIcon, FlagIcon, GitArcIcon, GitArcProposalIcon, MegaphoneIcon, SlashIcon,
  WallpaperIcon,
} from "../workbench-icons";
import { GitArcClaimIcon, GitArcUnclaimIcon } from "./GitArcIcon";
import ThreadGitArcIntersectionCard from "./ThreadGitArcIntersectionCard";
import ThreadSkillPills, { skillPillToneClassName } from "./ThreadSkillPills";
import ThreadStatusRow, { threadStatusSegmentClassName, type ThreadStatusAttention, type ThreadStatusPanel } from "./ThreadStatusRow";
import ThreadVisSessionCard, { getVisSessionsUpdatedAt } from "./ThreadVisSessionCard";
import ThreadGitArcWork, { type ThreadGitArcWorkProps } from "./ThreadGitArcWork";
import { countThreadAcceptedGitCommits } from "./ThreadGitArcProposalList";
import { useThreadGitArcClaimChanges } from "./ThreadGitArcObservationContext";
import { getGitArcClaimReleaseAction } from "./ThreadGitArcPresentationContext";
import type { ThreadLiveActivityView } from "./use-thread-live-activity";
import { FEEDBACK_TEXT_TONE_CLASS_NAME } from "../feedback-presentation";

const amberClassName = "text-amber-600 dark:text-amber-300";

function count(value: number) {
  return <span>{value}</span>;
}

/** First match wins; each target's key changes when its work does, so new work reopens a panel the user closed. */
export function getThreadStatusAttention({ dirtyClaimedPaths, feedbackCount, pendingProposalIds, requiredTodoCount }: {
  /** Null while dirtiness is unknown or the claims are clean. */
  dirtyClaimedPaths: readonly string[] | null;
  feedbackCount: number;
  pendingProposalIds: readonly string[];
  requiredTodoCount: number;
}): ThreadStatusAttention | null {
  if (pendingProposalIds.length) return { key: `proposals:${pendingProposalIds.join("\0")}`, panel: "arc" };
  if (requiredTodoCount || feedbackCount) return { key: `todos:${requiredTodoCount}:${feedbackCount}`, panel: "todos" };
  if (dirtyClaimedPaths?.length) return { key: `claims:${dirtyClaimedPaths.join("\0")}`, panel: "arc" };
  return null;
}

export default function ThreadStatusArea({
  gitArc,
  gitCommitHistory,
  harness,
  live,
  skills,
  threadId,
  threadLifecycle,
  todos,
  vis,
}: {
  gitArc: Omit<ThreadGitArcWorkProps, "threadId"> | null;
  gitCommitHistory?: WorkbenchThreadGitCommitHistory;
  harness: WorkbenchHarnessId;
  live: ThreadLiveActivityView | null;
  /** Absent where a thread has no skills to manage, such as draft views. */
  skills: { onDeactivate: (path: string) => Promise<void>; skills: readonly WorkbenchThreadSkill[] } | null;
  threadId: string;
  threadLifecycle: WorkbenchThreadLifecycle | null;
  /** Absent where a thread has no goal or todos to manage; the panel also lists the feedback the thread addresses. */
  todos: { count: number; feedbackCount: number; goalSet: boolean; renderPanel(): ReactNode } | null;
  vis: { onControl: (sessionId: string, controlId: string, value: string) => Promise<void>; onEnd: (sessionId: string) => void; sessions: readonly VisLiveSession[] } | null;
}) {
  const { intersections, logicalProjectId, ownerProjectId } = useThread.claimIntersections(threadId, harness, "plan");
  const overlapCount = intersections.hasScope ? intersections.activeEntries.length : 0;
  const plannedOverlapCount = intersections.hasScope ? intersections.plannedEntries.length : 0;
  const showPlanIntersectionStatus = !live && intersections.hasScope;
  const claim = gitArc?.claim ?? null;
  const proposals = claim?.proposals.filter(({ status }) => status === "proposed") ?? [];
  const accepted = countThreadAcceptedGitCommits(claim?.proposals ?? [], gitCommitHistory);
  const claimed = claim?.claimedPaths.length ?? 0;
  const stashed = claim?.stashedPaths?.length ?? 0;
  const feedbackCount = todos?.feedbackCount ?? 0;
  // Once the work is done, unhandled feedback is what holds settlement.
  const highlightFeedback = threadLifecycle?.kind === "completed" || threadLifecycle?.kind === "stopped";

  // A turn still running or waiting on the user's answer is busy; an unknown lifecycle is too, so loading never flashes a panel open.
  const busy = !threadLifecycle || isWorkbenchThreadStatusProviderOwned(threadLifecycle);
  const facts = useThread.summary(WorkbenchThreadIdSchema.safeParse(threadId).data ?? null)?.summary.facts;
  const requiredTodoCount = facts?.requiredTodoCount ?? 0;
  // Dirtiness costs a Git comparison, so it is only asked for when it could decide the target.
  const comparesClaims = !busy && !proposals.length && !requiredTodoCount && !feedbackCount
    && (claim?.phase ?? "active") === "active" && claimed > 0;
  const claimChanges = useThreadGitArcClaimChanges(comparesClaims)?.state;
  const claimsDirty = claimChanges?.status === "loaded"
    && getGitArcClaimReleaseAction(claimChanges.changeCount, claimChanges.hasUncommittedChanges) === "restore";
  const attention = getThreadStatusAttention({
    dirtyClaimedPaths: claimsDirty ? claim?.claimedPaths ?? null : null,
    feedbackCount,
    pendingProposalIds: proposals.map(({ proposalId }) => proposalId),
    requiredTodoCount,
  });

  const arcSegments: ThreadStatusPanel["segments"][number][] = [
    ...(overlapCount || plannedOverlapCount ? [{
      key: "overlap",
      ...(overlapCount ? { className: `${threadStatusSegmentClassName} ${amberClassName}` } : {}),
      content: <><GitArcUnclaimIcon size={14} />{count(overlapCount || plannedOverlapCount)}</>,
    }] : []),
    ...(proposals.length ? [{ key: "proposals", content: <><GitArcProposalIcon size={14} />{count(proposals.length)}</> }] : []),
    ...(claimed ? [{ key: "claims", content: <><GitArcClaimIcon size={14} />{count(claimed)}</> }] : []),
    ...(stashed ? [{ key: "stash", content: <><GitArcIcon action="stash" size={14} />{count(stashed)}</> }] : []),
  ];
  if (!arcSegments.length && accepted) {
    arcSegments.push({ key: "accepted", content: <><CheckCheckIcon size={14} />{count(accepted)}</> });
  }
  const showIntersections = intersections.hasScope && Boolean(overlapCount || plannedOverlapCount);
  const arcLabel = [
    overlapCount ? `${overlapCount} overlapping active threads` : plannedOverlapCount ? `${plannedOverlapCount} overlapping planned threads` : null,
    proposals.length ? `${proposals.length} proposals` : null,
    claimed ? `${claimed} claimed files` : null,
    stashed ? `${stashed} stashed files` : null,
    accepted && !proposals.length ? `${accepted} accepted commits` : null,
  ].filter(Boolean).join(", ") || "Git arc work";

  const visUpdatedAt = vis ? getVisSessionsUpdatedAt(vis.sessions) : 0;
  const visRendering = vis?.sessions.some(({ rendering }) => rendering) ?? false;

  const panels: ThreadStatusPanel[] = [
    ...(skills?.skills.length ? [{
      id: "skills",
      label: `${skills.skills.length} active skills`,
      narrowOnly: true,
      pressedClassName: skillPillToneClassName,
      render: () => <ThreadSkillPills layout="panel" onDeactivate={skills.onDeactivate} skills={skills.skills} />,
      segments: [{ key: "skills", content: <><SlashIcon size={14} />{count(skills.skills.length)}</> }],
    }] : []),
    ...(vis?.sessions.length ? [{
      id: "vis",
      label: "Live vis",
      render: () => <ThreadVisSessionCard {...vis} />,
      segments: [{
        key: "vis",
        content: <>
          {visRendering ? <LoaderIcon size={14} /> : <WallpaperIcon size={14} />}
          {visUpdatedAt ? <WorkbenchRelativeTime format="short" timestampMs={visUpdatedAt} tooltip={false} /> : null}
        </>,
      }],
    }] : []),
    {
      id: "arc",
      label: arcLabel,
      render: () => (
        <div className="[&>*+*]:(border-t border-fg-alpha/16)">
          {showIntersections ? (
            <ThreadGitArcIntersectionCard
              chrome="flush"
              intersections={intersections}
              logicalProjectId={logicalProjectId}
              ownerProjectId={ownerProjectId}
            />
          ) : null}
          {gitArc ? <ThreadGitArcWork {...gitArc} history={gitCommitHistory} threadId={threadId} /> : null}
        </div>
      ),
      segments: arcSegments,
    },
    ...(todos ? [{
      id: "todos",
      label: "Goal, todos and addressed feedback",
      render: () => (
        <div className="[&>*+*]:(border-t border-fg-alpha/16)">{todos.renderPanel()}</div>
      ),
      segments: [
        { key: "goal", className: "", content: todos.goalSet ? <FlagFilledIcon size={14} /> : <FlagIcon size={14} /> },
        {
          key: "todos",
          className: todos.count || feedbackCount ? threadStatusSegmentClassName : "",
          content: <><ClipboardListIcon size={14} />{todos.count ? count(todos.count) : null}</>,
        },
        ...(feedbackCount ? [{
          key: "feedback",
          className: highlightFeedback
            ? `${threadStatusSegmentClassName} ${FEEDBACK_TEXT_TONE_CLASS_NAME}`
            : threadStatusSegmentClassName,
          content: <><MegaphoneIcon size={14} />{count(feedbackCount)}</>,
        }] : []),
      ],
    }] : []),
  ];

  return (
    <ThreadStatusRow
      attention={attention}
      busy={busy}
      inline={skills?.skills.length ? <ThreadSkillPills onDeactivate={skills.onDeactivate} skills={skills.skills} /> : null}
      leading={showPlanIntersectionStatus ? {
        content: (
          <Tooltip
            content={(
              <ThreadGitArcIntersectionCard
                chrome="flush"
                intersections={intersections}
                logicalProjectId={logicalProjectId}
                ownerProjectId={ownerProjectId}
              />
            )}
            interactive
            placement="top"
            surfaceClassName={`
              !px-0 !py-0 !backdrop-blur-none
              ${overlapCount
                ? "!border-amber-500/55 !bg-[color-mix(in_srgb,var(--color-amber-500)_12%,var(--app-bg-solid))]"
                : "!bg-[var(--app-bg-solid)]"}
            `}
          >
            <span
              className={`flex min-w-0 items-center gap-2 ${overlapCount ? amberClassName : ""}`}
              data-thread-plan-intersection-status={overlapCount ? "active" : "clear"}
            >
              <GitArcUnclaimIcon className="shrink-0" size={16} />
              <span className="truncate">
                {overlapCount
                  ? `Planned changes overlap ${overlapCount} active ${overlapCount === 1 ? "thread" : "threads"}`
                  : "No planned claims intersect active threads"}
              </span>
            </span>
          </Tooltip>
        ),
        panel: "arc",
      } : null}
      live={live}
      panels={panels}
    />
  );
}
