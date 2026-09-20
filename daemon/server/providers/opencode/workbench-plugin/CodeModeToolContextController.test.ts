/*
 * No production exports. Tests protect exact, one-use OpenCode Code Mode tool correlation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import CodeModeToolContextController, {
  WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT,
} from "./CodeModeToolContextController";

test("correlates concurrent calls independently and consumes each token once", () => {
  const contexts = new CodeModeToolContextController();
  const first: Record<string, unknown> = { query: "one" };
  const second: Record<string, unknown> = { query: "two" };
  contexts.issue(first, { callId: "call-one", sessionId: "session-one", tool: "wb_rg" });
  const secondToken = contexts.issue(second, { callId: "call-two", sessionId: "session-two", tool: "wb_rg", assistantMessageId: "assistant" });
  const firstToken = first[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];

  assert.deepEqual(contexts.consume(second), {
    callId: "call-two", sessionId: "session-two", tool: "wb_rg", assistantMessageId: "assistant", childId: secondToken,
  });
  assert.equal(WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT in second, false);
  assert.deepEqual(contexts.consume(first), {
    callId: "call-one", sessionId: "session-one", tool: "wb_rg", childId: firstToken,
  });
  assert.throws(() => contexts.consume({
    [WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT]: firstToken,
  }), /unavailable or already used/u);
});

test("releases calls that never reach the companion proxy", () => {
  const contexts = new CodeModeToolContextController();
  const input: Record<string, unknown> = {};
  contexts.issue(input, { callId: "call", sessionId: "session", tool: "wb_rg" });
  const token = input[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];
  contexts.release(input);
  assert.equal(WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT in input, false);
  assert.throws(() => contexts.consume({
    [WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT]: token,
  }), /unavailable or already used/u);
});

test("identical sibling calls share the parent but never the child token", () => {
  const owner = new CodeModeToolContextController();
  const first = { query: "same" };
  const second = { query: "same" };
  const context = { callId: "execute", sessionId: "session", tool: "wb_rg", assistantMessageId: "assistant" };
  owner.issue(first, context);
  owner.issue(second, context);
  const left = owner.consume(first)!;
  const right = owner.consume(second)!;
  assert.notEqual(left.childId, right.childId);
  assert.equal(left.callId, right.callId);
  assert.deepEqual(first, { query: "same" });
  assert.deepEqual(second, { query: "same" });
  owner.dispose();
});
