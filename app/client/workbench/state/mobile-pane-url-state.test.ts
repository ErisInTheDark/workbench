/*
 * No production exports. Tests protect route-owned mobile pane selection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createHomeRoute,
  createGitRoute,
  createLogicalExistingThreadRoute,
  createProjectRoute,
  createStatsRoute,
  withProjectSelection,
} from "workbench-shared/workbench/navigation/workbench-route";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import {
  getPreferredMobilePane, isMobileSidebarRequested, keepsMobileMainPane, mobileSidebarHref,
} from "./mobile-pane-url-state.ts";

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

test("only navigations that keep the main pane keep the sidebar open over it", () => {
  const target = { kind: "provider" as const, threadId: ThreadReferenceSchema.parse("thread") };
  const thread = createLogicalExistingThreadRoute(null, target);
  assert.equal(keepsMobileMainPane(thread, withProjectSelection(thread, ["another-project"])), true);
  assert.equal(keepsMobileMainPane(thread, createLogicalExistingThreadRoute(null,
    { kind: "provider", threadId: ThreadReferenceSchema.parse("other") })), false);
  assert.equal(keepsMobileMainPane(thread, createHomeRoute()), false);
});

test("a sidebar request shows the sidebar over a thread that a reload keeps", () => {
  const thread = createLogicalExistingThreadRoute(null, { kind: "provider", threadId: ThreadReferenceSchema.parse("thread") });
  const href = mobileSidebarHref({ pathname: "/a/@/thread", search: "?q=1", hash: "#end" });
  const url = new URL(href, "http://workbench.local");
  assert.equal(url.pathname, "/a/@/thread");
  assert.equal(url.searchParams.get("q"), "1");
  assert.equal(url.hash, "#end");
  assert.equal(getPreferredMobilePane(true, thread, isMobileSidebarRequested(url.search)), "explorer");
  assert.equal(getPreferredMobilePane(true, thread, isMobileSidebarRequested("?q=1")), "editor");
  assert.equal(getPreferredMobilePane(false, thread, true), "editor");
});
