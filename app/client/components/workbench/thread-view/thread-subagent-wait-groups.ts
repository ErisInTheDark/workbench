/*
 * Exports:
 * - ThreadSubagentWaitRenderEntry/ThreadSubagentWaitRenderGroup: describe parsed wait attempts and their UI-only folded groups. Keywords: thread, subagent, wait, timeout, render.
 * - groupThreadSubagentWaitRenderEntries: fold adjacent same-target timed-out attempts into their final timeout, active, or successful wait anchor. Keywords: subagent, wait, merge, targets.
 * - getThreadSubagentWaitTiming: derive frozen or live cumulative timing from command durations and the canonical item timeline. Keywords: subagent, wait, cumulative, duration, timeline.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

export interface ThreadSubagentWaitRenderEntry<Item = CommandItem> {
  item: Item;
  outcome: ThreadCommandExecutionOutcome;
  targetKeys: readonly string[];
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

function getCanonicalTargetKeys(targetKeys: readonly string[]) {
  return [...targetKeys].sort(compareStrings);
}

function hasIdenticalTargets<Item>(
  left: ThreadSubagentWaitRenderEntry<Item>,
  right: ThreadSubagentWaitRenderEntry<Item>,
) {
  const leftKeys = getCanonicalTargetKeys(left.targetKeys);
  const rightKeys = getCanonicalTargetKeys(right.targetKeys);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((targetKey, index) => targetKey === rightKeys[index]);
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
    const previousGroup = groups.at(-1);
    if (
      entry.outcome === "inProgress"
      && previousGroup?.anchor.outcome === "inProgress"
      && hasIdenticalTargets(previousGroup.anchor, entry)
    ) {
      groups[groups.length - 1] = {
        anchor: entry,
        entries: [...previousGroup.entries, entry],
      };
      continue;
    }
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
