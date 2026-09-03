/*
 * No production exports. Tests protect composer draft hydration, edit, save, failure, and thread-switch invariants. Keywords: composer, draft, lifecycle, regression.
 */
import assert from "node:assert/strict";
import test from "node:test";

import ThreadComposerDraftSyncController from "./ThreadComposerDraftSyncController";

test("hydration does not become an edit and durable drafts cannot replace edited input", () => {
  const controller = new ThreadComposerDraftSyncController("thread-a", "thread-a:1");

  assert.equal(controller.beginSave(), null);
  assert.equal(controller.acceptHydration("thread-a", "thread-a:2"), true);
  controller.noteEdit();
  assert.equal(controller.acceptHydration("thread-a", "thread-a:3"), false);
  const save = controller.beginSave();
  assert.deepEqual(save, { generation: 1, threadId: "thread-a" });
  assert.ok(save);
  controller.completeSave(save);
  assert.equal(controller.beginSave(), null);
  assert.equal(controller.acceptHydration("thread-a", "thread-a:4"), false);
});

test("save success clears only its generation and failure leaves input dirty", () => {
  const controller = new ThreadComposerDraftSyncController("thread-a", "thread-a:1");
  controller.noteEdit();
  const firstSave = controller.beginSave();
  assert.ok(firstSave);
  controller.noteEdit();
  controller.completeSave(firstSave);
  assert.deepEqual(controller.beginSave(), { generation: 2, threadId: "thread-a" });

  const failedSave = controller.beginSave();
  assert.ok(failedSave);
  assert.deepEqual(controller.beginSave(), failedSave);
});

test("thread switches reset lifecycle truth and late saves cannot clear the new thread", () => {
  const controller = new ThreadComposerDraftSyncController("thread-a", "thread-a:1");
  controller.noteEdit();
  const oldSave = controller.beginSave();
  assert.ok(oldSave);

  assert.equal(controller.acceptHydration("thread-b", "thread-b:4"), true);
  controller.noteEdit();
  controller.completeSave(oldSave);
  assert.deepEqual(controller.beginSave(), { generation: 1, threadId: "thread-b" });
  controller.completeSubmission("thread-b");
  assert.equal(controller.beginSave(), null);
});
