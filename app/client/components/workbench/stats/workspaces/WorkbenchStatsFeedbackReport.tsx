"use client";

/*
 * Exports:
 * - WorkbenchFeedbackReportDisplay: category tag, title, and clampable report text, for stored reports and reports known only from their filing call.
 * - WorkbenchFeedbackReportBody: one stored report with its importance flame, and its author's profile, time, and optional thread in one footer row.
 * - WorkbenchFeedbackReportSkeleton: loading placeholder shaped like one report.
 * - default WorkbenchStatsFeedbackReport: one selectable report in the stats view's feedback list.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  WorkbenchFeedbackCategory,
  WorkbenchFeedbackItem,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import ThreadMarkdown from "../../thread-view/ThreadMarkdown";
import WorkbenchRelativeTime from "../../WorkbenchRelativeTime";
import WorkbenchThreadButton from "../../WorkbenchThreadButton";
import { FlameIcon, HarnessIcon } from "../../workbench-icons";
import { feedbackImportanceTone } from "./stats-feedback-presentation";
import WorkbenchStatsFeedbackTag from "./WorkbenchStatsFeedbackTag";
import { statsThreadIdentity } from "../stats-thread-identity";
import WorkbenchStatsSkeleton from "../WorkbenchStatsSkeleton";

/** Clamped text only offers expansion when it actually overflows at the current width. */
function useClampOverflow(enabled: boolean, expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (!enabled) {
      setOverflowing(false);
      return;
    }
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, expanded]);
  return { overflowing, ref };
}

export function WorkbenchFeedbackReportDisplay({
  category,
  clamp = true,
  meta,
  projectId,
  report,
  title,
}: {
  category: WorkbenchFeedbackCategory;
  clamp?: boolean;
  meta?: ReactNode;
  projectId?: string | null;
  report: string;
  title: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { overflowing, ref } = useClampOverflow(clamp, expanded);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-[0.74rem] text-fg/muted">
        <WorkbenchStatsFeedbackTag category={category} size="compact" />
        <span className="min-w-0 truncate font-semibold text-text">{title}</span>
        {meta}
      </div>
      <div
        className={`
          mt-1 min-w-0 text-[0.84rem] text-text [overflow-wrap:anywhere]
          ${clamp && !expanded ? "max-h-[6.9em] overflow-hidden" : ""}
          ${clamp && !expanded && overflowing ? "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]" : ""}
        `}
        ref={ref}
      >
        <ThreadMarkdown markdown={report} projectId={projectId} />
      </div>
      {clamp && (overflowing || expanded) ? (
        <button
          className="-ml-1 rounded-md px-1 text-[0.74rem] text-fg/muted hover:bg-fg/7 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

/** Placeholder lines shaped like one report: tag and title, then the report's opening lines. */
export function WorkbenchFeedbackReportSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2 py-2">
      <WorkbenchStatsSkeleton className="h-3 w-40" />
      <WorkbenchStatsSkeleton className="h-3" style={{ width: `${88 - index * 14}%` }} />
      <WorkbenchStatsSkeleton className="h-3" style={{ width: `${62 - index * 10}%` }} />
    </div>
  );
}

/** One stored report as the stats view shows it: importance, report, and its author's model, time, and thread. */
export function WorkbenchFeedbackReportBody({ clamp, item, modelName, showThread = true }: {
  clamp?: boolean;
  item: WorkbenchFeedbackItem;
  /** Catalogue display name, or the stored id when the catalogue does not know it. */
  modelName: string | null;
  /** Off where the authoring thread is the one already on screen. */
  showThread?: boolean;
}) {
  const thread = statsThreadIdentity(item);
  const importance = Math.round(item.importance * 100);
  return (
    <>
      <WorkbenchFeedbackReportDisplay
        category={item.category}
        clamp={clamp}
        meta={<span
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
        </span>}
        projectId={item.projectId}
        report={item.report}
        title={item.title}
      />
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.72rem] text-fg/muted">
        {item.harness ? <HarnessIcon className="shrink-0" harness={item.harness} size={14} /> : null}
        <span className="min-w-0 shrink truncate">
          <span className="font-semibold text-text">{modelName ?? "Unknown model"}</span>
          {item.reasoningEffort ? <> <span className="font-semibold capitalize text-text">{item.reasoningEffort}</span></> : null}
        </span>
        <span aria-hidden="true">·</span>
        <WorkbenchRelativeTime className="shrink-0" timestampMs={item.createdAt} />
        {showThread ? (
          <span className="ml-auto min-w-0 max-w-[60%] text-[0.8rem]">
            {thread ? (
              <WorkbenchThreadButton
                fallback={<span className="truncate text-fg/muted">{thread.threadId}</span>}
                threadId={thread.threadId}
              />
            ) : <span className="text-fg/muted">Thread removed</span>}
          </span>
        ) : null}
      </div>
    </>
  );
}

export default function WorkbenchStatsFeedbackReport({ item, modelName, onToggle, selected }: {
  item: WorkbenchFeedbackItem;
  modelName: string | null;
  onToggle: () => void;
  selected: boolean;
}) {
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
      <WorkbenchFeedbackReportBody item={item} modelName={modelName} />
    </li>
  );
}
