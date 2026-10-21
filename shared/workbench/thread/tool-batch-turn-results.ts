/*
 * Exports:
 * - SKIPPED_AFTER_FAILURE_TEXT/BATCH_TURN_INTERRUPTION_TEXT/QUEUED_SHELL_STEER_INTERRUPTION_TEXT: results for calls a tool batch never started.
 * - isUnstartedToolCall: a failed call whose result is only one of those notices; it matters to the agent, not the user.
 */
import type { ThreadItem } from "./workbench-thread-items.ts";

export const SKIPPED_AFTER_FAILURE_TEXT = "Skipped: an earlier call in this batch failed. Read its result, then call this again if it still applies.";
export const BATCH_TURN_INTERRUPTION_TEXT = "Interrupted before it started: a new message arrived for this thread. Read it, then call this again if it still applies.";
export const QUEUED_SHELL_STEER_INTERRUPTION_TEXT = "Queued command interrupted before it started: a new message arrived for this thread. Read it, then call shell again if it still needs to run.";

const UNSTARTED_TEXTS = [SKIPPED_AFTER_FAILURE_TEXT, BATCH_TURN_INTERRUPTION_TEXT, QUEUED_SHELL_STEER_INTERRUPTION_TEXT];

/** Providers may prefix a hook denial, so the notice only has to end the text. */
export function isUnstartedToolCall(item: ThreadItem) {
  const texts = item.type === "mcpToolCall" && item.status === "failed"
    ? [item.error?.message ?? "", ...(item.result?.content ?? []).flatMap(part => (
      part && typeof part === "object" && !Array.isArray(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
    ))]
    : item.type === "dynamicToolCall" && item.success === false
      ? (item.contentItems ?? []).flatMap(part => part.type === "inputText" ? [part.text] : [])
      : [];
  return texts.some(text => UNSTARTED_TEXTS.some(notice => text.trimEnd().endsWith(notice)));
}
