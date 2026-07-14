/*
 * Exports:
 * - ThreadSubagentWaitRenderEntry/ThreadSubagentWaitRenderGroup: describe parsed wait attempts and their UI-only folded groups. Keywords: thread, subagent, wait, timeout, render.
 * - groupThreadSubagentWaitRenderEntries: fold adjacent same-target timed-out attempts into their final timeout, active, or successful wait anchor. Keywords: subagent, wait, merge, targets.
 * - getThreadSubagentWaitTiming: derive frozen or live cumulative timing from command durations and the canonical item timeline. Keywords: subagent, wait, cumulative, duration, timeline.
 */

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { ThreadCommandExecutionOutcome } from "../../../lib/workbench/thread/thread-command-matchers";
import type { WorkbenchThreadItemTimelineEntry } from "../../../lib/workbench/thread/thread-item-timeline";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

export interface ThreadSubagentWaitRenderEntry<Item = CommandItem> {
  item: Item;
  outcome: ThreadCommandExecutionOutcome;
  threadIds: readonly string[];
}

export interface ThreadSubagentWaitRenderGroup<Item = CommandItem> {
  anchor: ThreadSubagentWaitRenderEntry<Item>;
  entries: readonly ThreadSubagentWaitRenderEntry<Item>[];
}

export interface ThreadSubagentWaitTiming {
  activeStartedAtMs: number | null;
  durationMs: number | null;
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getCanonicalThreadIds(threadIds: readonly string[]) {
  return [...threadIds].sort(compareStrings);
}

function hasIdenticalTargets<Item>(
  left: ThreadSubagentWaitRenderEntry<Item>,
  right: ThreadSubagentWaitRenderEntry<Item>,
) {
  const leftIds = getCanonicalThreadIds(left.threadIds);
  const rightIds = getCanonicalThreadIds(right.threadIds);
  return leftIds.length === rightIds.length
    && leftIds.every((threadId, index) => threadId === rightIds[index]);
}

function singleEntryGroup<Item>(entry: ThreadSubagentWaitRenderEntry<Item>): ThreadSubagentWaitRenderGroup<Item> {
  return { anchor: entry, entries: [entry] };
}

export function groupThreadSubagentWaitRenderEntries<Item>(
  entries: readonly ThreadSubagentWaitRenderEntry<Item>[],
): ThreadSubagentWaitRenderGroup<Item>[] {
  const groups: ThreadSubagentWaitRenderGroup<Item>[] = [];
  let pendingTimedOutEntries: ThreadSubagentWaitRenderEntry<Item>[] = [];

  const flushPendingTimedOutEntries = () => {
    const anchor = pendingTimedOutEntries[pendingTimedOutEntries.length - 1];
    if (!anchor) {
      return;
    }

    groups.push({
      anchor,
      entries: pendingTimedOutEntries,
    });
    pendingTimedOutEntries = [];
  };

  for (const entry of entries) {
    if (entry.outcome === "timedOut") {
      if (
        pendingTimedOutEntries.length
        && !hasIdenticalTargets(pendingTimedOutEntries[0], entry)
      ) {
        flushPendingTimedOutEntries();
      }
      pendingTimedOutEntries.push(entry);
      continue;
    }

    const canAbsorbTimedOutEntries = (
      entry.outcome === "completed" || entry.outcome === "inProgress"
    ) && pendingTimedOutEntries.length > 0
      && hasIdenticalTargets(pendingTimedOutEntries[0], entry);
    if (canAbsorbTimedOutEntries) {
      groups.push({
        anchor: entry,
        entries: [...pendingTimedOutEntries, entry],
      });
      pendingTimedOutEntries = [];
      continue;
    }

    flushPendingTimedOutEntries();
    groups.push(singleEntryGroup(entry));
  }

  flushPendingTimedOutEntries();
  return groups;
}

function findTimelineEntry(
  itemId: string,
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[],
) {
  return itemTimeline.find((entry) => entry.itemId === itemId || entry.aliases?.includes(itemId)) ?? null;
}

function getTimelineStartMs(entry: WorkbenchThreadItemTimelineEntry | null) {
  return entry?.startedAt ?? entry?.firstSeenAt ?? null;
}

function getTimelineEndMs(entry: WorkbenchThreadItemTimelineEntry | null) {
  return entry?.completedAt ?? entry?.lastSeenAt ?? null;
}

function getSettledDurationMs(
  item: Pick<CommandItem, "durationMs" | "id">,
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[],
) {
  if (item.durationMs !== null && Number.isFinite(item.durationMs)) {
    return Math.max(0, item.durationMs);
  }

  const timelineEntry = findTimelineEntry(item.id, itemTimeline);
  const startedAtMs = getTimelineStartMs(timelineEntry);
  const completedAtMs = getTimelineEndMs(timelineEntry);
  return startedAtMs !== null && completedAtMs !== null && completedAtMs >= startedAtMs
    ? completedAtMs - startedAtMs
    : null;
}

function sumSettledDurations(
  items: readonly Pick<CommandItem, "durationMs" | "id">[],
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[],
) {
  let durationMs = 0;
  for (const item of items) {
    const itemDurationMs = getSettledDurationMs(item, itemTimeline);
    if (itemDurationMs === null) {
      return null;
    }
    durationMs += itemDurationMs;
  }
  return durationMs;
}

export function getThreadSubagentWaitTiming(
  group: ThreadSubagentWaitRenderGroup<CommandItem>,
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[],
): ThreadSubagentWaitTiming {
  const items = group.entries.map((entry) => entry.item);
  if (group.anchor.outcome !== "inProgress") {
    return {
      activeStartedAtMs: null,
      durationMs: sumSettledDurations(items, itemTimeline),
    };
  }

  const settledItems = items.slice(0, -1);
  const settledDurationMs = sumSettledDurations(settledItems, itemTimeline);
  const activeTimelineEntry = findTimelineEntry(group.anchor.item.id, itemTimeline);
  const activeStartedAtMs = getTimelineStartMs(activeTimelineEntry);
  if (settledDurationMs === null) {
    return { activeStartedAtMs, durationMs: null };
  }

  if (activeStartedAtMs !== null) {
    return { activeStartedAtMs, durationMs: settledDurationMs };
  }

  const reportedActiveDurationMs = group.anchor.item.durationMs;
  return {
    activeStartedAtMs: null,
    durationMs: reportedActiveDurationMs !== null && Number.isFinite(reportedActiveDurationMs)
      ? settledDurationMs + Math.max(0, reportedActiveDurationMs)
      : settledItems.length ? settledDurationMs : null,
  };
}
