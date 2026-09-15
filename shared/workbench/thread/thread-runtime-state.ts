/*
 * Exports:
 * - hasThreadActiveFlag: detect structured or flattened active-thread flags.
 * - isThreadStatusActive: detect active thread status without requiring turns.
 * - getCurrentTurn: return the newest turn.
 * - getCurrentInProgressTurn: return the newest turn only while running.
 * - shouldPreserveLiveTurnItems: decide whether live items supplement an incoming turn.
 * - mergeTurnsPreservingLiveItems: merge turns while preserving richer live items.
 * - isCurrentTurnWaitingOnApproval: scope approval waiting to the newest running turn.
 * - hasStaleApprovalState: detect completed turns retaining an approval-wait state.
 */
import type { ThreadActiveFlag, ThreadStatus, Turn } from "./workbench-thread-turn.ts";
import type { ThreadItem } from "./workbench-thread-items.ts";

type ThreadLikeStatus = string | ThreadStatus;
type ThreadLikeTurn = { status: string };
type ThreadLike<TTurn extends ThreadLikeTurn> = {
  status: ThreadLikeStatus;
  turns: TTurn[];
};

function getTurnItemsViewRank(itemsView: Turn["itemsView"]) {
  switch (itemsView) {
    case "full":
      return 2;
    case "summary":
      return 1;
    case "notLoaded":
      return 0;
  }
}

function countStructuredTurnItems(items: ThreadItem[]) {
  return items.reduce((total, item) => {
    switch (item.type) {
      case "commandExecution":
      case "dynamicToolCall":
      case "mcpToolCall":
      case "fileChange":
      case "collabAgentToolCall":
        return total + 1;
      default:
        return total;
    }
  }, 0);
}

function isPreservableLiveTurnItem(item: ThreadItem) {
  switch (item.type) {
    case "agentMessage":
    case "reasoning":
      return true;
    case "commandExecution":
      return item.status === "inProgress";
    case "collabAgentToolCall":
    case "dynamicToolCall":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return true;
    default:
      return false;
  }
}

export function hasThreadActiveFlag(status: ThreadLikeStatus, flag: ThreadActiveFlag) {
  if (typeof status === "string") {
    const [type, activeFlags] = status.split(":", 2);
    if (type !== "active" || !activeFlags) {
      return false;
    }

    return activeFlags.split(",").includes(flag);
  }

  return status.type === "active" && status.activeFlags.includes(flag);
}

export function getCurrentTurn<TTurn extends ThreadLikeTurn>(thread: Pick<ThreadLike<TTurn>, "turns"> | null | undefined) {
  if (!thread?.turns.length) {
    return null;
  }

  return thread.turns.at(-1) ?? null;
}

export function getCurrentInProgressTurn<TTurn extends ThreadLikeTurn>(thread: Pick<ThreadLike<TTurn>, "turns"> | null | undefined) {
  const currentTurn = getCurrentTurn(thread);
  if (!currentTurn || currentTurn.status !== "inProgress") {
    return null;
  }

  return currentTurn;
}

export function isThreadStatusActive(status: ThreadLikeStatus) {
  if (typeof status === "string") {
    return status.split(":", 1)[0] === "active";
  }

  return status.type === "active";
}

export function shouldPreserveLiveTurnItems(incomingTurn: Turn, liveTurn: Turn | undefined) {
  if (!liveTurn) {
    return true;
  }

  const incomingItemsViewRank = getTurnItemsViewRank(incomingTurn.itemsView);
  const liveItemsViewRank = getTurnItemsViewRank(liveTurn.itemsView);
  if (incomingItemsViewRank !== liveItemsViewRank) {
    return incomingItemsViewRank > liveItemsViewRank;
  }

  if (incomingTurn.items.length !== liveTurn.items.length) {
    return incomingTurn.items.length > liveTurn.items.length;
  }

  const incomingStructuredItemCount = countStructuredTurnItems(incomingTurn.items);
  const liveStructuredItemCount = countStructuredTurnItems(liveTurn.items);
  if (incomingStructuredItemCount !== liveStructuredItemCount) {
    return incomingStructuredItemCount > liveStructuredItemCount;
  }

  return false;
}

export function mergeTurnsPreservingLiveItems(incomingTurns: Turn[], liveTurns: Turn[]) {
  const liveTurnsById = new Map(liveTurns.map((turn) => [turn.id, turn]));
  const knownTurnIds = new Set(incomingTurns.map((turn) => turn.id));
  let changed = false;
  const nextTurns = incomingTurns.map((turn) => {
    const liveTurn = liveTurnsById.get(turn.id);
    if (!liveTurn || shouldPreserveLiveTurnItems(turn, liveTurn)) {
      return turn;
    }

    const liveItemsById = new Map(liveTurn.items.map((item) => [item.id, item]));
    let turnChanged = false;
    const nextItems = turn.items.map((item) => {
      const liveItem = liveItemsById.get(item.id);
      if (!liveItem) {
        return item;
      }

      liveItemsById.delete(item.id);
      if (liveItem === item) {
        return item;
      }

      turnChanged = true;
      return liveItem;
    });

    const missingLiveItems = Array.from(liveItemsById.values()).filter(isPreservableLiveTurnItem);
    if (missingLiveItems.length) {
      turnChanged = true;
      nextItems.push(...missingLiveItems);
    }

    if (!turnChanged) {
      return turn;
    }

    changed = true;
    return {
      ...turn,
      items: nextItems,
    };
  });

  for (const liveTurn of liveTurns) {
    if (knownTurnIds.has(liveTurn.id)) {
      continue;
    }

    nextTurns.push(liveTurn);
    changed = true;
  }

  return changed ? nextTurns : incomingTurns;
}

export function isCurrentTurnWaitingOnApproval<TTurn extends ThreadLikeTurn>(thread: ThreadLike<TTurn> | null | undefined) {
  return !!thread
    && hasThreadActiveFlag(thread.status, "waitingOnApproval")
    && getCurrentInProgressTurn(thread) !== null;
}

export function hasStaleApprovalState<TTurn extends ThreadLikeTurn>(thread: ThreadLike<TTurn> | null | undefined) {
  return !!thread
    && hasThreadActiveFlag(thread.status, "waitingOnApproval")
    && getCurrentTurn(thread)?.status === "completed";
}
