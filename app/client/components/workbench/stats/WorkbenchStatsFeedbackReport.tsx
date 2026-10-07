"use client";

/*
 * Exports:
 * - default WorkbenchStatsFeedbackReport: one agent feedback report shaped like a thread message, with its author's profile, importance flame, and the authoring thread as a compact live thread row.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import ThreadMarkdown from "../thread-view/ThreadMarkdown";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";
import WorkbenchThreadButton from "../WorkbenchThreadButton";
import { FlameIcon, HarnessIcon } from "../workbench-icons";
import { FEEDBACK_CATEGORY_PRESENTATION, feedbackImportanceTone } from "./stats-feedback-presentation";
import { statsThreadIdentity } from "./stats-thread-identity";

/** Clamped text only offers expansion when it actually overflows at the current width. */
function useClampOverflow(expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return { overflowing, ref };
}

export default function WorkbenchStatsFeedbackReport({ item, modelName, origin }: {
  item: WorkbenchFeedbackItem;
  /** Catalogue display name, or the stored id when the catalogue does not know it. */
  modelName: string | null;
  /** Where the report came from: "Workbench" or the filing project's name. */
  origin: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { overflowing, ref } = useClampOverflow(expanded);
  const category = FEEDBACK_CATEGORY_PRESENTATION[item.category];
  const thread = statsThreadIdentity(item);
  const importance = Math.round(item.importance * 100);
  return (
    <li className="group/report list-none rounded-[0.95rem] px-3 py-2.5 hover:bg-fg/4">
      <div className="flex min-w-0 items-center gap-2 text-[0.74rem] text-fg/muted">
        <span className={`rounded-full px-2 py-px font-semibold ${category.tagClassName}`}>{category.label}</span>
        <span className="min-w-0 truncate">{origin}</span>
        <span
          className={`
            ml-auto inline-flex shrink-0 items-center gap-1 font-semibold tabular-nums
            ${feedbackImportanceTone(item.importance, item.scored)}
          `}
          title={item.scored
            ? `Importance ${importance}: weighs the author's model, reasoning effort, and the report's category`
            : `Importance ${importance}: this model is not in the trust registry yet, so it scored at the registry median`}
        >
          {item.scored ? null : <span className="font-normal">unscored model</span>}
          <FlameIcon className={item.scored ? "" : "opacity-60"} size={14} />
          {importance}
        </span>
      </div>
      <div
        className={`
          mt-1 min-w-0 text-[0.84rem] text-text [overflow-wrap:anywhere]
          ${expanded ? "" : "max-h-[6.9em] overflow-hidden"}
          ${!expanded && overflowing ? "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]" : ""}
        `}
        ref={ref}
      >
        <ThreadMarkdown markdown={item.report} projectId={item.projectId} />
      </div>
      {overflowing || expanded ? (
        <button
          className="-ml-1 rounded-md px-1 text-[0.74rem] text-fg/muted hover:bg-fg/7 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      <div className="-mx-2 mt-1 min-w-0">
        {thread ? (
          <WorkbenchThreadButton
            fallback={<span className="px-2 text-[0.8rem] text-fg/muted">{item.title || thread.threadId}</span>}
            threadId={thread.threadId}
          />
        ) : <p className="m-0 px-2 py-1 text-[0.74rem] text-fg/muted">Thread removed</p>}
      </div>
      <p className="m-0 mt-1 flex min-w-0 items-center gap-1.5 text-[0.72rem] text-fg/muted">
        {item.harness ? <HarnessIcon className="shrink-0" harness={item.harness} size={14} /> : null}
        <span className="min-w-0 truncate">
          <span className="font-semibold text-text">{modelName ?? "Unknown model"}</span>
          {item.reasoningEffort ? <> <span className="font-semibold capitalize text-text">{item.reasoningEffort}</span></> : null}
        </span>
        <span aria-hidden="true">·</span>
        <WorkbenchRelativeTime className="shrink-0" timestampMs={item.createdAt} />
      </p>
    </li>
  );
}
