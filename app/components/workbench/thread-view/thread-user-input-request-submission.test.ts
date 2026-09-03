/*
 * No production exports. Tests protect loaded and unloaded questionnaire transcript placement. Keywords: questionnaire, submission, transcript, placement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchPendingUserInputRequest } from "workbench-shared/types";
import { buildPendingUserInputRequestSubmissionOptions } from "./thread-user-input-request-submission";

const pendingRequest = {
  harness: "codex",
  itemId: "answer",
  request: {
    id: "request",
    questions: [{ allowOther: false, header: "Choice", id: "choice", isSecret: false, options: [], question: "Choose." }],
    submitLabel: "Submit",
    summary: "",
    title: "Question",
  },
  requestKey: "questionnaire:request",
  threadId: "thread",
  turnId: "turn",
} satisfies WorkbenchPendingUserInputRequest;

function threadWithItems(items: ThreadPayload["turns"][number]["items"]) {
  return {
    harness: "codex",
    id: "thread",
    turns: [{ id: "turn", items, status: "completed" }],
  } as ThreadPayload;
}

test("unloaded questionnaire submissions preserve exact durable ids without inventing an index", () => {
  assert.deepEqual(buildPendingUserInputRequestSubmissionOptions(null, pendingRequest), {
    insertAfterItemId: "answer",
    insertAfterItemIndex: null,
    turnId: "turn",
  });
});

test("loaded questionnaire submissions resolve the requested visible item index", () => {
  const thread = threadWithItems([
    { id: "prompt", text: "Please choose.", type: "userMessage" },
    { id: "answer", text: "Working on it.", type: "agentMessage" },
  ] as ThreadPayload["turns"][number]["items"]);
  assert.deepEqual(buildPendingUserInputRequestSubmissionOptions(thread, pendingRequest), {
    insertAfterItemId: "answer",
    insertAfterItemIndex: 1,
    turnId: "turn",
  });
});

test("missing requested anchors fall back to the last meaningful transcript item", () => {
  const thread = threadWithItems([
    { id: "answer", text: "Working on it.", type: "agentMessage" },
    { id: "compaction", type: "contextCompaction" },
  ] as ThreadPayload["turns"][number]["items"]);
  const missingAnchor = { ...pendingRequest, itemId: "missing" };
  assert.deepEqual(buildPendingUserInputRequestSubmissionOptions(thread, missingAnchor), {
    insertAfterItemId: "answer",
    insertAfterItemIndex: 0,
    turnId: "turn",
  });
});
