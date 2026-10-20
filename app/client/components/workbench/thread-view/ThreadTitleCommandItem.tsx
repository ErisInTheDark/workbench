/*
 * Default export:
 * - ThreadTitleCommandItem: one standalone managed-thread title update as a step line; a failure opens on its reason.
 */
import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import { TitleCommandIcon } from "../workbench-icons";
import ThreadStepRow from "./ThreadStepRow";
import { isFailedStep, stepLabel, stepLabels } from "./thread-step";

const LABELS = stepLabels("Setting task:", "Task:", "Failed to set task:", { declined: "Declined task update:" });

export default function ThreadTitleCommandItem({
  failureText,
  outcome,
  title,
}: {
  failureText?: string | null;
  outcome: ThreadCommandExecutionOutcome;
  title: string;
}) {
  const failed = isFailedStep(outcome);
  const detail = failed ? failureText?.trim() : "";
  return (
    <div data-role="thread-title-command">
      <ThreadStepRow
        defaultOpen={Boolean(detail)}
        icon={<TitleCommandIcon size={16} />}
        iconClassName={failed ? "text-danger" : undefined}
        label={stepLabel(LABELS, outcome)}
        progress={{ state: outcome }}
        subject={title}
      >
        {detail ? <p className="m-0 text-[0.86em] leading-[1.5] text-danger">{detail}</p> : null}
      </ThreadStepRow>
    </div>
  );
}
