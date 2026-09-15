/*
 * Exports:
 * - normalizeThreadItems/mergeThreadItem/reconcileCompleteThreadItems: compatible access to WB normalization.
 * - isSupportedWorkbenchTranscriptItem/areUserInputsEquivalentForUserMessageDedupe: WB content admission and equality.
 * - ReconciledCompleteThreadItem: WB reconciliation result.
 */
export {
  normalizeThreadItems,
  mergeThreadItem,
  reconcileCompleteThreadItems,
  isSupportedWorkbenchTranscriptItem,
  areUserInputsEquivalentForUserMessageDedupe,
  type ReconciledCompleteThreadItem,
} from "../workbench/thread/thread-item-normalization.ts";
