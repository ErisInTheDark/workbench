/*
 * Keywords: codex, context, recovery, ownership.
 * No production exports. Tests protect retained measurement selection and malformed evidence isolation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCodexContextUsage, recoverCodexContextUsage } from "./codex-thread-context-usage";
import type { CodexTranscriptRawEvent } from "./codex-transcript-types";

function event(receivedAt: number, threadId = "thread"): CodexTranscriptRawEvent {
  return {
    id: String(receivedAt), method: "thread/tokenUsage/updated", receivedAt, requestId: null,
    source: "upstream-notification",
    payload: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId, turnId: "turn",
        tokenUsage: {
          last: { inputTokens: receivedAt, outputTokens: 2, totalTokens: receivedAt + 2, cachedInputTokens: 1, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          total: { inputTokens: receivedAt * 10, outputTokens: 20, totalTokens: receivedAt * 10 + 20, cachedInputTokens: 10, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          modelContextWindow: 1000,
        },
      },
    },
  };
}

test("context recovery selects the newest measurement rather than cumulative accounting", () => {
  const recovered = recoverCodexContextUsage("thread", [event(20), event(10)], () => assert.fail("valid evidence rejected"));
  assert.equal(recovered?.last.inputTokens, 20);
  assert.equal(recovered?.total.inputTokens, 200);
  assert.equal(recovered?.modelContextWindow, 1000);
});

test("context recovery reports malformed and foreign evidence without losing a usable sample", () => {
  let warnings = 0;
  const malformed = { ...event(30), payload: { method: "thread/tokenUsage/updated", params: { threadId: "thread", tokenUsage: { last: "private" } } } };
  const recovered = recoverCodexContextUsage("thread", [event(10), malformed, event(40, "foreign")], () => warnings++);
  assert.equal(recovered?.last.inputTokens, 10);
  assert.equal(warnings, 2);
  assert.equal(recoverCodexContextUsage("thread", [], () => assert.fail()), null);
});

test("live context admission rejects a mismatched thread instead of borrowing its measurement", () => {
  assert.throws(() => readCodexContextUsage("thread", {
    method: "thread/tokenUsage/updated", params: { threadId: "foreign", tokenUsage: {} },
  }));
});
