/*
 * No production exports. Tests protect mapping a logical sidebar selection onto the stats daemon's projects.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { resolveStatsProjectScope } from "./stats-project-scope.ts";

const here = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const there = DaemonIdSchema.parse("5f29787d-5a30-4c4c-9d1f-224913a3468d");
const location = (daemonId: typeof here, projectId: string) => ({
  target: { daemonId, projectId: ProjectIdSchema.parse(projectId) }, daemonId,
  hostname: "host", name: projectId, rootPath: `C:/${projectId}`, project: null,
});

test("logical selections keep only projects on the stats daemon and report the rest", () => {
  const both = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const remote = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const scope = resolveStatsProjectScope({
    daemonId: here,
    logicalProjects: [
      {
        id: both, matchKey: "remote://one", label: "one", displayName: "One",
        locations: [location(here, "one-here"), location(here, "one-worktree"), location(there, "one-there")],
      },
      { id: remote, matchKey: "remote://two", label: "two", locations: [location(there, "two-there")] },
    ],
    projects: [],
    selectedProjectIds: [both, remote],
  });
  assert.deepEqual(scope.projectIds, ["one-here", "one-worktree"]);
  assert.deepEqual(scope.labels, ["One"]);
  assert.deepEqual(scope.elsewhere, ["two"]);
  assert.equal(scope.names.get("one-worktree"), "One · one-worktree");
  assert.deepEqual(scope.groups.map(({ id, projectIds }) => [id, projectIds]), [[both, ["one-here", "one-worktree"]]]);
});

test("physical selections pass through unchanged", () => {
  const scope = resolveStatsProjectScope({
    daemonId: here, logicalProjects: undefined,
    projects: [{ id: ProjectIdSchema.parse("a"), name: "Alpha" } as WorkbenchProjectOption], selectedProjectIds: ["a", "b"],
  });
  assert.deepEqual(scope.projectIds, ["a", "b"]);
  assert.deepEqual(scope.groups.map(({ id, projectIds }) => [id, projectIds]), [["a", ["a"]], ["b", ["b"]]]);
  assert.equal(scope.names.get("a"), "Alpha");
});
