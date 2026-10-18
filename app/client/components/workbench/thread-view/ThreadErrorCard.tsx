/*
 * Exports:
 * - default ThreadErrorCard: render the thread error a failed provider turn left until the thread continues.
 */

import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import ErrorCard from "../../ui/ErrorCard";

export default function ThreadErrorCard({ lifecycle }: { lifecycle: WorkbenchThreadLifecycle | null | undefined }) {
  if (lifecycle?.kind !== "needsAttention" || lifecycle.reason !== "providerFailed") return null;
  return <div className="mt-6" data-thread-error-card="true">
    <ErrorCard label="Thread error">{lifecycle.error}</ErrorCard>
  </div>;
}
