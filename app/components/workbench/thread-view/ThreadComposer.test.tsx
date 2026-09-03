/*
 * No production exports. Tests protect stop control visibility for active turns and persisted questionnaires. Keywords: composer, stop, questionnaire, lifecycle, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getThreadComposerStopControlState } from "./thread-composer-controls";

test("persisted questionnaires keep stop visible and enabled after their turn ends", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: true,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
  }), { disabled: false, visible: true });
});

test("idle composers without questionnaires do not show stop", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: false,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
  }), { disabled: true, visible: false });
});
