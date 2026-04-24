/*
 * Exports:
 * - hasThreadActiveFlag: detect structured or flattened active-thread flags. Keywords: thread status, active flag, approval.
 * - getCurrentTurn: return the newest turn in a thread. Keywords: current turn, latest turn, ordering.
 * - getCurrentInProgressTurn: return the newest turn only when it is still running. Keywords: in progress, active turn.
 * - isCurrentTurnWaitingOnApproval: scope waiting-on-approval to the newest in-progress turn. Keywords: waitingOnApproval, current turn.
 * - hasStaleApprovalState: detect visible thread snapshots whose latest turn is complete while the thread still reports waitingOnApproval. Keywords: stale session, broken state, waitingOnApproval.
 */
import type { Thread } from "./generated/app-server/v2/Thread";
import type { ThreadActiveFlag } from "./generated/app-server/v2/ThreadActiveFlag";

type ThreadLikeStatus = string | Thread["status"];
type ThreadLikeTurn = { status: string };
type ThreadLike<TTurn extends ThreadLikeTurn> = {
  status: ThreadLikeStatus;
  turns: TTurn[];
};

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
