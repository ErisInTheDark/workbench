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
  canSnoozeQuestionnaire = false,
  preferStop = false,
  snoozed = false,
}: {
  hasPendingUserInputRequest: boolean;
  isActiveThread: boolean;
  isCommentMode: boolean;
  isStopping: boolean;
  canSnoozeQuestionnaire?: boolean;
  preferStop?: boolean;
  snoozed?: boolean;
}) {
  return {
    action: !preferStop && canSnoozeQuestionnaire && hasPendingUserInputRequest && (isActiveThread || !snoozed) ? "snooze" as const : "stop" as const,
    disabled: (!isActiveThread && !hasPendingUserInputRequest) || isStopping,
    visible: !isCommentMode && (isActiveThread || hasPendingUserInputRequest || isStopping),
  };
}
