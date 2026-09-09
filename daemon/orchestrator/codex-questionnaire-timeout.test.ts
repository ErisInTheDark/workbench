/*
 * Keywords: Codex, MCP, timeout, questionnaire.
 * Exports: none. Tests protect exact provider deadline admission.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getCodexQuestionnaireTimeout } from "./codex-questionnaire-timeout";

const item = {
  type: "mcpToolCall", server: "wb", tool: "request_user_input", status: "failed",
  error: { message: "tool call error: timed out awaiting tools/call after 21600s" },
};
const notification = { method: "item/completed", params: { threadId: "thread", turnId: "turn", item } };
const wrappedTimeout = "tool call error: tool call failed for `wb/request_user_input`\n\nCaused by:\n    timed out awaiting tools/call after 21600s";

test("recorded Codex error chains admit the questionnaire deadline with either line ending", () => {
  for (const message of [wrappedTimeout, wrappedTimeout.replaceAll("\n", "\r\n")]) {
    assert.deepEqual(getCodexQuestionnaireTimeout({
      ...notification, params: { ...notification.params, item: { ...item, error: { message } } },
    }), { threadId: "thread", turnId: "turn" });
  }
});

test("provider questionnaire deadlines identify their owning turn without depending on extra item fields", () => {
  assert.deepEqual(getCodexQuestionnaireTimeout(notification), { threadId: "thread", turnId: "turn" });
  assert.deepEqual(getCodexQuestionnaireTimeout({
    ...notification, params: { ...notification.params, item: { ...item, id: "call", error: { message: "timed out awaiting tools/call after 21600s" } } },
  }), { threadId: "thread", turnId: "turn" });
});

test("unrelated failures, tools, events and malformed ownership never interrupt a questionnaire", () => {
  for (const otherItem of [
    { ...item, server: "other" }, { ...item, tool: "shell" }, { ...item, status: "completed" },
    { ...item, type: "agentMessage" }, { ...item, error: null },
    { ...item, error: { message: "connection closed" } },
    { ...item, error: { message: "timed out awaiting initialize after 30s" } },
    { ...item, error: { message: "example: timed out awaiting tools/call after 21600s" } },
    { ...item, error: { message: wrappedTimeout.replace("wb/request_user_input", "wb/shell") } },
    { ...item, error: { message: wrappedTimeout.replace("timed out awaiting tools/call after 21600s", "connection closed") } },
    { ...item, error: { message: wrappedTimeout.replace("    timed out", "    example: timed out") } },
    { ...item, error: { message: `quoted failure:\n${wrappedTimeout}` } },
  ]) assert.equal(getCodexQuestionnaireTimeout({ ...notification, params: { ...notification.params, item: otherItem } }), null);
  assert.equal(getCodexQuestionnaireTimeout({ ...notification, method: "item/started" }), null);
  assert.equal(getCodexQuestionnaireTimeout({ ...notification, params: { ...notification.params, turnId: "" } }), null);
  assert.equal(getCodexQuestionnaireTimeout({ method: "item/completed", params: null }), null);
});
