/*
 * Default export:
 * - ThreadTitleCommandItem: render one standalone managed-thread title update with explicit lifecycle state.
 */
import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import { TitleCommandIcon } from "../workbench-icons";

export default function ThreadTitleCommandItem({
  failureText,
  outcome,
  title,
}: {
  failureText?: string | null;
  outcome: ThreadCommandExecutionOutcome;
  title: string;
}) {
  const failed = outcome === "failed" || outcome === "timedOut" || outcome === "declined";
  const prefix = outcome === "completed"
    ? "Task:"
    : outcome === "inProgress"
      ? "Setting task:"
      : outcome === "timedOut"
        ? "Timed out setting task:"
        : outcome === "declined" ? "Declined task update:" : "Failed to set task:";
  const detail = failed ? failureText?.trim() : "";

  return (
    <div className="py-1.5 text-[0.92em] leading-[1.6]" data-role="thread-title-command">
      <div className={`flex items-center gap-2 ${failed ? "text-danger" : "text-muted"}`}>
        <TitleCommandIcon className="shrink-0" size={16} />
        <span><span>{prefix}</span> <span className={failed ? "font-semibold" : "font-semibold text-text"}>{title}</span></span>
      </div>
      {detail ? <p className="m-0 pl-6 text-[0.86em] leading-[1.5] text-danger">{detail}</p> : null}
    </div>
  );
}
