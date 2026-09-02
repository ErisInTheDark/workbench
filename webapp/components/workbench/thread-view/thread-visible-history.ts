/*
 * Exports:
 * - getThreadVisibleHistoryEntries: project loaded turns into retained scrollback plus the next lazy-load trigger. Keywords: thread, history, pagination, scrollback.
 */

import type { ThreadPayload, WorkbenchThreadTurnHistoryEntry } from "../../../lib/types";
import type { WorkbenchTranscriptProjection } from "../../../lib/workbench/transcript/workbench-transcript-projection";

type ThreadVisibleHistorySource =
  | Pick<ThreadPayload, "turnHistory" | "turns">
  | Pick<WorkbenchTranscriptProjection, "turnHistory" | "turns">;

function createLoadedHistoryEntry(
  turn: ThreadPayload["turns"][number] | WorkbenchTranscriptProjection["turns"][number],
): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    itemTimeline: undefined,
    loadState: "loaded",
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  };
}

export function getThreadVisibleHistoryEntries(
  thread: ThreadVisibleHistorySource,
) {
  const loadedTurnIds = new Set(thread.turns.map((turn) => turn.id));
  const history = thread.turnHistory.length
    ? thread.turnHistory
    : thread.turns.map(createLoadedHistoryEntry);
  if (!history.length) {
    return [];
  }

  let lastLoadedIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (loadedTurnIds.has(history[index]!.turnId)) {
      lastLoadedIndex = index;
      break;
    }
  }
  if (lastLoadedIndex < 0) {
    return history.slice(-1);
  }

  const firstLoadedIndex = history.findIndex((entry) => loadedTurnIds.has(entry.turnId));
  const triggerIndex = firstLoadedIndex > 0 && !loadedTurnIds.has(history[firstLoadedIndex - 1]!.turnId)
    ? firstLoadedIndex - 1
    : firstLoadedIndex;
  return history.slice(triggerIndex, lastLoadedIndex + 1);
}
