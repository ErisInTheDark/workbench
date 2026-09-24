/* No production exports. Protect git route round trips without absorbing other routes. */
import assert from "node:assert/strict";
import test from "node:test";
import * as routes from "./workbench-route";
import { DaemonIdSchema, ProjectIdSchema } from "../identity";

test("git routes round trip project identity separately from file routes", () => {
  const route = routes.createGitRoute("folder/project");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(route)), route);
  const file = routes.createFileRoute("folder/project", "git/a.ts");
  assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(file)), file);
  assert.equal(routes.parseWorkbenchRouteFromPath("/@/git").view, "invalid");
});

test("logical file and git routes retain their selected browse location", () => {
  const logicalId = "112f7e1e-81b6-4c30-bdc0-f83475981001";
  const location = { daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
    projectId: ProjectIdSchema.parse("same") };
  for (const route of [
    routes.createLogicalGitRoute(logicalId, location),
    routes.createLogicalFileRoute(logicalId, location, "src/a.ts"),
  ]) {
    assert.deepEqual(routes.parseWorkbenchRouteFromPath(routes.createWorkbenchHref(route)), route);
  }
});
