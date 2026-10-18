/*
 * No exports. Tests protect where selected feedback is addressed, what reference a report becomes, and how filters and search compose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchFeedbackCategory,
  WorkbenchFeedbackItem,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { TextSearch } from "../../../../workbench/search/text-search.ts";
import { feedbackAddressProjectId, feedbackReference, feedbackSearchText, selectFeedbackItems } from "./stats-feedback-presentation.ts";

const item = (overrides: Partial<WorkbenchFeedbackItem>): WorkbenchFeedbackItem => ({
  category: "bug", channel: "project", createdAt: 1, daemonId: null, harness: "claude", id: 1, importance: 0.89, model: "claude-opus-5-5",
  owned: false, projectId: "game", reasoningEffort: "medium", report: "it broke", resolvedAt: null, scored: true, threadId: "thread",
  title: "Stats action fails", ...overrides,
});

test("wb reports are addressed in the Workbench project, project reports in their own", () => {
  assert.equal(feedbackAddressProjectId([item({ channel: "wb", projectId: "game" }), item({ projectId: "workbench" })], "workbench"), "workbench");
  assert.equal(feedbackAddressProjectId([item({}), item({ channel: "wb" })], "workbench"), null);
  assert.equal(feedbackAddressProjectId([item({ channel: "wb" })], null), null);
  assert.equal(feedbackAddressProjectId([item({}), item({ id: 2 })], "workbench"), "game");
});

test("a report's reference names its storing machine, author and filing project, even once its thread is gone", () => {
  assert.deepEqual(feedbackReference(item({}), { daemonId: "daemon-a", modelName: "Opus 5.5", projectName: "game" }), {
    kind: "feedback", id: 1, daemonId: "daemon-a", category: "bug", title: "Stats action fails",
    author: "Opus 5.5 medium", thread: "thread from game", createdAt: 1, report: "it broke",
  });
  assert.equal(feedbackReference(item({ threadId: null, reasoningEffort: null }), {
    daemonId: "daemon-a", modelName: null, projectName: "game",
  }).thread, "removed thread from game");
});

const names = { modelName: "Opus 5.5", projectName: "game" };
const select = (items: readonly WorkbenchFeedbackItem[], filters: {
  categories?: ReadonlySet<WorkbenchFeedbackCategory>; ownership?: "all" | "unowned"; query?: string;
}) => {
  const { searched, visible } = selectFeedbackItems(items, {
    categories: filters.categories ?? new Set(), ownership: filters.ownership ?? "unowned",
    search: TextSearch.parse(filters.query ?? ""), sort: "newest",
  }, (entry) => feedbackSearchText(entry, names));
  return { searched: searched.map(({ id }) => id), visible: visible.map(({ id }) => id) };
};

test("feedback selection composes ownership, category, and newest-first ordering", () => {
  const items = [
    item({ category: "bug", createdAt: 2, id: 2, owned: true }),
    item({ category: "waste", createdAt: 3, id: 3 }),
    item({ category: "bug", createdAt: 1, id: 1 }),
  ];
  assert.deepEqual(select(items, {}).visible, [3, 1]);
  assert.deepEqual(select(items, { categories: new Set(["bug"]), ownership: "all" }).visible, [2, 1]);
});

test("search narrows before categories, so category counts follow the matches", () => {
  const items = [
    item({ category: "bug", id: 1, report: "the cache went stale" }),
    item({ category: "waste", id: 2, title: "Stale cache reread" }),
    item({ category: "bug", id: 3, report: "unrelated" }),
  ];
  const result = select(items, { categories: new Set(["bug"]), query: "stale" });
  assert.deepEqual(result.searched, [1, 2]);
  assert.deepEqual(result.visible, [1]);
});

test("search finds reports by author, effort, project, and category as well as their text", () => {
  const items = [item({ id: 1, reasoningEffort: "high" }), item({ category: "waste", id: 2, threadId: "thread-42" })];
  assert.deepEqual(select(items, { query: "opus high" }).searched, [1]);
  assert.deepEqual(select(items, { query: "game waste" }).searched, [2]);
  assert.deepEqual(select(items, { query: "thread-42" }).searched, [2]);
});
