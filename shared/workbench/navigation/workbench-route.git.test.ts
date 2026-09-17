/* No production exports. Protect git route round trips without absorbing other routes. */
import assert from "node:assert/strict";
import test from "node:test";
import * as routes from "./workbench-route";

test("git routes round trip project identity separately from file routes", () => {
  const route = routes.createGitRoute("folder/project");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(route)), route);
  const file = routes.createFileRoute("folder/project", "git/a.ts");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(file)), file);
  assert.equal(routes.parseWorkbenchRouteFromPath("/@/git").view, "invalid");
});
