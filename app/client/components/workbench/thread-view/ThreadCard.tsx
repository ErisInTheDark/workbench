/*
 * Exports:
 * - default ThreadCard: a transcript card: one step-row line (icon, label and subject or a custom summary, meta and progress)
 *   inside a bordered card, opening into its body; an optional preview shows under the line while the card is closed.
 * - ThreadCardGroup: back-to-back cards stitched into one bordered card, each keeping its own line and body.
 */
"use client";

import { Children, createContext, Fragment, useContext, type ComponentProps, type ReactNode } from "react";

import ThreadStepRow from "./ThreadStepRow";

const FRAME_CLASS = "my-1.5 w-full rounded-[0.45rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2";

/** Inside a group, the group draws the one frame. */
const ThreadCardGroupContext = createContext(false);

export function ThreadCardGroup({ children }: { children: ReactNode }) {
  return (
    <div className={FRAME_CLASS} data-thread-card-group="true">
      <ThreadCardGroupContext.Provider value>
        {Children.toArray(children).map((child, index) => (
          <Fragment key={index}>
            {/* Quiet and inset, so the halves read as one card. */}
            {index ? <div aria-hidden="true" className="mx-2.5 h-px bg-[color-mix(in_srgb,var(--text)_6%,transparent)]" /> : null}
            {child}
          </Fragment>
        ))}
      </ThreadCardGroupContext.Provider>
    </div>
  );
}

export default function ThreadCard({
  preview,
  ...line
}: ComponentProps<typeof ThreadStepRow> & {
  /** What the closed card summarises; opening the card replaces it with the body. */
  preview?: ReactNode;
}) {
  const grouped = useContext(ThreadCardGroupContext);
  return (
    <article
      // A card's line keeps its own room even inside a packed list of step rows.
      className={`${grouped ? "" : FRAME_CLASS} px-2.5 [--thread-step-row-py:initial]`}
      data-thread-card="true"
    >
      <ThreadStepRow {...line} />
      {preview ? <div className="pb-1.5 [details[open]+&]:hidden">{preview}</div> : null}
    </article>
  );
}
