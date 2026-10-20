/*
 * Exports:
 * - getThreadComposerEnterAction: distinguish send, held compact-first send and alt-send (shift-mode) shortcuts from newline
 *   and composition input.
 * - getThreadComposerStopControlState: derive settle/snooze/stop action, visibility, and availability.
 */

/** `holdsToCompact`: the plain send would compact context first, so Enter must be held to confirm it instead. */
export function getThreadComposerEnterAction(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  isMobile: boolean;
  holdsToCompact?: boolean;
}): "send" | "compactHold" | "alt" | null {
  if (input.key !== "Enter" || input.isComposing || input.isMobile) return null;
  if (!input.shiftKey) return input.holdsToCompact ? "compactHold" : "send";
  return input.ctrlKey ? "alt" : null;
}

export function getThreadComposerStopControlState ({
  hasPendingUserInputRequest,
  isActiveThread,
  isCommentMode,
  isStopping,
  canSnooze = false,
  canSettle = false,
  isApprovalBlocked = false,
  shiftKey = false,
  snoozed = false,
}: {
  hasPendingUserInputRequest: boolean;
  isActiveThread: boolean;
  isCommentMode: boolean;
  isStopping: boolean;
  canSnooze?: boolean;
  canSettle?: boolean;
  isApprovalBlocked?: boolean;
  shiftKey?: boolean;
  snoozed?: boolean;
}) {
  const canStop = isActiveThread || hasPendingUserInputRequest;
  const snoozeAvailable = canSnooze && !snoozed && !isApprovalBlocked;
  const settleAvailable = canSettle && !canStop && !isApprovalBlocked;
  const action = settleAvailable && (!shiftKey || !snoozeAvailable) ? "settle" as const
    : snoozeAvailable && (!shiftKey || !canStop) ? "snooze" as const : "stop" as const;
  return {
    action,
    disabled: (!canStop && !snoozeAvailable && !settleAvailable) || isStopping,
    visible: !isCommentMode && (canStop || snoozeAvailable || settleAvailable || isStopping),
  };
}
