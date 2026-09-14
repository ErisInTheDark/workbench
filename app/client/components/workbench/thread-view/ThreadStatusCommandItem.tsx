/*
 * Default export:
 * - ThreadStatusCommandItem: render one successful or in-progress managed task status update.
 */
import { useContext } from "react";

import type { WorkbenchTaskStatusCommand } from "../../../workbench/thread/thread-command-matchers";
import { getNeedsAttentionThreadStatusTone, getWorkbenchThreadStatusClassName } from "../workbench-thread-status-colors";
import { CompletedThreadIcon, NeedsAttentionThreadIcon } from "../workbench-icons";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";

export default function ThreadStatusCommandItem({
  outcome,
  status,
}: {
  outcome: "completed" | "inProgress";
  status: WorkbenchTaskStatusCommand["status"];
}) {
  const gitArcPresentation = useContext(ThreadGitArcPresentationContext);
  const completed = status === "completed";
  const Icon = completed ? CompletedThreadIcon : NeedsAttentionThreadIcon;
  const label = outcome === "completed"
    ? completed ? "Task completed" : "Task blocked"
    : completed ? "Completing task" : "Blocking task";
  const statusTone = completed
    ? "completed"
    : getNeedsAttentionThreadStatusTone(gitArcPresentation?.hasActiveGitArc === true);
  const colorClassName = getWorkbenchThreadStatusClassName(statusTone);

  return (
    <div className={`py-1.5 text-[0.92em] leading-[1.6] ${colorClassName}`} data-role="thread-status-command" data-thread-status-tone={statusTone}>
      <div className="flex items-center gap-2">
        <Icon className="shrink-0" size={16} />
        <span className="font-semibold">{label}</span>
      </div>
    </div>
  );
}
