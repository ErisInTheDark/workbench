/*
 * No production exports. Tests protect snooze/stop availability for live turns and saved questionnaires. Keywords: composer, snooze, stop, questionnaire, lifecycle, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getThreadComposerStopControlState } from "./thread-composer-controls";

test("snoozed questionnaires offer stop only after interruption finishes", () => {
  for (const isActiveThread of [true, false]) {
    const state = getThreadComposerStopControlState({
      hasPendingUserInputRequest: true,
      isActiveThread,
      isCommentMode: false,
      isStopping: false,
      canSnoozeQuestionnaire: true,
      snoozed: true,
    });
    assert.equal(state.action, isActiveThread ? "snooze" : "stop");
    assert.equal(state.disabled, false);
  }
});

test("unsnoozed saved questionnaires can be snoozed without a live turn", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: true,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
    canSnoozeQuestionnaire: true,
    snoozed: false,
  }), { action: "snooze", disabled: false, visible: true });
});

test("idle composers without questionnaires do not show stop", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: false,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
  }), { action: "stop", disabled: true, visible: false });
});
