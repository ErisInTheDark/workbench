/*
 * Exports:
 * - hasThreadActiveFlag/isThreadStatusActive: WB thread status readers.
 * - getCurrentTurn/getCurrentInProgressTurn: WB current turn readers.
 * - shouldPreserveLiveTurnItems/mergeTurnsPreservingLiveItems: WB live item preservation.
 * - isCurrentTurnWaitingOnApproval/hasStaleApprovalState: WB approval-state readers.
 */
export {
  hasThreadActiveFlag, isThreadStatusActive, getCurrentTurn, getCurrentInProgressTurn,
  shouldPreserveLiveTurnItems, mergeTurnsPreservingLiveItems,
  isCurrentTurnWaitingOnApproval, hasStaleApprovalState,
} from "../workbench/thread/thread-runtime-state.ts";
