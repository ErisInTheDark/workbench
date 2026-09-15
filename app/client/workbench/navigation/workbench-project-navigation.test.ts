/*
 * Exports: none. Regression tests protect public addresses independently of stored project identities.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import {
  createProjectRoute, createFileRoute, createThreadRoute, createHomeThreadRoute,
  createPinnedThreadRoute, createSettingsRoute, createStatsRoute, createMosaicRoute,
  createWorkbenchHref, parseWorkbenchRouteFromLocation,
} from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const identities = ["remote://github.com/team/repo", "local:///C:/git/repo", "workspace://members"];

for (const identity of identities) {
  test(`public routes retain their address for ${identity}`, () => {
    const projectId = ProjectIdSchema.parse(identity);
    const otherId = ProjectIdSchema.parse("remote://github.com/team/other");
    const address = "web/repo";
    const navigation = new WorkbenchProjectNavigation([{
      id: projectId, relativePath: address, name: "repo", kind: "git", rootPath: "C:/git/repo",
      roots: [], lastCommitTimeMs: null,
    }, {
      id: otherId, relativePath: "other/project", name: "other", kind: "git", rootPath: "C:/git/other",
      roots: [], lastCommitTimeMs: null,
    }], [{ alias: address, projectId }, { alias: "other/project", projectId: otherId }]);
    const routes = [
      createProjectRoute(address), createFileRoute(address, "src/a file.ts"),
      createThreadRoute(address, "thread"), createHomeThreadRoute(address, "thread"),
      createPinnedThreadRoute("other/project", address, "thread"),
      createSettingsRoute(address, "project"), createStatsRoute(address),
      createMosaicRoute(address, { type: "target", target: { kind: "file", filePath: "src/a.ts" } }),
    ];
    for (const publicRoute of routes.map(route => parseWorkbenchRouteFromLocation(createWorkbenchHref(route)))) {
      const internal = navigation.resolveRoute(publicRoute);
      assert.equal(internal.projectId === address || internal.threadOwnerProjectId === address, false);
      const href = navigation.href(internal);
      assert.equal(href, createWorkbenchHref(publicRoute));
      assert.deepEqual(navigation.resolveRoute(parseWorkbenchRouteFromLocation(href!)), internal);
    }
    assert.equal(navigation.href(createProjectRoute(identity)), "/web/repo");
    assert.equal(navigation.href(navigation.readRoute("/launch", identity)), "/web/repo");
  });
}

test("current retained addresses survive navigation, with deterministic historical links", () => {
  const projectId = ProjectIdSchema.parse(identities[0]);
  const aliases = [{ alias: "old/repo", projectId }, { alias: "older/repo", projectId }];
  const navigation = new WorkbenchProjectNavigation([], aliases);
  assert.equal(navigation.href(createThreadRoute(projectId, "thread"), createProjectRoute("older/repo")), "/older/repo/@/thread/thread");
  assert.equal(navigation.href(createProjectRoute(projectId)), "/old/repo");
  assert.equal(new WorkbenchProjectNavigation([], [...aliases].reverse()).href(createProjectRoute(projectId)), "/old/repo");
  assert.equal(new WorkbenchProjectNavigation([], []).href(createProjectRoute(projectId)), undefined);
  assert.equal(navigation.href(createProjectRoute("legacy/project")), "/legacy/project");
  assert.equal(navigation.readRoute("/unrelated", projectId).projectId, "unrelated");
  assert.equal(navigation.readRoute("/launch").view, "home");
});
