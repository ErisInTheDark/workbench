/*
 * No exports. Tests protect where selected feedback is addressed and what reference a report becomes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { feedbackAddressProjectId, feedbackReference } from "./stats-feedback-presentation.ts";

const item = (overrides: Partial<WorkbenchFeedbackItem>): WorkbenchFeedbackItem => ({
  category: "bug", channel: "project", createdAt: 1, daemonId: null, harness: "claude", id: 1, importance: 0.89, model: "claude-opus-5-5",
  projectId: "game", reasoningEffort: "medium", report: "it broke", scored: true, threadId: "thread",
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
