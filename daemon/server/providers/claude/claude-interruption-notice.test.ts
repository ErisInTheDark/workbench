/* No production exports. Tests protect which thread states owe the interruption-placeholder notice. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnStatus } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { followsClaudeInterruption } from "./claude-interruption-notice";

const thread = (...statuses: TurnStatus[]) => ({ turns: statuses.map(status => ({ status })) });

test("only the prompt right after an interrupted turn owes the interruption notice", () => {
  assert.equal(followsClaudeInterruption(thread("completed", "interrupted")), true);
  assert.equal(followsClaudeInterruption(thread("interrupted", "completed")), false);
  assert.equal(followsClaudeInterruption(thread("completed", "failed")), false);
  assert.equal(followsClaudeInterruption(thread("completed")), false);
  assert.equal(followsClaudeInterruption(thread()), false);
});
