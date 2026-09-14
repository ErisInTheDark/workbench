/*
 * No production exports. Tests protect the durable transcript boundary from provider-live presentation churn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { shouldRecordDurableTranscriptNotification } from "./codex-transcript-event-routing";

test("provider-live presentation updates do not enter durable transcript recording", () => {
  for (const method of [
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "turn/diff/updated",
  ]) {
    assert.equal(shouldRecordDurableTranscriptNotification(method), false, method);
  }
});

test("semantic lifecycle boundaries remain durable transcript facts", () => {
  for (const method of [
    "thread/started",
    "thread/tokenUsage/updated",
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
    "serverRequest/resolved",
  ]) {
    assert.equal(shouldRecordDurableTranscriptNotification(method), true, method);
  }
});
