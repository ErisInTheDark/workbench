/*
 * Exports:
 * - default ThreadErrorCard: render the latest provider error while a thread remains in system-error state.
 */

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { CircleAlertIcon } from "../workbench-icons";

export default function ThreadErrorCard({
  status,
  lastTurn,
}: {
  status: string;
  lastTurn: Pick<Turn, "error"> | null;
}) {
  if (status !== "systemError") {
    return null;
  }

  const message = lastTurn?.error?.message.trim();
  if (!message) {
    return null;
  }

  return (
    <section
      aria-label="Thread error"
      className="mt-6 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-[0.7rem] bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] px-3.5 py-3 text-danger"
      data-thread-error-card="true"
      role="alert"
    >
      <CircleAlertIcon className="mt-[0.1em] shrink-0" size={16} />
      <p className="m-0 min-w-0 whitespace-pre-wrap text-[0.86em] leading-[1.55]">{message}</p>
    </section>
  );
}
