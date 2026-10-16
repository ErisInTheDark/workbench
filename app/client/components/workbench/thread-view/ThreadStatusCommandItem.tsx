/*
 * Default export:
 * - ThreadStatusCommandItem: render managed task status updates and actionable rejection reasons.
 */
import { useContext } from "react";

import type { ThreadCommandExecutionOutcome, WorkbenchTaskStatusCommand } from "../../../workbench/thread/thread-command-matchers";
import { getNeedsAttentionThreadStatusTone, getWorkbenchThreadStatusClassName } from "../workbench-thread-status-colors";
import { CompletedThreadIcon, NeedsAttentionThreadIcon, WarningIcon } from "../workbench-icons";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

export default function ThreadStatusCommandItem({
  failureText,
  outcome,
  status,
}: {
  failureText?: string | null;
  outcome: ThreadCommandExecutionOutcome;
  status: WorkbenchTaskStatusCommand["status"];
}) {
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);
  const completed = status === "completed";
  const failed = outcome !== "completed" && outcome !== "inProgress";
  const Icon = failed ? WarningIcon : completed ? CompletedThreadIcon : NeedsAttentionThreadIcon;
  const label = outcome === "completed"
    ? completed ? "Task completed" : "Task blocked"
    : outcome === "inProgress"
      ? completed ? "Completing task" : "Blocking task"
      : outcome === "timedOut" ? "Task status update timed out"
        : outcome === "declined" ? "Task status update declined"
          : completed ? "Could not complete task" : "Could not block task";
  const statusTone = completed
    ? "completed"
    : getNeedsAttentionThreadStatusTone(gitArcPresentation?.hasActiveGitArc === true);
  const colorClassName = failed ? "text-danger" : getWorkbenchThreadStatusClassName(statusTone);
  const detail = failed ? failureText?.trim() : null;

  return (
    <div className={`py-1.5 text-[0.92em] leading-[1.6] ${colorClassName}`} data-role="thread-status-command" data-thread-status-tone={failed ? "failed" : statusTone}>
      <div className="flex items-center gap-2">
        <Icon className="shrink-0" size={16} />
        <span className="font-semibold">{label}</span>
      </div>
      {detail ? <p className="m-0 whitespace-pre-wrap pl-6 text-[0.86em] leading-[1.5]">{detail}</p> : null}
    </div>
  );
}
