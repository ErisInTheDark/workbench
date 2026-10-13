/*
 * Exports:
 * - default ThreadErrorCard: render the thread error a failed provider turn left until the thread continues.
 */

import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import { CircleAlertIcon } from "../workbench-icons";

export default function ThreadErrorCard({ lifecycle }: { lifecycle: WorkbenchThreadLifecycle | null | undefined }) {
  if (lifecycle?.kind !== "needsAttention" || lifecycle.reason !== "providerFailed") return null;

  return (
    <section
      aria-label="Thread error"
      className="mt-6 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-[0.7rem] bg-[color-mix(in_srgb,var(--danger)_9%,transparent)] px-3.5 py-3 text-danger"
      data-thread-error-card="true"
      role="alert"
    >
      <CircleAlertIcon className="mt-[0.1em] shrink-0" size={16} />
      <p className="m-0 min-w-0 whitespace-pre-wrap text-[0.86em] leading-[1.55]">{lifecycle.error}</p>
    </section>
  );
}
