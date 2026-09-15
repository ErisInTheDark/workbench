/*
 * Exports:
 * - WorkbenchThreadItemTimelineEntry: Workbench-owned item timing metadata carried with hydrated thread turns.
 * - normalizeWorkbenchThreadItemTimeline: validate and normalize raw item timeline metadata from hydrated payloads.
 * - findWorkbenchThreadItemTimelineEntry: resolve one item's timeline entry by canonical id or alias.
 * - upsertWorkbenchThreadItemTimelineEntry: merge one live lifecycle observation into the owned item timeline.
 * - getThreadItemTimelineDurationMs: compute a duration for a set of thread items from timeline metadata.
 * - projectWorkbenchThreadItemTimelines: add overlay timing to hydrated turn history without replacing existing observations.
 */

import type { Turn } from "./workbench-thread-turn.ts";
import type { ThreadPayloadData, WorkbenchThreadTurnHistoryEntry } from "../../types.ts";
import { areDeeplyEqual } from "../deep-equality.ts";

export interface WorkbenchThreadItemTimelineEntry {
  aliases?: string[];
  completedAt: number | null;
  firstSeenAt: number | null;
  itemId: string;
  lastSeenAt: number | null;
  startedAt: number | null;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNullableTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))))
    : [];
}

function normalizeWorkbenchThreadItemTimelineEntry(value: unknown): WorkbenchThreadItemTimelineEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.itemId !== "string" || !record.itemId.trim()) {
    return null;
  }

  const aliases = normalizeStringArray(record.aliases);
  return {
    ...(aliases.length ? { aliases } : {}),
    completedAt: asNullableTimestamp(record.completedAt),
    firstSeenAt: asNullableTimestamp(record.firstSeenAt),
    itemId: record.itemId,
    lastSeenAt: asNullableTimestamp(record.lastSeenAt),
    startedAt: asNullableTimestamp(record.startedAt),
  };
}

export function normalizeWorkbenchThreadItemTimeline(value: unknown): WorkbenchThreadItemTimelineEntry[] {
  return Array.isArray(value)
    ? value
      .map(normalizeWorkbenchThreadItemTimelineEntry)
      .filter((entry): entry is WorkbenchThreadItemTimelineEntry => Boolean(entry))
    : [];
}

function timelineEntryMatchesItemId(entry: WorkbenchThreadItemTimelineEntry, itemIds: ReadonlySet<string>) {
  return itemIds.has(entry.itemId) || Boolean(entry.aliases?.some((alias) => itemIds.has(alias)));
}

export function findWorkbenchThreadItemTimelineEntry(
  itemId: string,
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
) {
  if (!itemTimeline?.length || !itemId) {
    return null;
  }

  const itemIds = new Set([itemId]);
  return itemTimeline.find((entry) => timelineEntryMatchesItemId(entry, itemIds)) ?? null;
}

function getEarliestTimestamp(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function getLatestTimestamp(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

export function upsertWorkbenchThreadItemTimelineEntry(
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
  incomingEntry: WorkbenchThreadItemTimelineEntry,
) {
  const currentTimeline = itemTimeline ?? [];
  const incomingItemIds = new Set([incomingEntry.itemId, ...(incomingEntry.aliases ?? [])]);
  const existingIndex = currentTimeline.findIndex((entry) => timelineEntryMatchesItemId(entry, incomingItemIds));
  if (existingIndex === -1) {
    return [...currentTimeline, incomingEntry];
  }

  const existingEntry = currentTimeline[existingIndex]!;
  const aliases = Array.from(new Set([
    ...(existingEntry.aliases ?? []),
    ...(incomingEntry.aliases ?? []),
    ...(existingEntry.itemId === incomingEntry.itemId ? [] : [existingEntry.itemId]),
  ])).filter((alias) => alias !== incomingEntry.itemId);
  const mergedEntry: WorkbenchThreadItemTimelineEntry = {
    ...(aliases.length ? { aliases } : {}),
    completedAt: incomingEntry.completedAt ?? existingEntry.completedAt,
    firstSeenAt: getEarliestTimestamp(existingEntry.firstSeenAt, incomingEntry.firstSeenAt),
    itemId: incomingEntry.itemId,
    lastSeenAt: getLatestTimestamp(existingEntry.lastSeenAt, incomingEntry.lastSeenAt),
    startedAt: getEarliestTimestamp(existingEntry.startedAt, incomingEntry.startedAt),
  };

  return currentTimeline.map((entry, index) => index === existingIndex ? mergedEntry : entry);
}

export function projectWorkbenchThreadItemTimelines<Payload extends ThreadPayloadData<string> & { isDraft: boolean }>(
  thread: Payload,
  entriesForTurn: (turn: Turn) => readonly WorkbenchThreadItemTimelineEntry[],
): Payload {
  const updates = new Map<string, WorkbenchThreadTurnHistoryEntry>();
  let hasTiming = false;
  for (const turn of thread.turns) {
    const entries = entriesForTurn(turn);
    hasTiming ||= entries.length > 0;
    const history = thread.turnHistory.find((entry) => entry.turnId === turn.id);
    if (!entries.length && history) continue;
    let itemTimeline = history?.itemTimeline ?? [];
    for (const entry of entries) {
      itemTimeline = upsertWorkbenchThreadItemTimelineEntry(itemTimeline, entry);
    }
    if (history && areDeeplyEqual(itemTimeline, history.itemTimeline ?? [])) continue;
    updates.set(turn.id, {
      ...(history ?? {
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        itemCount: turn.items.length,
        itemIds: turn.items.map((item) => item.id),
        loadState: "loaded",
        startedAt: turn.startedAt,
        status: turn.status,
        turnId: turn.id,
      }),
      itemTimeline,
    });
  }
  if (!hasTiming || !updates.size) return thread;
  const turnHistory = thread.turnHistory.map((entry) => {
    const update = updates.get(entry.turnId);
    updates.delete(entry.turnId);
    return update ?? entry;
  });
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const missing = updates.get(thread.turns[index]!.id);
    if (!missing) continue;
    const nextIndex = turnHistory.findIndex((entry) => entry.turnId === thread.turns[index + 1]?.id);
    turnHistory.splice(nextIndex < 0 ? turnHistory.length : nextIndex, 0, missing);
  }
  return { ...thread, turnHistory };
}

function getEntryStartMs(entry: WorkbenchThreadItemTimelineEntry) {
  return entry.startedAt ?? entry.firstSeenAt;
}

function getEntryEndMs(entry: WorkbenchThreadItemTimelineEntry) {
  return entry.completedAt ?? entry.lastSeenAt;
}

export function getThreadItemTimelineDurationMs(
  itemIds: Iterable<string>,
  itemTimeline: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
) {
  if (!itemTimeline?.length) {
    return null;
  }

  const itemIdSet = new Set(Array.from(itemIds).filter(Boolean));
  if (!itemIdSet.size) {
    return null;
  }

  let startedAt: number | null = null;
  let completedAt: number | null = null;
  for (const entry of itemTimeline) {
    if (!timelineEntryMatchesItemId(entry, itemIdSet)) {
      continue;
    }

    const entryStart = getEntryStartMs(entry);
    const entryEnd = getEntryEndMs(entry);
    if (entryStart !== null) {
      startedAt = startedAt === null ? entryStart : Math.min(startedAt, entryStart);
    }
    if (entryEnd !== null) {
      completedAt = completedAt === null ? entryEnd : Math.max(completedAt, entryEnd);
    }
  }

  if (startedAt === null || completedAt === null || completedAt < startedAt) {
    return null;
  }

  return completedAt - startedAt;
}
