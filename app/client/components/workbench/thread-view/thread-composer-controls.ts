/*
 * Exports:
 * - getThreadComposerStopControlState: derive snooze/stop action, visibility, and availability from live-turn and questionnaire ownership. Keywords: composer, snooze, stop, questionnaire, lifecycle.
 */

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
