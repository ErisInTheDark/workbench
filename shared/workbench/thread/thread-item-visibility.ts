/*
 * Exports:
 * - isThreadItemVisible: exclude accidental Claude prose/thinking from presentation, preserving internal evidence.
 */

export function isThreadItemVisible(
  harness: string,
  item: { type: string; phase?: string | null },
): boolean {
  // ClaudeTranscriptAdapter assigns commentary only to exact mcp__user__message input,
  // never to ordinary assistant text, regardless of what channel or prose it represents.
  return harness !== "claude"
    || (item.type !== "reasoning" && (item.type !== "agentMessage" || item.phase === "commentary"));
}
