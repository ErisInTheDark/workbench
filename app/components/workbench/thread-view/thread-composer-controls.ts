/*
 * Exports:
 * - getThreadComposerStopControlState: derive stop visibility and availability from live-turn and questionnaire ownership. Keywords: composer, stop, questionnaire, lifecycle.
 */

export function getThreadComposerStopControlState ({
  hasPendingUserInputRequest,
  isActiveThread,
  isCommentMode,
  isStopping,
}: {
  hasPendingUserInputRequest: boolean;
  isActiveThread: boolean;
  isCommentMode: boolean;
  isStopping: boolean;
}) {
  return {
    disabled: (!isActiveThread && !hasPendingUserInputRequest) || isStopping,
    visible: !isCommentMode && (isActiveThread || hasPendingUserInputRequest || isStopping),
  };
}
