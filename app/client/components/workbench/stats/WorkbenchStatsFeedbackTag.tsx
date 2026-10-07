/*
 * Exports:
 * - default WorkbenchStatsFeedbackTag: a feedback category's tinted pill, optionally with a count.
 */
import type { WorkbenchFeedbackCategory } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { FEEDBACK_CATEGORY_PRESENTATION } from "./stats-feedback-presentation";

export default function WorkbenchStatsFeedbackTag({ category, count, size = "regular" }: {
  category: WorkbenchFeedbackCategory;
  count?: number;
  size?: "compact" | "regular";
}) {
  const { label, tagClassName } = FEEDBACK_CATEGORY_PRESENTATION[category];
  return (
    <span
      className={`
        inline-flex shrink-0 items-center gap-1.5 rounded-full font-semibold
        ${size === "compact" ? "px-2 py-px" : "px-2.5 py-0.5 text-[0.74rem]"}
        ${tagClassName}
      `}
    >
      {label}
      {count === undefined ? null : <span className="font-normal tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
