/* No production exports. Protect git route round trips without absorbing other routes. */
import assert from "node:assert/strict";
import test from "node:test";
import * as routes from "./workbench-route";

test("git routes round trip project identity separately from file routes", () => {
  const route = routes.createGitRoute("folder/project");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(route)), route);
  const file = routes.createFileRoute("folder/project", "git/a.ts");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(file)), file);
  assert.equal(routes.parseWorkbenchRouteFromPath("/folder/project/@/git/extra").view, "invalid");
});

test("git urls preserve project selection and folder scope independently", () => {
  for (const selected of [null, [], ["workbench"], ["workbench", "zoomie-lint"]]) {
    for (const folderAddress of [undefined, ["workbench"]]) {
      const route = { ...routes.createProjectSelectionRoute(selected), view: "git" as const, folderAddress };
      const parsed = routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(route));
      assert.equal(parsed.view, "git");
      assert.deepEqual(parsed.selectedProjectIds, selected);
      assert.deepEqual(parsed.folderAddress, folderAddress);
    }
  }
  for (const prefix of ["", "workbench/+/zoomie-lint/", "+/", "workbench/+/zoomie-lint/*/workbench/"]) {
    assert.equal(routes.parseWorkbenchRouteFromPath(`/${prefix}@/git/extra`).view, "invalid");
  }
});

