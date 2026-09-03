/*
 * Default export:
 * - ThreadTitleCommandItem: render one standalone managed-thread title update with explicit lifecycle state. Keywords: thread, title, task, command, flag.
 */
import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";

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
        <svg
          aria-hidden="true"
          className="size-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
        </svg>
        <span><span>{prefix}</span> <span className={failed ? "font-semibold" : "font-semibold text-text"}>{title}</span></span>
      </div>
      {detail ? <p className="m-0 pl-6 text-[0.86em] leading-[1.5] text-danger">{detail}</p> : null}
    </div>
  );
}
