/*
 * Exports:
 * - FEEDBACK_CATEGORY_PRESENTATION: label and hue for each feedback category.
 * - feedbackImportanceTone: text colour class for an importance between 0 and 1.
 * - selectFeedbackItems: the reports a viewer sees for a category filter and sort.
 */
import type {
  WorkbenchFeedbackCategory,
  WorkbenchFeedbackItem,
  WorkbenchFeedbackSort,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";

/** Hue utilities are listed whole so Tailwind can see them. */
export const FEEDBACK_CATEGORY_PRESENTATION: Readonly<Record<WorkbenchFeedbackCategory, {
  label: string;
  tagClassName: string;
}>> = {
  bug: { label: "Bug", tagClassName: "bg-hue-25/12 text-hue-25" },
  waste: { label: "Waste", tagClassName: "bg-hue-75/14 text-hue-75" },
  confusion: { label: "Confusion", tagClassName: "bg-hue-300/12 text-hue-300" },
  opportunity: { label: "Opportunity", tagClassName: "bg-hue-150/14 text-hue-150" },
};

export function feedbackImportanceTone(importance: number, scored: boolean) {
  if (!scored) return "text-fg/muted";
  return importance >= 0.75 ? "text-hue-25" : importance >= 0.5 ? "text-hue-50" : importance >= 0.25 ? "text-hue-75" : "text-fg/muted";
}

export function selectFeedbackItems(
  items: readonly WorkbenchFeedbackItem[],
  categories: ReadonlySet<WorkbenchFeedbackCategory>,
  sort: WorkbenchFeedbackSort,
) {
  const visible = categories.size ? items.filter(({ category }) => categories.has(category)) : [...items];
  return sort === "newest" ? visible.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id) : visible;
}
