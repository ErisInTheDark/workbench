/*
 * No exports. Tests protect where selected feedback is addressed and the prompt's message separator.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { feedbackAddressProjectId, formatFeedbackForAgent } from "./stats-feedback-presentation.ts";

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

test("the prompt lists every report and ends ready for the user's own message", () => {
  const prompt = formatFeedbackForAgent([item({}), item({ category: "waste", id: 2, threadId: null })], {
    modelName: () => "Opus 5.5", origin: () => "game",
  });
  assert.match(prompt, /^## Bug · game\nit broke\n- Author: Opus 5.5 medium · importance 89\n- Thread: thread/u);
  assert.match(prompt, /## Waste · game[\s\S]*- Thread: removed/u);
  assert.ok(prompt.endsWith("\n\n=====\n\n"));
});
