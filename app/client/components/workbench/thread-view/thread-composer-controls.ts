/*
 * Exports:
 * - getThreadComposerEnterAction: distinguish draft creation shortcuts from newline and composition input.
 * - getThreadComposerStopControlState: derive snooze/stop action, visibility, and availability.
 */

export function getThreadComposerEnterAction(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  isMobile: boolean;
  isDraft: boolean;
}): "send" | "stay" | null {
  if (input.key !== "Enter" || input.isComposing || input.isMobile) return null;
  if (!input.shiftKey) return "send";
  return input.ctrlKey && input.isDraft ? "stay" : null;
}

export function getThreadComposerStopControlState ({
  hasPendingUserInputRequest,
  isActiveThread,
  isCommentMode,
  isStopping,
  canSnooze = false,
  isApprovalBlocked = false,
  preferStop = false,
  snoozed = false,
}: {
  hasPendingUserInputRequest: boolean;
  isActiveThread: boolean;
  isCommentMode: boolean;
  isStopping: boolean;
  canSnooze?: boolean;
  isApprovalBlocked?: boolean;
  preferStop?: boolean;
  snoozed?: boolean;
}) {
  const canStop = isActiveThread || hasPendingUserInputRequest;
  const snoozeAvailable = canSnooze && !snoozed && !isApprovalBlocked;
  return {
    action: snoozeAvailable && (!preferStop || !canStop) ? "snooze" as const : "stop" as const,
    disabled: (!canStop && !snoozeAvailable) || isStopping,
    visible: !isCommentMode && (canStop || snoozeAvailable || isStopping),
  };
}
