/*
 * No production exports. Tests protect route-owned mobile pane selection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createHomeRoute,
  createHomeThreadRoute,
  createGitRoute,
  createLogicalExistingThreadRoute,
  createProjectRoute,
  createStatsRoute,
  createThreadRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { getMobileExplorerRoute, getPreferredMobilePane } from "./mobile-pane-url-state.ts";

test("mobile stats routes select main content while navigation roots select the explorer", () => {
  assert.equal(getPreferredMobilePane(true, createStatsRoute()), "editor");
  assert.equal(getPreferredMobilePane(true, createStatsRoute("project")), "editor");
  assert.equal(getPreferredMobilePane(true, createHomeRoute()), "explorer");
  assert.equal(getPreferredMobilePane(true, createProjectRoute("project")), "explorer");
});

test("desktop routes always select main content", () => {
  assert.equal(getPreferredMobilePane(false, createHomeRoute()), "editor");
});

test("mobile working trees open content rather than leaving the sidebar visible", () => {
  assert.equal(getPreferredMobilePane(true, createGitRoute("project")), "editor");
});

test("mobile back keeps the selected project when leaving a thread", () => {
  const selected = "112f7e1e-81b6-4c30-bdc0-f83475981001";
  const target = { kind: "provider" as const, threadId: ThreadReferenceSchema.parse("thread") };
  const thread = createLogicalExistingThreadRoute(selected, target);
  assert.equal(getMobileExplorerRoute(thread, "another-folder").logical?.projectId, selected);
  assert.equal(getMobileExplorerRoute(createLogicalExistingThreadRoute(null, target),
    "another-folder").view, "home");
  assert.equal(getMobileExplorerRoute(createThreadRoute("project", "thread"),
    "another-folder").projectId, "project");
  assert.equal(getMobileExplorerRoute(createHomeThreadRoute("project", "thread"),
    "another-folder").view, "home");
});
