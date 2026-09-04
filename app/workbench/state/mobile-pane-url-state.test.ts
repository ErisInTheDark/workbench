/*
 * No production exports. Tests protect route-owned mobile pane selection. Keywords: mobile, route, pane, stats, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createHomeRoute,
  createProjectRoute,
  createStatsRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { getPreferredMobilePane } from "./mobile-pane-url-state.ts";

test("mobile stats routes select main content while navigation roots select the explorer", () => {
  assert.equal(getPreferredMobilePane(true, createStatsRoute()), "editor");
  assert.equal(getPreferredMobilePane(true, createStatsRoute("project")), "editor");
  assert.equal(getPreferredMobilePane(true, createHomeRoute()), "explorer");
  assert.equal(getPreferredMobilePane(true, createProjectRoute("project")), "explorer");
});

test("desktop routes always select main content", () => {
  assert.equal(getPreferredMobilePane(false, createHomeRoute()), "editor");
});
