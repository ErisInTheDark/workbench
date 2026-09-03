/*
 * Exports:
 * - default ThreadErrorCard: render the latest provider error while a thread remains in system-error state. Keywords: thread, system error, turn error, recovery.
 */

import type { ThreadPayload } from "workbench-shared/types";
import { CircleAlertIcon } from "../workbench-icons";

export default function ThreadErrorCard({
  thread,
}: {
  thread: Pick<ThreadPayload, "status" | "turns">;
}) {
  if (thread.status !== "systemError") {
    return null;
  }

  const message = thread.turns.at(-1)?.error?.message.trim();
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
      <CircleAlertIcon className="mt-[0.1em] size-4 shrink-0" />
      <p className="m-0 min-w-0 whitespace-pre-wrap text-[0.86em] leading-[1.55]">{message}</p>
    </section>
  );
}
