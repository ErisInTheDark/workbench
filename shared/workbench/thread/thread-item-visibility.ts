/*
 * Exports:
 * - isThreadItemVisible: exclude accidental Claude and OpenCode prose (and Claude thinking) from presentation, preserving internal evidence.
 */

/** Harnesses whose agents speak to the user only through commentary; their unlabelled assistant text is never shown. */
const COMMENTARY_ONLY_HARNESSES = new Set(["claude", "opencode"]);

export function isThreadItemVisible(
  harness: string,
  item: { type: string; phase?: string | null },
): boolean {
  if (harness === "claude" && item.type === "reasoning") return false;
  // ClaudeTranscriptAdapter and OpenCode adapters assign commentary only to the user-message channel,
  // never to ordinary assistant text, regardless of what channel or prose it represents.
  return !COMMENTARY_ONLY_HARNESSES.has(harness) || item.type !== "agentMessage" || item.phase === "commentary";
}
