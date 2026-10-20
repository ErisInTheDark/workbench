/*
 * Exports:
 * - default ThreadCard: a transcript card: one step-row line (icon, clipped summary, trailing meta) inside a bordered card,
 *   opening into its body; an optional preview shows under the line while the card is closed.
 */
"use client";

import type { ReactNode } from "react";

import ThreadStepRow from "./ThreadStepRow";

export default function ThreadCard({
  bodyInset,
  children,
  defaultOpen = false,
  icon,
  iconClassName,
  iconLabel,
  meta,
  preview,
  summary,
}: {
  /** Off for a body with its own row geometry, so it sits flush instead of indented under the icon. */
  bodyInset?: boolean;
  /** The body the card opens into; a card without one is a static line. */
  children?: ReactNode;
  defaultOpen?: boolean;
  icon: ReactNode;
  iconClassName?: string;
  /** Names an icon that carries meaning on its own. */
  iconLabel?: string;
  /** Trailing details: a running spinner or how long it took, never internal ids. */
  meta?: readonly ReactNode[];
  /** What the closed card summarises; opening the card replaces it with the body. */
  preview?: ReactNode;
  summary: ReactNode;
}) {
  return (
    <article className="my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2 px-2.5" data-thread-card="true">
      <ThreadStepRow bodyInset={bodyInset} defaultOpen={defaultOpen} icon={icon} iconClassName={iconClassName} iconLabel={iconLabel} meta={meta} summary={summary}>{children}</ThreadStepRow>
      {preview ? <div className="pb-1.5 [details[open]+&]:hidden">{preview}</div> : null}
    </article>
  );
}
