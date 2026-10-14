/* No production exports. Tests protect which thread states owe the post-compaction recall directive. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { awaitsClaudeCompactionRecall } from "./claude-compaction-recall";

const compaction = (status: "inProgress" | "completed" | "failed"): ThreadItem => ({ type: "contextCompaction", id: `compaction-${status}`, status });
const reply: ThreadItem = { type: "agentMessage", id: "reply", text: "done" } as ThreadItem;
const thread = (...turns: ThreadItem[][]) => ({ turns: turns.map(items => ({ items })) });

test("only a completed compaction that nothing has followed owes the recall directive", () => {
  assert.equal(awaitsClaudeCompactionRecall(thread([reply, compaction("completed")])), true);
  assert.equal(awaitsClaudeCompactionRecall(thread([compaction("completed"), reply])), false);
  assert.equal(awaitsClaudeCompactionRecall(thread([compaction("completed")], [reply])), false);
  assert.equal(awaitsClaudeCompactionRecall(thread([reply, compaction("failed")])), false);
  assert.equal(awaitsClaudeCompactionRecall(thread([reply, compaction("inProgress")])), false);
  assert.equal(awaitsClaudeCompactionRecall(thread()), false);
});
