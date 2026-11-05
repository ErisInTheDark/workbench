/*
 * Exports:
 * - default ThreadErrorCard: render the thread error a failed provider turn left until the thread continues, and when auto resume will continue it.
 */

import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import { formatRateLimitResetTime } from "../../../workbench/rate-limit-display";
import ErrorCard from "../../ui/ErrorCard";

export default function ThreadErrorCard({ lifecycle, onCancelAutoResume }: {
  lifecycle: WorkbenchThreadLifecycle | null | undefined;
  onCancelAutoResume: () => void;
}) {
  if (lifecycle?.kind !== "needsAttention" || lifecycle.reason !== "providerFailed") return null;
  return <div className="mt-6" data-thread-error-card="true">
    <ErrorCard label="Thread error">{lifecycle.error}</ErrorCard>
    {lifecycle.resumeAt !== undefined ? <p className="mx-3.5 mt-2 mb-0 flex items-center gap-2 text-[0.86em] text-fg/muted">
      <span>Usage limit. Resumes at {formatRateLimitResetTime(lifecycle.resumeAt)}.</span>
      <button type="button" className="cursor-pointer underline" onClick={onCancelAutoResume}>Cancel</button>
    </p> : null}
  </div>;
}
