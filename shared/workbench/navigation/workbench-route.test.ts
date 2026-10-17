/*
 * Exports: none.
 * Tests: the flagged tab list and every tab shape round-trip, old shapes rewrite to it; stats tabs survive href round trips and selection changes; draft folder changes survive new-to-saved promotion without accepting another route intent; the new project view survives href round trips.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, DaemonIdSchema } from "../identity";
import {
  createFileRoute, createHomeRoute, createHomeThreadRoute, createLogicalThreadRoute, createNewProjectRoute, createProjectSelectionRoute, createSettingsRoute,
  createStatsRoute, createThreadRoute, createToggledProjectSelectionRoute, createWorkbenchHref, isSameDraftRouteIntent,
  isSameWorkbenchRoute, parseWorkbenchRouteFromPath, salvageWorkbenchPath, withFileDestination, withFileTabs, withProjectSelection,
} from "./workbench-route";

test("a file tab swaps to its folder index and back, keeping its folder", () => {
  const file = parseWorkbenchRouteFromPath("/a/@/*/file/%2Blab/*/docs/notes.md");
  const index = withFileDestination(file, "docs/notes.md", true);
  const href = createWorkbenchHref(index);
  assert.equal(href, "/a/@/*/index/%2Blab/*/docs/notes.md");
  const reopened = parseWorkbenchRouteFromPath(href);
  assert.equal(reopened.fileIndex, true);
  assert.equal(isSameWorkbenchRoute(reopened, file), false);
  assert.equal(createWorkbenchHref(withFileDestination(reopened, "docs/other.md")), "/a/@/*/file/%2Blab/*/docs/other.md");
});

test("a broken url salvages its valid tabs, then its selection and folder, then home", () => {
  const valid = (path: string) => parseWorkbenchRouteFromPath(path).view !== "invalid";
  // An unflagged tab list reads as its one active tab.
  assert.equal(salvageWorkbenchPath("/workbench/@/file/workbench/*/notes.md", valid), "/workbench/@/*/file/workbench/*/notes.md");
  // Broken tabs drop out; a surviving active tab stays active, else the first survivor takes over.
  assert.equal(salvageWorkbenchPath("/a/+/b/@/stats/nope/+/file/x.md/+/*/settings", valid), "/a/+/b/@/file/x.md/+/*/settings");
  assert.equal(salvageWorkbenchPath("/a/+/b/@/*/stats/nope/+/~/file/x.md/+/settings", valid), "/a/+/b/@/*/file/x.md/+/settings");
  assert.equal(salvageWorkbenchPath("/a/*/%2Blab/@/*/stats/nope", valid), "/a/*/%2Blab/@/");
  assert.equal(salvageWorkbenchPath("/a/+/a/@/*/stats", valid), "/");
});

test("stats tabs round-trip through their href, keep through selection changes, and default to usage", () => {
  for (const tab of ["usage", "workspaces", "tools"] as const) {
    const route = withProjectSelection(createStatsRoute(null, tab), ["alpha"]);
    const parsed = parseWorkbenchRouteFromPath(createWorkbenchHref(route));
    assert.equal(parsed.statsTab ?? "usage", tab);
    assert.equal(isSameWorkbenchRoute(parsed, route), true);
    assert.equal(createToggledProjectSelectionRoute(route, ["alpha"], "beta", ["alpha", "beta"]).statsTab ?? "usage", tab);
  }
  assert.equal(createWorkbenchHref(createStatsRoute(null, "usage")), "/@/*/stats");
  assert.equal(isSameWorkbenchRoute(createStatsRoute(null, "tools"), createStatsRoute(null)), false);
  assert.equal(parseWorkbenchRouteFromPath("/@/stats/nope").view, "invalid");
});

test("after the route marker the path is the flagged tab list, and it round-trips with selection and folder", () => {
  const route = {
    ...withProjectSelection(createHomeThreadRoute("workbench", "8995"), ["secret-santa", "babblebox"]),
    folderAddress: ["babblebox"],
    tabStrip: { tabs: ["thread/zoomie-lint/c6c7", "thread/workbench/8995", "settings"], preview: 1 },
  };
  const href = createWorkbenchHref(route);
  assert.equal(href, "/secret-santa/+/babblebox/*/babblebox/@/thread/zoomie-lint/c6c7/+/*~/thread/workbench/8995/+/settings");
  const parsed = parseWorkbenchRouteFromPath(href);
  assert.equal(parsed.view, "thread");
  assert.equal(parsed.threadOwnerProjectId, "workbench");
  assert.equal(parsed.threadTarget?.kind === "provider" && parsed.threadTarget.threadId, "8995");
  assert.deepEqual(parsed.selectedProjectIds, ["secret-santa", "babblebox"]);
  assert.deepEqual(parsed.folderAddress, ["babblebox"]);
  assert.deepEqual(parsed.tabStrip, route.tabStrip);
  assert.equal(createWorkbenchHref(parsed), href);

  const settings = parseWorkbenchRouteFromPath("/@/thread/zoomie-lint/c6c7/+/~*/settings");
  assert.equal(settings.view, "settings");
  assert.deepEqual(settings.tabStrip, { tabs: ["thread/zoomie-lint/c6c7", "settings"], preview: 1 });
  assert.equal(parseWorkbenchRouteFromPath("/@/*/settings/+/*/git").view, "invalid", "one tab is active");
});

test("every tab names its whole destination without a nested route marker, and a lone tab is still marked active", () => {
  const cases: Array<[ReturnType<typeof createFileRoute>, string]> = [
    [withProjectSelection(createThreadRoute("workbench", "x"), ["workbench"]), "/workbench/@/*/thread/workbench/x"],
    [createHomeThreadRoute("github.com/team/repo", { kind: "new" }), "/@/*/thread/github.com%2Fteam%2Frepo/new"],
    [createHomeThreadRoute("repo", { kind: "subagent", parentThreadId: "p", threadId: "c" } as never), "/@/*/thread/repo/p/sub/c"],
    [createSettingsRoute(""), "/@/*/settings"],
    [createStatsRoute(null, "tools"), "/@/*/stats/tools"],
    [withFileTabs(createFileRoute("", "icons/star.svg"), [{ filePath: "icons/star.svg", folderAddress: ["+convex-lab"] }], 0),
      "/@/*/file/%2Bconvex-lab/*/icons/star.svg"],
  ];
  for (const [route, href] of cases) {
    assert.equal(createWorkbenchHref(route), href);
    const parsed = parseWorkbenchRouteFromPath(href);
    assert.equal(parsed.view, route.view, href);
    assert.equal(createWorkbenchHref(parsed), href);
  }
  assert.equal(parseWorkbenchRouteFromPath("/@/*/file/%2Bconvex-lab/*/icons/star.svg").filePath, "icons/star.svg");
  assert.equal(createWorkbenchHref(createProjectSelectionRoute(["a"])), "/a/@/");
});

test("old route shapes and the old tab query still open and rewrite to the tab list", () => {
  const legacy: Array<[string, string]> = [
    ["/workbench/@/thread/x", "/workbench/@/*/thread/workbench/x"],
    ["/a/+/b/@/thread/zoomie/@/c6", "/a/+/b/@/*/thread/zoomie/c6"],
    ["/a/@/pin/zoomie/@/thread/c6", "/a/@/*/thread/zoomie/c6"],
    ["/workbench/@/file/2/a.svg/+/%2Bconvex-lab/*/b.svg", "/workbench/@/file/a.svg/+/*/file/%2Bconvex-lab/*/b.svg"],
    ["/a/@/thread/workbench/@/8995?tab=thread%2Fzoomie%2F%40%2Fc6&tab=thread%2Fworkbench%2F%40%2F8995&preview=1",
      "/a/@/thread/zoomie/c6/+/*~/thread/workbench/8995"],
  ];
  for (const [old, canonical] of legacy) {
    const url = new URL(old, "http://workbench.local");
    assert.equal(createWorkbenchHref(parseWorkbenchRouteFromPath(url.pathname, url.search)), canonical, old);
  }
});

test("new project view round-trips through its href with and without a project selection", () => {
  for (const route of [createNewProjectRoute(), withProjectSelection(createNewProjectRoute(), ["alpha", "beta"])]) {
    const parsed = parseWorkbenchRouteFromPath(createWorkbenchHref(route));
    assert.equal(parsed.view, "new-project");
    assert.equal(isSameWorkbenchRoute(parsed, route), true);
  }
});

test("folder choice remains current through draft promotion, not unrelated navigation", () => {
  const project = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const otherProject = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981002");
  const draftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const otherDraftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const location = {
    daemonId: DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029"),
    projectId: ProjectIdSchema.parse("workbench"),
  };
  const before = createLogicalThreadRoute(null, project, location, { kind: "new" });
  const promoted = createLogicalThreadRoute(null, project, null, { kind: "draft", draftId });
  assert.equal(isSameDraftRouteIntent(before, before, draftId), true);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, project, location, { kind: "new" }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before, promoted, draftId), true);
  assert.equal(isSameDraftRouteIntent(promoted,
    createLogicalThreadRoute(null, project, null, { kind: "draft", draftId }), draftId), true);
  assert.equal(isSameDraftRouteIntent(promoted,
    createLogicalThreadRoute(null, project, location, { kind: "draft", draftId }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, project, null, { kind: "draft", draftId: otherDraftId }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before,
    createLogicalThreadRoute(null, otherProject, null, { kind: "draft", draftId }), draftId), false);
  assert.equal(isSameDraftRouteIntent(before, createHomeRoute(), draftId), false);
});
