/*
 * Exports:
 * - No production exports; Node tests cover composer admission commit, silent cancellation, and visible failure. Keywords: composer, draft, admission, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runThreadComposerSubmission, ThreadMessageNotSentError } from "./thread-message-submission.ts";

test("unresolved admission does not commit or restore the durable draft", async () => {
  const events: string[] = [];
  const submission = runThreadComposerSubmission({
    clearDurableDraft: () => events.push("clear"),
    preserveDurableDraft: () => events.push("preserve"),
    restoreLocalInput: () => events.push("restore"),
    send: () => new Promise<void>(() => {}),
    showError: (message) => events.push(`error:${message}`),
  });
  const marker = await Promise.race([
    submission.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 5)),
  ]);
  assert.equal(marker, "pending");
  assert.deepEqual(events, ["preserve"]);
});

test("acknowledged admission commits durable draft deletion", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => events.push("clear"),
    preserveDurableDraft: () => events.push("preserve"),
    restoreLocalInput: () => events.push("restore"),
    send: async () => { events.push("send"); },
    showError: (message) => events.push(`error:${message}`),
  }), true);
  assert.deepEqual(events, ["preserve", "send", "clear"]);
});

test("expected not-sent cancellation restores silently", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => events.push("clear"),
    preserveDurableDraft: () => events.push("preserve"),
    restoreLocalInput: () => events.push("restore"),
    send: async () => { throw new ThreadMessageNotSentError(); },
    showError: (message) => events.push(`error:${message}`),
  }), false);
  assert.deepEqual(events, ["preserve", "restore"]);
});

test("real failure restores and remains visible", async () => {
  const events: string[] = [];
  assert.equal(await runThreadComposerSubmission({
    clearDurableDraft: () => events.push("clear"),
    preserveDurableDraft: () => events.push("preserve"),
    restoreLocalInput: () => events.push("restore"),
    send: async () => { throw new Error("transport failed"); },
    showError: (message) => events.push(`error:${message}`),
  }), false);
  assert.deepEqual(events, ["preserve", "restore", "error:transport failed"]);
});
