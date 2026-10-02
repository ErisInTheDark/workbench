/* No exports. Protect sidebar create-thread project resolution across multi-project and unavailable-folder selections. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { resolveSidebarCreateProject } from "./workbench-sidebar-create-project";

const daemonId = DaemonIdSchema.parse(crypto.randomUUID());

function physical(id: string): WorkbenchProjectOption {
  return {
    id: ProjectIdSchema.parse(id), kind: "git", lastCommitTimeMs: null, name: id,
    rootPath: `/${id}`, roots: [], relativePath: id,
  };
}

function logical(physicalId: string, available = true): WorkbenchLogicalProject {
  const project = physical(physicalId);
  return {
    id: LogicalProjectIdSchema.parse(crypto.randomUUID()),
    matchKey: `local:///${physicalId}`,
    label: physicalId,
    locations: [{
      target: { daemonId, projectId: project.id },
      daemonId, hostname: "local", name: physicalId, rootPath: project.rootPath,
      project: available ? project : null,
    }],
  };
}

test("multi-project selection without a route project resolves the selected logical owner", () => {
  const a = logical("a");
  const b = logical("b");
  const resolved = resolveSidebarCreateProject({
    createProjectId: "b", logicalProject: null, logicalProjects: [a, b],
    projects: [physical("a"), physical("b")], selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved, b);
});

test("an unavailable selected project does not block an available one", () => {
  const offline = logical("offline", false);
  const online = logical("online");
  const resolved = resolveSidebarCreateProject({
    createProjectId: "online", logicalProject: null, logicalProjects: [offline, online],
    projects: [physical("online")], selectedProjectIds: [offline.id, online.id],
  });
  assert.equal(resolved, online);
});

test("unselected logical projects never own sidebar creation", () => {
  const selected = logical("selected");
  const other = logical("other");
  const resolved = resolveSidebarCreateProject({
    createProjectId: "other", logicalProject: null, logicalProjects: [selected, other],
    projects: [physical("selected"), physical("other")], selectedProjectIds: [selected.id],
  });
  assert.equal(resolved, null);
});

test("physical-only mode resolves the selected physical project", () => {
  const projects = [physical("a"), physical("b")];
  const resolved = resolveSidebarCreateProject({
    createProjectId: "b", logicalProject: null, logicalProjects: undefined,
    projects, selectedProjectIds: ["a", "b"],
  });
  assert.equal(resolved, projects[1]);
});
