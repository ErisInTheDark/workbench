/*
 * Default export:
 * - reconcileTranscriptProjectionWithLiveThread: apply the shared provider-live overlay to one temporary SQLite shadow projection. Keywords: transcript, SQLite, projection, live, overlay.
 */
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { getCurrentInProgressTurn } from "workbench-shared/codex/thread-state";
import type { ThreadPayload, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";

function isProjectedProviderItem(item: WorkbenchProjectedTranscriptItem): item is ThreadItem {
  return item.type !== "questionnaire" && item.type !== "approval" && item.type !== "generic";
}

function liveTurnHistoryEntry(
  turn: Omit<Turn, "items"> & { items: readonly { id: string }[] },
  itemTimeline: WorkbenchThreadTurnHistoryEntry["itemTimeline"],
): WorkbenchThreadTurnHistoryEntry {
  return {
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    itemIds: turn.items.map(({ id }) => id),
    itemTimeline: itemTimeline ?? [],
    loadState: "loaded",
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  };
}

export default function reconcileTranscriptProjectionWithLiveThread({
  mergeLiveTurn,
  projection,
  thread,
}: {
  mergeLiveTurn: (incomingTurn: Turn, liveTurn: Turn | undefined) => Turn;
  projection: WorkbenchTranscriptProjection;
  thread: ThreadPayload;
}): WorkbenchTranscriptProjection {
  const liveTurnsById = new Map(thread.turns.map((turn) => [turn.id, turn]));
  const liveHistoryByTurnId = new Map(thread.turnHistory.map((entry) => [entry.turnId, entry]));
  const canonicalItemIds = new Set(projection.display.orderedItems.map(({ itemId }) => itemId));
  const replacementsById = new Map<string, ThreadItem>();
  const virtualItemsByTurnId = new Map<string, ThreadItem[]>();

  for (const turn of projection.turns) {
    const incomingItems = turn.items.filter(isProjectedProviderItem);
    const incomingIds = new Set(incomingItems.map(({ id }) => id));
    const merged = mergeLiveTurn(
      { ...turn, items: incomingItems },
      liveTurnsById.get(turn.id),
    );
    for (const item of merged.items) {
      if (incomingIds.has(item.id)) {
        replacementsById.set(item.id, item);
      } else if (!canonicalItemIds.has(item.id)) {
        const virtualItems = virtualItemsByTurnId.get(turn.id) ?? [];
        virtualItems.push(item);
        virtualItemsByTurnId.set(turn.id, virtualItems);
      }
    }
  }

  const projectedTurns = projection.turns.map<WorkbenchProjectedTranscriptTurn>((turn) => {
    const virtualItems = virtualItemsByTurnId.get(turn.id) ?? [];
    const items = [
      ...turn.items.map((item) => replacementsById.get(item.id) ?? item),
      ...virtualItems,
    ];
    const virtualIds = new Set(virtualItems.map(({ id }) => id));
    const liveTimeline = liveHistoryByTurnId.get(turn.id)?.itemTimeline ?? [];
    const itemTimeline = [
      ...turn.itemTimeline,
      ...liveTimeline.filter(({ itemId }) => virtualIds.has(itemId)),
    ];
    return { ...turn, itemTimeline, items };
  });

  const liveTail = getCurrentInProgressTurn(thread);
  const isMissingActiveTail = liveTail
    && thread.turns.at(-1)?.id === liveTail.id
    && !projectedTurns.some(({ id }) => id === liveTail.id);
  if (isMissingActiveTail) {
    const virtualItems = liveTail.items.filter(({ id }) => !canonicalItemIds.has(id));
    const nextTurnIndex = Math.max(-1, ...projectedTurns.map(({ turnIndex }) => turnIndex)) + 1;
    const itemTimeline = liveHistoryByTurnId.get(liveTail.id)?.itemTimeline ?? [];
    projectedTurns.push({
      ...liveTail,
      itemTimeline,
      items: virtualItems,
      turnIndex: nextTurnIndex,
    });
    virtualItemsByTurnId.set(liveTail.id, virtualItems);
  }

  const turnsById = new Map(projectedTurns.map((turn) => [turn.id, turn]));
  const display = planCanonicalTranscriptDisplay({
    items: projection.display.orderedItems.map((entry) => ({
      ...entry,
      payload: replacementsById.get(entry.itemId) ?? entry.payload,
    })),
    turns: projectedTurns.map(({ id, turnIndex }) => ({ turnId: id, turnIndex })),
    virtualTail: projectedTurns.flatMap((turn) => (
      (virtualItemsByTurnId.get(turn.id) ?? []).map((payload) => ({ payload, turnId: turn.id }))
    )),
  });
  const turnHistory = projection.turnHistory.map((entry) => {
    const turn = turnsById.get(entry.turnId);
    return turn ? liveTurnHistoryEntry(turn, turn.itemTimeline) : entry;
  });
  if (isMissingActiveTail && !turnHistory.some(({ turnId }) => turnId === liveTail.id)) {
    const tail = turnsById.get(liveTail.id);
    if (tail) turnHistory.push(liveTurnHistoryEntry(tail, tail.itemTimeline));
  }

  return { ...projection, display, turnHistory, turns: projectedTurns };
}
