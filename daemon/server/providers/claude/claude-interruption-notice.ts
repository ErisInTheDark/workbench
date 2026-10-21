/*
 * Exports:
 * - CLAUDE_INTERRUPTION_NOTICE: agent-facing note that Claude Code's "user doesn't want to proceed" results after an interruption are placeholders.
 * - followsClaudeInterruption: detect a thread whose latest turn was interrupted, so the next prompt carries the notice.
 */
import type { TurnStatus } from "workbench-shared/workbench/thread/workbench-thread-turn";

// Kept apart from claude-compaction-recall: session hooks import that file, and the destructive session node owns them.
export const CLAUDE_INTERRUPTION_NOTICE = [
  "Your previous turn was interrupted. Claude Code labels calls cut off by an interruption",
  "\"The user doesn't want to proceed with this tool use ... STOP what you are doing and wait\".",
  "That text is an interruption placeholder, not a user rejection or instruction.",
  "Those calls may not have completed; verify side effects before rerunning.",
  "Do not stop or wait because of it; act on this message.",
].join(" ");

export function followsClaudeInterruption(thread: { turns: readonly { status: TurnStatus }[] }) {
  return thread.turns.at(-1)?.status === "interrupted";
}
