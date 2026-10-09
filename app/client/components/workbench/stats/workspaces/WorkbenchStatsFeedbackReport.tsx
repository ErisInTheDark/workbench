"use client";

/*
 * Exports:
 * - default WorkbenchStatsFeedbackReport: one selectable agent feedback report with its importance flame, and its author's profile, time, and thread in one footer row.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import ThreadMarkdown from "../../thread-view/ThreadMarkdown";
import WorkbenchRelativeTime from "../../WorkbenchRelativeTime";
import WorkbenchThreadButton from "../../WorkbenchThreadButton";
import { FlameIcon, HarnessIcon } from "../../workbench-icons";
import { feedbackImportanceTone } from "./stats-feedback-presentation";
import WorkbenchStatsFeedbackTag from "./WorkbenchStatsFeedbackTag";
import { statsThreadIdentity } from "../stats-thread-identity";

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

export default function WorkbenchStatsFeedbackReport({ item, modelName, onToggle, origin, selected }: {
  item: WorkbenchFeedbackItem;
  /** Catalogue display name, or the stored id when the catalogue does not know it. */
  modelName: string | null;
  onToggle: () => void;
  /** Where the report came from: "Workbench" or the filing project's name. */
  origin: string;
  selected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { overflowing, ref } = useClampOverflow(expanded);
  const thread = statsThreadIdentity(item);
  const importance = Math.round(item.importance * 100);
  // Links and buttons inside the card act on their own; anywhere else toggles the card's selection.
  const toggleFrom = (target: EventTarget) => {
    if (target instanceof Element && target.closest("a,button")) return;
    onToggle();
  };
  return (
    <li
      aria-selected={selected}
      className={`
        group/report cursor-pointer list-none rounded-[0.95rem] px-3 py-2.5 outline-none
        focus-visible:ring-2 focus-visible:ring-accent-soft
        ${selected ? "bg-accent-soft/60 ring-1 ring-inset ring-accent" : "hover:bg-fg/4"}
      `}
      onClick={(event) => toggleFrom(event.target)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        onToggle();
      }}
      role="option"
      tabIndex={0}
    >
      <div className="flex min-w-0 items-center gap-2 text-[0.74rem] text-fg/muted">
        <WorkbenchStatsFeedbackTag category={item.category} size="compact" />
        <span className="min-w-0 truncate">{origin}</span>
        <span
          className={`
            inline-flex shrink-0 items-center gap-1 font-semibold tabular-nums
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
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.72rem] text-fg/muted">
        {item.harness ? <HarnessIcon className="shrink-0" harness={item.harness} size={14} /> : null}
        <span className="min-w-0 shrink truncate">
          <span className="font-semibold text-text">{modelName ?? "Unknown model"}</span>
          {item.reasoningEffort ? <> <span className="font-semibold capitalize text-text">{item.reasoningEffort}</span></> : null}
        </span>
        <span aria-hidden="true">·</span>
        <WorkbenchRelativeTime className="shrink-0" timestampMs={item.createdAt} />
        <span className="ml-auto min-w-0 max-w-[60%] text-[0.8rem]">
          {thread ? (
            <WorkbenchThreadButton
              fallback={<span className="truncate text-fg/muted">{item.title || thread.threadId}</span>}
              threadId={thread.threadId}
            />
          ) : <span className="text-fg/muted">Thread removed</span>}
        </span>
      </div>
    </li>
  );
}
