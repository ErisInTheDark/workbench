/*
 * No exports. Tests protect live context measurement ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCodexContextUsage } from "./codex-thread-context-usage";

test("live context admission rejects a mismatched thread instead of borrowing its measurement", () => {
  assert.throws(() => readCodexContextUsage("thread", {
    method: "thread/tokenUsage/updated", params: { threadId: "foreign", tokenUsage: {} },
  }));
});
