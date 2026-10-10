/*
 * Exports:
 * - default ThreadVisUserEndedItem: the transcript note for a vis session the user ended from its card; only the user sees it.
 */
"use client";

import type { VisUserEnded } from "workbench-shared/workbench/vis/vis-contract";
import { DisclosureStaticRow } from "../../ui/Disclosure";

export default function ThreadVisUserEndedItem({ ended }: { ended: VisUserEnded }) {
  return (
    <DisclosureStaticRow
      summary={(
        <span className="flex min-w-0 items-center gap-1.5 text-[0.92em] leading-[1.6]">
          <span className="shrink-0">You ended vis on</span>
          <span className="min-w-0 truncate font-mono text-[0.92em] text-text">{ended.path}</span>
          <span className="shrink-0 rounded-full bg-fg/6 px-2 text-[0.72em]" title="Only you see this; the agent was not told">only visible to you</span>
        </span>
      )}
    />
  );
}
