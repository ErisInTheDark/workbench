/*
 * No production exports. Protect composer shortcuts and settle/snooze/stop availability.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getQuestionnaireEnterAction, getThreadComposerEnterAction, getThreadComposerStopControlState } from "./thread-composer-controls";

test("enter shortcuts distinguish sending, alt-sending and inserting a newline", () => {
  const input = { key: "Enter", shiftKey: false, ctrlKey: false, isComposing: false, isMobile: false };
  assert.equal(getThreadComposerEnterAction(input), "send");
  assert.equal(getThreadComposerEnterAction({ ...input, ctrlKey: true }), "send");
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true }), null);
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true, ctrlKey: true }), "alt");
  for (const blocked of [{ isComposing: true }, { isMobile: true }, { key: "Escape" }]) {
    assert.equal(getThreadComposerEnterAction({ ...input, ...blocked }), null);
    assert.equal(getThreadComposerEnterAction({ ...input, ...blocked, shiftKey: true, ctrlKey: true }), null);
    assert.equal(getThreadComposerEnterAction({ ...input, ...blocked, holdsToCompact: true }), null);
  }
});

test("a compact-first send must be held, while newline and the compaction-skipping alt-send stay immediate", () => {
  const input = { key: "Enter", shiftKey: false, ctrlKey: false, isComposing: false, isMobile: false, holdsToCompact: true };
  assert.equal(getThreadComposerEnterAction(input), "compactHold");
  assert.equal(getThreadComposerEnterAction({ ...input, ctrlKey: true }), "compactHold");
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true }), null);
  assert.equal(getThreadComposerEnterAction({ ...input, shiftKey: true, ctrlKey: true }), "alt");
});

test("a compact-first questionnaire answer must be held like a compact-first send", () => {
  const input = { key: "Enter", modified: false, isComposing: false, isMobile: false, holdsToCompact: false };
  assert.equal(getQuestionnaireEnterAction(input), "submit");
  assert.equal(getQuestionnaireEnterAction({ ...input, holdsToCompact: true }), "compactHold");
  for (const blocked of [{ modified: true }, { isComposing: true }, { isMobile: true }, { key: "a" }]) {
    assert.equal(getQuestionnaireEnterAction({ ...input, ...blocked }), null);
    assert.equal(getQuestionnaireEnterAction({ ...input, ...blocked, holdsToCompact: true }), null);
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
    shiftKey: true,
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

test("completed composers prefer settlement and shift selects available snooze", () => {
  const completed = {
    hasPendingUserInputRequest: false, isActiveThread: false, isCommentMode: false,
    isStopping: false, canSettle: true, canSnooze: true, shiftKey: false,
  };
  assert.deepEqual(getThreadComposerStopControlState(completed),
    { action: "settle", disabled: false, visible: true });
  assert.deepEqual(getThreadComposerStopControlState({ ...completed, shiftKey: true }),
    { action: "snooze", disabled: false, visible: true });
  for (const unavailable of [{ canSnooze: false }, { snoozed: true }]) {
    assert.equal(getThreadComposerStopControlState({ ...completed, ...unavailable, shiftKey: true }).action, "settle");
  }
  assert.equal(getThreadComposerStopControlState({ ...completed, canSettle: false }).action, "snooze");
  assert.equal(getThreadComposerStopControlState({ ...completed, canSettle: false, canSnooze: false }).visible, false);
  assert.equal(getThreadComposerStopControlState({ ...completed, isStopping: true }).disabled, true);
  assert.equal(getThreadComposerStopControlState({ ...completed, isCommentMode: true }).visible, false);
});

test("idle snooze never becomes stop through shift and unavailable snooze stays hidden", () => {
  const idle = { hasPendingUserInputRequest: false, isActiveThread: false, isCommentMode: false, isStopping: false, shiftKey: true };
  assert.deepEqual(getThreadComposerStopControlState({ ...idle, canSnooze: true }),
    { action: "snooze", disabled: false, visible: true });
  for (const unavailable of [{ canSnooze: false }, { canSnooze: true, snoozed: true }]) {
    assert.equal(getThreadComposerStopControlState({ ...idle, ...unavailable }).visible, false);
  }
  assert.equal(getThreadComposerStopControlState({
    ...idle, isActiveThread: true, shiftKey: false, canSnooze: true, isApprovalBlocked: true,
  }).action, "stop");
});
