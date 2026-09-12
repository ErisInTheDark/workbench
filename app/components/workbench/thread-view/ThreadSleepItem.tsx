/*
 * Exports:
 * - default ThreadSleepItem: render a sleep countdown using existing item lifecycle timing.
 */
"use client";

import { useEffect, useState } from "react";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { getSleepDisplay } from "../../../workbench/thread/generic-item-matchers/sleep";
import { SnoozedThreadIcon } from "../workbench-icons";
import { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadSummaryText from "./ThreadSummaryText";

export default function ThreadSleepItem({
  durationMs,
  timeline,
  turnStatus,
}: {
  durationMs: number;
  timeline?: WorkbenchThreadItemTimelineEntry | null;
  turnStatus: Turn["status"];
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  const startedAt = timeline?.startedAt ?? timeline?.firstSeenAt ?? null;
  const completedAt = timeline?.completedAt ?? null;
  const display = getSleepDisplay({ durationMs, startedAt, completedAt, turnStatus, nowMs });

  useEffect(() => {
    if (!display.ticking) return;
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [display.ticking, startedAt]);

  return (
    <ThreadDisclosureStaticRow
      marker={<SnoozedThreadIcon size={16} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      summary={<ThreadSummaryText text={`${display.completed ? "Slept" : "Sleeping"} for ${display.seconds}s`} />}
    />
  );
}
