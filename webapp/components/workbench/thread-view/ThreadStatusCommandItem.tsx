/*
 * Default export:
 * - ThreadStatusCommandItem: render one successful or in-progress managed task status update. Keywords: thread, task, status, completed, blocked.
 */
import type { WorkbenchThreadStatusCommand } from "../../../lib/workbench/thread/thread-command-matchers";
import { CompletedThreadIcon, NeedsAttentionThreadIcon } from "../workbench-icons";

export default function ThreadStatusCommandItem({
  outcome,
  status,
}: {
  outcome: "completed" | "inProgress";
  status: WorkbenchThreadStatusCommand["status"];
}) {
  const completed = status === "completed";
  const Icon = completed ? CompletedThreadIcon : NeedsAttentionThreadIcon;
  const label = outcome === "completed"
    ? completed ? "Task completed" : "Task blocked"
    : completed ? "Completing task" : "Blocking task";
  const colorClassName = completed
    ? "text-emerald-600 dark:text-emerald-300"
    : "text-amber-600 dark:text-amber-300";

  return (
    <div className={`py-1.5 text-[0.92em] leading-[1.6] ${colorClassName}`} data-role="thread-status-command">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="font-semibold">{label}</span>
      </div>
    </div>
  );
}
