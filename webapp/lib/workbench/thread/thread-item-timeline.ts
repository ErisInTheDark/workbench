/*
 * Exports:
 * - WorkbenchThreadItemTimelineEntry: Workbench-owned item timing metadata carried with hydrated thread turns. Keywords: thread, timeline, timing.
 * - normalizeWorkbenchThreadItemTimeline: validate and normalize raw item timeline metadata from hydrated payloads. Keywords: thread, timeline, payload.
 * - getThreadItemTimelineDurationMs: compute a duration for a set of thread items from timeline metadata. Keywords: thread, duration, compaction.
 */

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
