/*
 * Exports:
 * - inlineMentionMarkBaseClassName: shared base class for inline skill and file mention marks. Keywords: mention, highlight, classes.
 * - getInlineMentionMarkToneClassName: return skill or file tone classes for inline mention marks. Keywords: mention, tone, skill, file.
 * - getInlineMentionMarkClassName: build complete inline mention mark classes. Keywords: mention, highlight, reusable.
 * - getInlineMentionOverlayClassName: build overlay pseudo-element mention highlight classes. Keywords: plaintext, overlay, highlight.
 */

import type { InlineMentionCandidateKind } from "./inline-mention-highlights";

export const inlineMentionMarkBaseClassName = [
  "ring-1 ring-inset",
].join(" ");

export function getInlineMentionMarkToneClassName(kind: InlineMentionCandidateKind) {
  return kind === "skill"
    ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]"
    : "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] ring-[color-mix(in_srgb,var(--success)_24%,transparent)]";
}

export function getInlineMentionMarkClassName(kind: InlineMentionCandidateKind) {
  return `${inlineMentionMarkBaseClassName} ${getInlineMentionMarkToneClassName(kind)}`;
}

export function getInlineMentionOverlayClassName(kind: InlineMentionCandidateKind) {
  return [
    "relative isolate",
    "before:absolute before:inset-x-[-0.12em] before:inset-y-[-0.04em]",
    "before:rounded-[0.28em] before:ring-1 before:ring-inset before:content-['']",
    kind === "skill"
      ? "before:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] before:ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]"
      : "before:bg-[color-mix(in_srgb,var(--success)_14%,transparent)] before:ring-[color-mix(in_srgb,var(--success)_24%,transparent)]",
  ].join(" ");
}
