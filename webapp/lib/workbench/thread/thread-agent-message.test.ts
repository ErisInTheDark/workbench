/*
 * No production exports. Tests protect attributed cross-agent message creation and parsing from thread inputs. Keywords: agent, message, attribution, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchAgentMessageText,
  readWorkbenchAgentMessageInput,
  readWorkbenchAgentMessageText,
} from "./thread-agent-message.ts";

test("agent messages retain sender attribution behind an explanatory prelude", () => {
  const text = createWorkbenchAgentMessageText({
    message: "status <ready>",
    senderName: "Mimi & Co",
    senderThreadId: "child-1",
  });

  assert.match(text, /^Notice: Agent "Mimi & Co" has sent you a message\./u);
  assert.match(text, /<wb:agent-message from="Mimi &amp; Co" thread="child-1">/u);
  assert.deepEqual(readWorkbenchAgentMessageText(text), {
    message: "status <ready>",
    senderName: "Mimi & Co",
    senderThreadId: "child-1",
  });
  assert.deepEqual(readWorkbenchAgentMessageInput([{
    text,
    text_elements: [],
    type: "text",
  }]), readWorkbenchAgentMessageText(text));
});

test("agent messages reject malformed or incomplete envelopes", () => {
  assert.equal(readWorkbenchAgentMessageText("ordinary user text"), null);
  assert.equal(readWorkbenchAgentMessageText("<wb:agent-message from=\"Mimi\" thread=\"child\">\n\n</wb:agent-message>"), null);
  assert.equal(readWorkbenchAgentMessageText("<wb:agent-message thread=\"child\" from=\"Mimi\">\nhello\n</wb:agent-message>"), null);
  assert.throws(
    () => createWorkbenchAgentMessageText({ message: " ", senderName: "Mimi", senderThreadId: "child" }),
    /Agent message is required/u,
  );
});
