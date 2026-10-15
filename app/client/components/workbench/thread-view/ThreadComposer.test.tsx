/*
 * No production exports. Protect composer shortcuts and snooze/stop availability.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getThreadComposerEnterAction, getThreadComposerStopControlState } from "./thread-composer-controls";

test("draft enter shortcuts distinguish sending, staying and inserting a newline", () => {
  const input = { key: "Enter", shiftKey: false, ctrlKey: false, isComposing: false, isMobile: false, isDraft: true };
  assert.equal(getThreadComposerEnterAction(input), "send");
  assert.equal(getThreadComposerEnterAction({ ...input, ctrlKey: true }), "send");
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true }), null);
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true, ctrlKey: true }), "stay");
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true, ctrlKey: true, isDraft: false }), null);
  for (const blocked of [{ isComposing: true }, { isMobile: true }, { key: "Escape" }]) {
    assert.equal(getThreadComposerEnterAction({ ...input, ...blocked }), null);
    assert.equal(getThreadComposerEnterAction({ ...input, ...blocked, shiftKey: true, ctrlKey: true }), null);
  }
});

test("snoozed questionnaires offer stop or dismissal instead of snoozing again", () => {
  for (const isActiveThread of [true, false]) {
    const state = getThreadComposerStopControlState({
      hasPendingUserInputRequest: true,
      isActiveThread,
      isCommentMode: false,
      isStopping: false,
      canSnooze: true,
      snoozed: true,
    });
    assert.equal(state.action, "stop");
    assert.equal(state.disabled, false);
  }
});

test("unsnoozed saved questionnaires can be snoozed without a live turn", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: true,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
    canSnooze: true,
    snoozed: false,
  }), { action: "snooze", disabled: false, visible: true });
});

test("qualifying shift intent swaps questionnaire snooze for stop", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: true,
    isActiveThread: true,
    isCommentMode: false,
    isStopping: false,
    canSnooze: true,
    preferStop: true,
    snoozed: false,
  }), { action: "stop", disabled: false, visible: true });
});

test("ordinary working and idle composers offer snooze without a questionnaire", () => {
  for (const isActiveThread of [true, false]) {
    assert.deepEqual(getThreadComposerStopControlState({
      hasPendingUserInputRequest: false,
      isActiveThread,
      isCommentMode: false,
      isStopping: false,
      canSnooze: true,
    }), { action: "snooze", disabled: false, visible: true });
  }
});

test("idle composers without questionnaires do not show stop", () => {
  assert.deepEqual(getThreadComposerStopControlState({
    hasPendingUserInputRequest: false,
    isActiveThread: false,
    isCommentMode: false,
    isStopping: false,
  }), { action: "stop", disabled: true, visible: false });
});

test("idle snooze never becomes stop through shift and unavailable snooze stays hidden", () => {
  const idle = { hasPendingUserInputRequest: false, isActiveThread: false, isCommentMode: false, isStopping: false, preferStop: true };
  assert.deepEqual(getThreadComposerStopControlState({ ...idle, canSnooze: true }),
    { action: "snooze", disabled: false, visible: true });
  for (const unavailable of [{ canSnooze: false }, { canSnooze: true, snoozed: true }]) {
    assert.equal(getThreadComposerStopControlState({ ...idle, ...unavailable }).visible, false);
  }
  assert.equal(getThreadComposerStopControlState({
    ...idle, isActiveThread: true, preferStop: false, canSnooze: true, isApprovalBlocked: true,
  }).action, "stop");
});
