/*
 * Exports:
 * - inlineMentionMarkBaseClassName: shared wrapping behaviour for mention marks.
 * - getInlineMentionMarkToneClassName: skill activation or displayed file-link tone.
 * - getInlineMentionMarkClassName: complete inline mention mark classes.
 * - getInlineMentionOverlayClassName: plaintext overlay mention classes.
 * - toInlineMentionOverlayHighlights: map resolved mentions to plaintext overlay ranges.
 */

import type { InlineMentionCandidateKind, InlineMentionHighlight } from "./inline-mention-highlights";
import { projectFilePathBackgroundClassName } from "../project/project-file-path";

export const inlineMentionMarkBaseClassName = [
  "[box-decoration-break:clone] [-webkit-box-decoration-break:clone]",
].join(" ");

export function getInlineMentionMarkToneClassName(kind: InlineMentionCandidateKind) {
  return kind === "skill"
    ? "ring-1 ring-inset bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]"
    : projectFilePathBackgroundClassName;
}

export function getInlineMentionMarkClassName(kind: InlineMentionCandidateKind) {
  return `${inlineMentionMarkBaseClassName} ${getInlineMentionMarkToneClassName(kind)}`;
}

export function getInlineMentionOverlayClassName(kind: InlineMentionCandidateKind) {
  return [
    getInlineMentionMarkClassName(kind),
    "rounded-[0.28em]",
    kind === "skill"
      ? "shadow-[0_0_0_0.12em_color-mix(in_srgb,var(--accent)_14%,transparent)]"
      : "shadow-[0_0_0_0.12em_color-mix(in_srgb,var(--text)_6%,transparent)]",
  ].join(" ");
}

export function toInlineMentionOverlayHighlights(highlights: readonly InlineMentionHighlight[]) {
  return highlights.map(({ end, kind, start }) => ({ className: getInlineMentionOverlayClassName(kind), end, start }));
}
