/*
 * Exports:
 * - default ThreadGitArcChangeTotals: show premise totals with separately revealed dedicated-test totals.
 */
"use client";

import type { GitArcChangeTotals } from "workbench-shared/workbench/git/git-arc-change-totals";
import { FlaskConicalIcon } from "../workbench-icons";
import { ThreadFileChangeTotals } from "./ThreadFileChangeItem";

export default function ThreadGitArcChangeTotals ({ totals }: { totals: Pick<GitArcChangeTotals, "premise" | "tests"> }) {
  const hasTests = Boolean(totals.tests.additions || totals.tests.deletions);
  if (!hasTests && !totals.premise.additions && !totals.premise.deletions) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <ThreadFileChangeTotals {...totals.premise} />
      {hasTests ? (
        <span className="group/arc-tests inline-flex items-center gap-1.5">
          <button
            aria-label={`Dedicated tests: +${totals.tests.additions} -${totals.tests.deletions}`}
            className="inline-flex shrink-0 items-center rounded p-0.5 text-fg/muted hover:bg-text/5 hover:text-text focus-visible:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-current"
            data-thread-summary-action="true"
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
            }}
            type="button"
          >
            <FlaskConicalIcon size={14} />
          </button>
          <span aria-hidden="true" className="hidden group-hover/arc-tests:inline-flex group-focus-within/arc-tests:inline-flex coarse-touch:inline-flex">
            <ThreadFileChangeTotals {...totals.tests} />
          </span>
        </span>
      ) : null}
    </span>
  );
}
