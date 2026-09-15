/*
 * Exports:
 * - ThreadRenderProjection/projectThreadRenderTurns: group hidden unfinished-turn continuations into one render-only logical turn. Keywords: thread, rendering, continuation.
 */

import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import {
  isWorkbenchUnfinishedContinuationTurn,
  isWorkbenchUnfinishedTurnInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";

export interface ThreadRenderProjection {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  thread: ThreadPayload;
}

interface TurnRenderGroup {
  sourceTurnIds: string[];
  turn: Turn;
}

function isUnfinishedTurnUserMessage(item: Turn["items"][number]) {
  return item.type === "userMessage" && isWorkbenchUnfinishedTurnInput(item.content);
}

function mergedDurationMs(first: Turn, latest: Turn) {
  if (latest.completedAt === null) return null;
  if (first.startedAt !== null) return Math.max(0, (latest.completedAt - first.startedAt) * 1_000);
  const durations = [first.durationMs, latest.durationMs].filter((duration): duration is number => duration !== null);
  return durations.length ? durations.reduce((total, duration) => total + duration, 0) : null;
}

function mergeTurnGroup(group: TurnRenderGroup, latest: Turn): TurnRenderGroup {
  const first = group.turn;
  const visibleLatestItems = latest.items.filter((item) => !isUnfinishedTurnUserMessage(item));
  return {
    sourceTurnIds: [...group.sourceTurnIds, latest.id],
    turn: {
      ...latest,
      durationMs: mergedDurationMs(first, latest),
      items: [...first.items, ...visibleLatestItems],
      startedAt: first.startedAt,
    },
  };
}

function createHistoryEntry(
  group: TurnRenderGroup,
  historyByTurnId: ReadonlyMap<string, WorkbenchThreadTurnHistoryEntry>,
): WorkbenchThreadTurnHistoryEntry {
  const turn = group.turn;
  const timelines = group.sourceTurnIds.flatMap((turnId) => historyByTurnId.get(turnId)?.itemTimeline ?? []);
  return {
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map((item) => item.id),
    ...(timelines.length ? { itemTimeline: timelines } : {}),
    loadState: "loaded",
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  };
}

export default function projectThreadRenderTurns(
  thread: ThreadPayload,
  browseResultEntries: readonly WorkbenchBrowseResultEntry[] = thread.browseResultEntries ?? [],
): ThreadRenderProjection {
  const groups: TurnRenderGroup[] = [];
  for (const turn of thread.turns) {
    const continuesPreviousTurn = isWorkbenchUnfinishedContinuationTurn(turn);
    const previous = groups.at(-1);
    if (continuesPreviousTurn && previous) {
      groups[groups.length - 1] = mergeTurnGroup(previous, turn);
    } else {
      groups.push({ sourceTurnIds: [turn.id], turn });
    }
  }

  const sourceToLogicalTurnId = new Map<string, string>();
  for (const group of groups) {
    for (const sourceTurnId of group.sourceTurnIds) sourceToLogicalTurnId.set(sourceTurnId, group.turn.id);
  }
  const historyByTurnId = new Map(thread.turnHistory.map((entry) => [entry.turnId, entry]));
  const mergedHistoryByTurnId = new Map(groups.map((group) => [group.turn.id, createHistoryEntry(group, historyByTurnId)]));
  const projectedHistory = thread.turnHistory.length
    ? thread.turnHistory.flatMap((entry) => {
      const logicalTurnId = sourceToLogicalTurnId.get(entry.turnId);
      if (!logicalTurnId) return [entry];
      return logicalTurnId === entry.turnId ? [mergedHistoryByTurnId.get(logicalTurnId)!] : [];
    })
    : groups.map((group) => mergedHistoryByTurnId.get(group.turn.id)!);
  const projectedBrowseEntries = browseResultEntries.map((entry) => {
    const logicalTurnId = sourceToLogicalTurnId.get(entry.turnId);
    return logicalTurnId && logicalTurnId !== entry.turnId ? { ...entry, turnId: logicalTurnId } : entry;
  });
  const nextPageCursor = thread.nextPageCursor
    ? sourceToLogicalTurnId.get(thread.nextPageCursor) ?? thread.nextPageCursor
    : thread.nextPageCursor;

  return {
    browseResultEntries: projectedBrowseEntries,
    thread: {
      ...thread,
      browseResultEntries: projectedBrowseEntries,
      nextPageCursor,
      turnHistory: projectedHistory,
      turns: groups.map((group) => group.turn),
    },
  };
}
