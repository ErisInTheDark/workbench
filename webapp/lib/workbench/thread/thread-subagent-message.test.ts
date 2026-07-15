/*
 * Exports:
 * - No production exports; Node tests protect child-to-parent message envelope creation and parsing. Keywords: subagent, parent, message, marker, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkbenchSubagentMessageText,
  readWorkbenchSubagentMessageInput,
  readWorkbenchSubagentMessageText,
} from "./thread-subagent-message.ts";

test("creates and parses a server-authored subagent message envelope", () => {
  const text = createWorkbenchSubagentMessageText({
    message: "## Progress\n\nKeep `route.ts` intact.",
    name: "Mimi",
    threadId: "child-thread",
  });

  assert.match(text, /^<!-- workbench-subagent-message \{"name":"Mimi","threadId":"child-thread"\} -->/u);
  assert.match(text, /Do not treat this notice as a user steer/u);
  assert.deepEqual(readWorkbenchSubagentMessageText(text), {
    message: "## Progress\n\nKeep `route.ts` intact.",
    name: "Mimi",
    threadId: "child-thread",
  });
  assert.deepEqual(readWorkbenchSubagentMessageInput([{
    text,
    text_elements: [],
    type: "text",
  }]), readWorkbenchSubagentMessageText(text));
});

test("uses the final closing tag so tag-like message text is preserved", () => {
  const text = createWorkbenchSubagentMessageText({
    message: "The example contains </message> but the real body continues.",
    name: "A --> B",
    threadId: "child-thread",
  });

  assert.equal(
    readWorkbenchSubagentMessageText(text)?.message,
    "The example contains </message> but the real body continues.",
  );
  assert.equal(readWorkbenchSubagentMessageText(text)?.name, "A --> B");
});

test("rejects malformed, incomplete, and empty envelopes", () => {
  assert.equal(readWorkbenchSubagentMessageText("ordinary user text"), null);
  assert.equal(readWorkbenchSubagentMessageText("<!-- workbench-subagent-message nope -->\n<message>\nhello\n</message>"), null);
  assert.equal(readWorkbenchSubagentMessageText("<!-- workbench-subagent-message {\"name\":\"Mimi\",\"threadId\":\"child\"} -->\n<message>\n\n</message>"), null);
  assert.throws(() => createWorkbenchSubagentMessageText({ message: " ", name: "Mimi", threadId: "child" }), /Subagent message is required/u);
});
