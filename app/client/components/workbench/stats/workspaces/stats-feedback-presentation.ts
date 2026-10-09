/*
 * Exports:
 * - FEEDBACK_CATEGORY_PRESENTATION: label and hue for each feedback category.
 * - feedbackImportanceTone: text colour class for an importance between 0 and 1.
 * - selectFeedbackItems: the reports a viewer sees for a category filter and sort.
 * - feedbackOwnerProjectId/feedbackAddressProjectId: the project a report, or a whole selection, is addressed in.
 * - countFeedbackCategories: per-category counts of the given reports, empty categories omitted.
 * - formatFeedbackForAgent: the markdown prompt a new thread starts from when addressing feedback.
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
  waste: { label: "Waste", tagClassName: "bg-hue-85/16 text-hue-85" },
  confusion: { label: "Confusion", tagClassName: "bg-hue-300/12 text-hue-300" },
  opportunity: { label: "Opportunity", tagClassName: "bg-hue-150/14 text-hue-150" },
};

export function feedbackImportanceTone(importance: number, scored: boolean) {
  if (!scored) return "text-fg/muted";
  return importance >= 0.75 ? "text-hue-25" : importance >= 0.5 ? "text-hue-50" : importance >= 0.25 ? "text-hue-75" : "text-fg/muted";
}

/** wb reports are about Workbench, so they are addressed in the Workbench project whichever project filed them. */
export function feedbackOwnerProjectId(item: Pick<WorkbenchFeedbackItem, "channel" | "projectId">, workbenchProjectId: string | null) {
  return item.channel === "wb" ? workbenchProjectId : item.projectId;
}

/** The one project a selection can be addressed in, or null when owners differ or are unknown. */
export function feedbackAddressProjectId(items: readonly Pick<WorkbenchFeedbackItem, "channel" | "projectId">[], workbenchProjectId: string | null) {
  const owners = new Set(items.map((item) => feedbackOwnerProjectId(item, workbenchProjectId)));
  const [owner] = owners;
  return owners.size === 1 && owner ? owner : null;
}

export function countFeedbackCategories(items: readonly Pick<WorkbenchFeedbackItem, "category">[]) {
  return (Object.keys(FEEDBACK_CATEGORY_PRESENTATION) as WorkbenchFeedbackCategory[])
    .map((category) => ({ category, count: items.filter((item) => item.category === category).length }))
    .filter(({ count }) => count > 0);
}

/** A new-thread prompt: each report, then a separator after which the user writes their own message. */
export function formatFeedbackForAgent(items: readonly WorkbenchFeedbackItem[], describe: {
  modelName(item: WorkbenchFeedbackItem): string | null;
  origin(item: WorkbenchFeedbackItem): string;
}) {
  const blocks = items.map((item) => [
    `## ${FEEDBACK_CATEGORY_PRESENTATION[item.category].label} · ${describe.origin(item)}`,
    item.report.trim(),
    `- Author: ${[describe.modelName(item) ?? "Unknown model", item.reasoningEffort].filter(Boolean).join(" ")} · importance ${Math.round(item.importance * 100)}${item.scored ? "" : " (unscored model)"}`,
    `- Thread: ${item.threadId ?? "removed"}`,
  ].join("\n"));
  return `${blocks.join("\n\n")}\n\n=====\n\n`;
}

export function selectFeedbackItems(
  items: readonly WorkbenchFeedbackItem[],
  categories: ReadonlySet<WorkbenchFeedbackCategory>,
  sort: WorkbenchFeedbackSort,
) {
  const visible = categories.size ? items.filter(({ category }) => categories.has(category)) : [...items];
  return sort === "newest" ? visible.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id) : visible;
}
