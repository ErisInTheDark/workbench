/*
 * Exports:
 * - CLAUDE_COMPACTION_RECALL_CONTEXT: agent-facing directive that overrides Claude Code's "resume directly" summary tail.
 * - awaitsClaudeCompactionRecall: detect a Workbench compaction nothing has followed yet, so the next prompt carries the directive.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

export const CLAUDE_COMPACTION_RECALL_CONTEXT = [
  "Context was compacted. Workbench overrides the summary's \"resume directly\" instruction:",
  "your FIRST tool call must be `mcp__wb__thread_recall` with no kinds filter.",
  "Follow each emitted `--before` cursor backward until the newest user request's discussion, the last approved plan, and every later addendum are visible.",
  "Recall search or filtered pages do not count. Only then act on the summary or any new message.",
].join(" ");

export function awaitsClaudeCompactionRecall(thread: { turns: readonly { items: readonly ThreadItem[] }[] }) {
  const latest = thread.turns.at(-1)?.items.at(-1);
  return latest?.type === "contextCompaction" && latest.status === "completed";
}
