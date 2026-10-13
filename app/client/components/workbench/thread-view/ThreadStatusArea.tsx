/*
 * Exports:
 * - default ThreadStatusArea: compose a thread's status row from its live activity, skills, live vis, Git arc work
 *   (claim intersections, proposals, claims, stash, accepted commits) and goal/todos with addressed feedback.
 */
"use client";

import type { ReactNode } from "react";
import type { VisLiveSession } from "workbench-shared/workbench/vis/vis-contract";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import type { WorkbenchHarnessId, WorkbenchThreadLifecycle, WorkbenchThreadTarget } from "workbench-shared/workbench/thread/thread-state";
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
import ThreadStatusRow, { threadStatusSegmentClassName, type ThreadStatusPanel } from "./ThreadStatusRow";
import ThreadVisSessionCard, { getVisSessionsUpdatedAt } from "./ThreadVisSessionCard";
import ThreadAddressedFeedback from "./ThreadAddressedFeedback";
import ThreadGitArcWork, { type ThreadGitArcWorkProps } from "./ThreadGitArcWork";
import type { ThreadLiveActivityView } from "./use-thread-live-activity";
import { FEEDBACK_TEXT_TONE_CLASS_NAME } from "../feedback-presentation";

const amberClassName = "text-amber-600 dark:text-amber-300";

function count(value: number) {
  return <span>{value}</span>;
}

export default function ThreadStatusArea({
  addressedFeedback = [],
  gitArc,
  harness,
  live,
  onFeedbackDeleted,
  onOpenThread,
  skills,
  threadId,
  threadLifecycle,
  todos,
  vis,
  ...shared
}: {
  addressedFeedback?: readonly WorkbenchThreadAddressedFeedback[];
  gitArc: Omit<ThreadGitArcWorkProps, "projectFilePaths" | "projectId" | "projectRootPath" | "threadId" | "workspaceRoots"> | null;
  harness: WorkbenchHarnessId;
  live: ThreadLiveActivityView | null;
  onFeedbackDeleted: () => Promise<void>;
  onOpenThread: (target: WorkbenchThreadTarget) => void;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  /** Absent where a thread has no skills to manage, such as draft views. */
  skills: { onDeactivate: (path: string) => Promise<void>; skills: readonly WorkbenchThreadSkill[] } | null;
  threadId: string;
  threadLifecycle: WorkbenchThreadLifecycle | null;
  /** Absent where a thread has no goal or todos to manage. */
  todos: { count: number; goalSet: boolean; renderPanel(): ReactNode } | null;
  vis: { onAnswer: (sessionId: string, value: string) => Promise<void>; onEnd: (sessionId: string) => void; sessions: readonly VisLiveSession[] } | null;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const { intersections, logicalProjectId, ownerProjectId } = useThread.claimIntersections(threadId, harness, "plan");
  const overlapCount = intersections.hasScope ? intersections.activeEntries.length : 0;
  const plannedOverlapCount = intersections.hasScope ? intersections.plannedEntries.length : 0;
  const showPlanIntersectionStatus = !live && intersections.hasScope;
  const claim = gitArc?.claim ?? null;
  const proposals = claim?.proposals.filter(({ status }) => status === "proposed") ?? [];
  const accepted = claim?.proposals.filter(({ status }) => status === "committed").length ?? 0;
  const claimed = claim?.claimedPaths.length ?? 0;
  const stashed = claim?.stashedPaths?.length ?? 0;
  const feedback = addressedFeedback;
  const highlightFeedback = threadLifecycle?.kind === "completed";

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
              onOpenThread={onOpenThread}
              ownerProjectId={ownerProjectId}
            />
          ) : null}
          {gitArc ? <ThreadGitArcWork {...gitArc} {...shared} threadId={threadId} /> : null}
        </div>
      ),
      segments: arcSegments,
    },
    ...(todos ? [{
      id: "todos",
      label: "Goal, todos and addressed feedback",
      render: () => (
        <div className="[&>*+*]:(border-t border-fg-alpha/16)">
          {todos.renderPanel()}
          <ThreadAddressedFeedback feedback={feedback} onDeleted={onFeedbackDeleted} />
        </div>
      ),
      segments: [
        { key: "goal", className: "", content: todos.goalSet ? <FlagFilledIcon size={14} /> : <FlagIcon size={14} /> },
        {
          key: "todos",
          className: todos.count || feedback.length ? threadStatusSegmentClassName : "",
          content: <><ClipboardListIcon size={14} />{todos.count ? count(todos.count) : null}</>,
        },
        ...(feedback.length ? [{
          key: "feedback",
          className: highlightFeedback
            ? `${threadStatusSegmentClassName} ${FEEDBACK_TEXT_TONE_CLASS_NAME}`
            : threadStatusSegmentClassName,
          content: <><MegaphoneIcon size={14} />{count(feedback.length)}</>,
        }] : []),
      ],
    }] : []),
  ];

  return (
    <ThreadStatusRow
      // A stopped turn that leaves proposals to review opens them, once per pending set.
      attention={!gitArc?.running && proposals.length ? { key: proposals.map(({ proposalId }) => proposalId).join("\0"), panel: "arc" } : null}
      inline={skills?.skills.length ? <ThreadSkillPills onDeactivate={skills.onDeactivate} skills={skills.skills} /> : null}
      leading={showPlanIntersectionStatus ? {
        content: (
          <Tooltip
            content={(
              <ThreadGitArcIntersectionCard
                chrome="flush"
                intersections={intersections}
                logicalProjectId={logicalProjectId}
                onOpenThread={onOpenThread}
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
