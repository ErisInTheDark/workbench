/*
 * Exports:
 * - default ThreadCard: a transcript card: one step-row line (icon, label and subject or a custom summary, meta and progress)
 *   inside a bordered card, opening into its body; an optional preview shows under the line while the card is closed.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";

import ThreadStepRow from "./ThreadStepRow";

export default function ThreadCard({
  preview,
  ...line
}: ComponentProps<typeof ThreadStepRow> & {
  /** What the closed card summarises; opening the card replaces it with the body. */
  preview?: ReactNode;
}) {
  return (
    <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2 px-2.5" data-thread-card="true">
      <ThreadStepRow {...line} />
      {preview ? <div className="pb-1.5 [details[open]+&]:hidden">{preview}</div> : null}
    </article>
  );
}
