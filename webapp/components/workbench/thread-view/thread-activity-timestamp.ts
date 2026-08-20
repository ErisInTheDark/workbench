/*
 * Exports:
 * - default resolveThreadActivityTimestampMs: resolve visible thread activity from the matching sidebar projection. Keywords: workbench, thread, activity, timestamp.
 */
import type { ThreadPayload, ThreadSummary } from "../../../lib/types";

function readActivityTimestampMs(thread: ThreadPayload | ThreadSummary | null | undefined) {
  return thread && Number.isFinite(thread.updatedAt) && thread.updatedAt > 0
    ? thread.updatedAt * 1000
    : 0;
}

export default function resolveThreadActivityTimestampMs(
  thread: ThreadPayload | ThreadSummary | null,
  activityProjection?: ThreadPayload | ThreadSummary | null,
) {
  const projectionMatchesThread = Boolean(
    activityProjection
    && (!thread || (activityProjection.harness === thread.harness && activityProjection.id === thread.id)),
  );
  const projectedTimestampMs = projectionMatchesThread ? readActivityTimestampMs(activityProjection) : 0;
  return projectedTimestampMs || readActivityTimestampMs(thread);
}
