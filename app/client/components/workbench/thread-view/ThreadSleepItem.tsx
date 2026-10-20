/*
 * Exports:
 * - default ThreadSleepItem: a sleep as one step line counting down using existing item lifecycle timing.
 */
"use client";

import { useEffect, useState } from "react";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { getSleepDisplay } from "../../../workbench/thread/generic-item-matchers/sleep";
import { SnoozedThreadIcon } from "../workbench-icons";
import ThreadStepRow from "./ThreadStepRow";
import { stepLabel, stepLabels } from "./thread-step";

const LABELS = stepLabels("Sleeping for", "Slept for", "Failed to sleep for");

export default function ThreadSleepItem({
  durationMs,
  ended = false,
  timeline,
  turnStatus,
}: {
  durationMs: number;
  /** The sleep's own item says it ended (a sleep command's status), whatever the timeline has recorded so far. */
  ended?: boolean;
  timeline?: WorkbenchThreadItemTimelineEntry | null;
  turnStatus: Turn["status"];
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  const startedAt = timeline?.startedAt ?? timeline?.firstSeenAt ?? null;
  const completedAt = timeline?.completedAt ?? (ended ? startedAt ?? 0 : null);
  const display = getSleepDisplay({ durationMs, startedAt, completedAt, turnStatus, nowMs });

  useEffect(() => {
    if (!display.ticking) return;
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [display.ticking, startedAt]);

  return (
    <ThreadStepRow
      icon={<SnoozedThreadIcon size={16} />}
      label={stepLabel(LABELS, display.completed ? "completed" : "inProgress")}
      subject={`${display.seconds}s`}
    />
  );
}
