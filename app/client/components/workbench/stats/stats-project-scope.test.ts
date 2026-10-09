/*
 * No production exports. Tests protect turning a sidebar selection into stats references that read every machine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { resolveStatsProjectScope, statsLocationKey } from "./stats-project-scope.ts";

const here = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const there = DaemonIdSchema.parse("5f29787d-5a30-4c4c-9d1f-224913a3468d");
const location = (daemonId: typeof here, projectId: string) => ({
  target: { daemonId, projectId: ProjectIdSchema.parse(projectId) }, daemonId,
  hostname: "host", name: projectId, rootPath: `C:/${projectId}`, project: null,
});

test("logical selections read every machine and name each machine's folders", () => {
  const both = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const remote = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
  const scope = resolveStatsProjectScope({
    attachedDaemonId: here,
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
  assert.deepEqual(scope.references, [{ kind: "logical", projectId: both }, { kind: "logical", projectId: remote }]);
  assert.deepEqual(scope.labels, ["One", "two"]);
  assert.equal(scope.names.get(statsLocationKey(here, "one-worktree")), "One · one-worktree");
  assert.equal(scope.names.get(statsLocationKey(there, "one-there")), "One");
  assert.equal(scope.logical.get(statsLocationKey(there, "two-there")), remote);
});

test("physical selections read their projects on the attached daemon", () => {
  const scope = resolveStatsProjectScope({
    attachedDaemonId: here, logicalProjects: undefined,
    projects: [{ id: ProjectIdSchema.parse("a"), name: "Alpha" } as WorkbenchProjectOption], selectedProjectIds: ["a"],
  });
  assert.deepEqual(scope.references, [{ kind: "location", location: { daemonId: here, projectId: "a" } }]);
  assert.equal(scope.names.get("a"), "Alpha");
});
