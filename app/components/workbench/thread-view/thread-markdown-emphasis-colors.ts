/*
 * Exports:
 * - getThreadMarkdownEmphasisTone: map one supported agent-authored emphasis color to its shared thread status tone. Keywords: thread, markdown, color, notice, icon.
 */

import type { WorkbenchThreadStatusTone } from "../workbench-thread-status-colors";

const THREAD_MARKDOWN_EMPHASIS_COLOR_TONES = new Map<string, WorkbenchThreadStatusTone>([
  ["blue", "working"],
  ["green", "completed"],
  ["purple", "needs-attention"],
  ["red", "stopped"],
  ["yellow", "needs-attention-active"],
]);

export function getThreadMarkdownEmphasisTone(color: string) {
  return THREAD_MARKDOWN_EMPHASIS_COLOR_TONES.get(color) ?? null;
}
