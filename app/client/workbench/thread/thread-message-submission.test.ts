/*
 * Exports:
 * - No production exports; Node tests cover composer admission commit, silent cancellation, and visible failure. Keywords: composer, draft, admission, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runThreadComposerSubmission, ThreadMessageNotSentError } from "./thread-message-submission.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("unresolved admission does not commit or restore the durable draft", async () => {
  const events: string[] = [];
  const admission = deferred();
  const started = deferred();
  const submission = runThreadComposerSubmission({
    clearDurableDraft: () => { events.push("clear"); },
    preserveDurableDraft: () => { events.push("preserve"); },
    restoreLocalInput: () => { events.push("restore"); },
    send: () => { started.resolve(); return admission.promise; },
    showError: (message) => { events.push(`error:${message}`); },
  });
  await started.promise;
  assert.deepEqual(events, ["preserve"]);
  admission.resolve();
  assert.equal(await submission, true);
});

test("acknowledged admission commits durable draft deletion", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => { events.push("clear"); },
    preserveDurableDraft: () => { events.push("preserve"); },
    restoreLocalInput: () => events.push("restore"),
    send: async () => { events.push("send"); },
    showError: (message) => events.push(`error:${message}`),
  }), true);
  assert.deepEqual(events, ["preserve", "send", "clear"]);
});

test("expected not-sent cancellation restores silently", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => { events.push("clear"); },
    preserveDurableDraft: () => { events.push("preserve"); },
    restoreLocalInput: () => events.push("restore"),
    send: async () => { throw new ThreadMessageNotSentError(); },
    showError: (message) => events.push(`error:${message}`),
  }), false);
  assert.deepEqual(events, ["preserve", "restore"]);
});

test("real failure restores and remains visible", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => { events.push("clear"); },
    preserveDurableDraft: () => { events.push("preserve"); },
    restoreLocalInput: () => events.push("restore"),
    send: async () => { throw new Error("transport failed"); },
    showError: (message) => events.push(`error:${message}`),
  }), false);
  assert.deepEqual(events, ["preserve", "restore", "error:transport failed"]);
});

test("preservation completes before admission starts", async () => {
  const preservation = deferred();
  let sent = false;
  const submission = runThreadComposerSubmission({
    clearDurableDraft: () => {},
    preserveDurableDraft: () => preservation.promise,
    restoreLocalInput: () => {},
    send: async () => { sent = true; },
    showError: () => {},
  });
  assert.equal(sent, false);
  preservation.resolve();
  assert.equal(await submission, true);
});

test("preservation failure retains input without sending", async () => {
  let restored = false;
  let sent = false;
  let error = "";
  const result = await runThreadComposerSubmission({
    clearDurableDraft: () => { assert.fail("an unsent draft must not be cleared"); },
    preserveDurableDraft: () => { throw new Error("save failed"); },
    restoreLocalInput: () => { restored = true; },
    send: async () => { sent = true; },
    showError: (message) => { error = message; },
  });
  assert.equal(result, false);
  assert.equal(restored, true);
  assert.equal(sent, false);
  assert.match(error, /save failed/u);
});

test("cleanup failure after admission reports success without restoring sendable input", async () => {
  let restored = false;
  let error = "";
  const result = await runThreadComposerSubmission({
    clearDurableDraft: () => { throw new Error("cleanup failed"); },
    preserveDurableDraft: () => {},
    restoreLocalInput: () => { restored = true; },
    send: async () => {},
    showError: (message) => { error = message; },
  });
  assert.equal(result, true);
  assert.equal(restored, false);
  assert.match(error, /cleanup failed/u);
});
