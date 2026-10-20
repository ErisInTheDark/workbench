/*
 * Default export:
 * - ThreadStatusCommandItem: a managed task status update as a step line in its status tone; a failure opens on its reason.
 */
import { useContext } from "react";

import type { ThreadCommandExecutionOutcome, WorkbenchTaskStatusCommand } from "../../../workbench/thread/thread-command-matchers";
import { getNeedsAttentionThreadStatusTone, getWorkbenchThreadStatusClassName } from "../workbench-thread-status-colors";
import { CompletedThreadIcon, NeedsAttentionThreadIcon, WarningIcon } from "../workbench-icons";
import ThreadGitArcPresentationContext from "./ThreadGitArcPresentationContext";
import ThreadStepRow from "./ThreadStepRow";
import { isFailedStep, stepLabel, stepLabels } from "./thread-step";

const COMPLETE_LABELS = stepLabels("Completing task", "Task completed", "Failed to complete task");
const BLOCK_LABELS = stepLabels("Blocking task", "Task blocked", "Failed to block task");

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
  const failed = isFailedStep(outcome);
  const Icon = failed ? WarningIcon : completed ? CompletedThreadIcon : NeedsAttentionThreadIcon;
  const statusTone = completed
    ? "completed"
    : getNeedsAttentionThreadStatusTone(gitArcPresentation?.hasActiveGitArc === true);
  const colorClassName = failed ? "text-danger" : getWorkbenchThreadStatusClassName(statusTone);
  const detail = failed ? failureText?.trim() : null;

  return (
    <div data-role="thread-status-command" data-thread-status-tone={failed ? "failed" : statusTone}>
      <ThreadStepRow
        defaultOpen={Boolean(detail)}
        icon={<Icon size={16} />}
        iconClassName={colorClassName}
        progress={{ state: outcome }}
        summary={<span className={`font-semibold ${colorClassName}`}>{stepLabel(completed ? COMPLETE_LABELS : BLOCK_LABELS, outcome)}</span>}
      >
        {detail ? <p className="m-0 whitespace-pre-wrap text-[0.86em] leading-[1.5] text-danger">{detail}</p> : null}
      </ThreadStepRow>
    </div>
  );
}
