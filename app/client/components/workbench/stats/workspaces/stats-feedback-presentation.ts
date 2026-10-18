/*
 * Exports:
 * - FEEDBACK_CATEGORY_PRESENTATION: label and hue for each feedback category.
 * - feedbackImportanceTone: text colour class for an importance between 0 and 1.
 * - FeedbackOwnershipFilter/FeedbackStatus/selectFeedbackItems: the reports a viewer sees for ownership, search, category, and sort filters.
 * - feedbackSearchText: folded text a search matches one report against.
 * - feedbackOwnerProjectId/feedbackAddressProjectId: the project a report, or a whole selection, is addressed in.
 * - countFeedbackCategories: per-category counts of the given reports, empty categories omitted.
 * - feedbackReference: the composer reference a new thread receives when addressing one report.
 */
import type {
  WorkbenchFeedbackCategory,
  WorkbenchFeedbackItem,
  WorkbenchFeedbackSort,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import { TextSearch } from "../../../../workbench/search/text-search";

export type FeedbackOwnershipFilter = "unowned" | "all";
/** Open reports, or reports resolved within the retention window. */
export type FeedbackStatus = "open" | "resolved";

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

/** The composer reference a new thread receives for one report; `daemonId` is the machine storing it. */
export function feedbackReference(item: WorkbenchFeedbackItem, describe: {
  daemonId: string;
  modelName: string | null;
  projectName: string;
}): WorkbenchThreadAddressedFeedback {
  return {
    kind: "feedback", id: item.id, daemonId: describe.daemonId, category: item.category, title: item.title,
    author: [describe.modelName ?? "Unknown model", item.reasoningEffort].filter(Boolean).join(" "),
    thread: `${item.threadId ?? "removed thread"} from ${describe.projectName}`,
    createdAt: Math.round(item.createdAt), report: item.report.trim(),
  };
}

/** Folded text a search matches one report against: what it says, who wrote it, and where it came from. */
export function feedbackSearchText(item: WorkbenchFeedbackItem, names: { modelName: string | null; projectName: string }) {
  return TextSearch.fold([
    item.title, item.report, FEEDBACK_CATEGORY_PRESENTATION[item.category].label, item.channel,
    names.modelName ?? item.model ?? "", item.reasoningEffort ?? "", names.projectName, item.threadId ?? "",
  ].join("\0"));
}

/**
 * `searched` passes ownership and search, so category pills count where matches live;
 * `visible` narrows that by category, in the chosen order; a null sort keeps the given order.
 */
export function selectFeedbackItems(
  items: readonly WorkbenchFeedbackItem[],
  filters: {
    categories: ReadonlySet<WorkbenchFeedbackCategory>;
    ownership: FeedbackOwnershipFilter;
    search: TextSearch;
    sort: WorkbenchFeedbackSort | null;
  },
  searchText: (item: WorkbenchFeedbackItem) => string,
) {
  const owned = filters.ownership === "all" ? items : items.filter((item) => !item.owned);
  const searched = TextSearch.isActive(filters.search)
    ? owned.filter((item) => TextSearch.matches(filters.search, searchText(item)))
    : owned;
  const visible = filters.categories.size ? searched.filter(({ category }) => filters.categories.has(category)) : [...searched];
  if (filters.sort === "newest") visible.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
  return { searched, visible };
}
