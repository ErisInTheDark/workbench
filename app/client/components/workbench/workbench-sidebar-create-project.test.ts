/* No exports. Protect sidebar create-thread target resolution across recency, selection, folder, and availability rules. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { resolveSidebarCreateTarget } from "./workbench-sidebar-create-project";

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

function presentation(projects: readonly WorkbenchLogicalProject[]): PresentationSnapshot {
  const locations = projects.flatMap(project => project.locations.map(location => ({
    target: location.target,
    logicalProjectId: project.id,
    identityKey: project.matchKey,
    name: location.name,
    rootPath: location.rootPath,
  })));
  return {
    revision: 3,
    daemons: [{ id: daemonId, hostname: "local" }],
    projects: projects.map(project => ({ id: project.id, matchKey: project.matchKey, label: project.label })),
    locations,
    defaults: [],
    drafts: [],
    folders: [],
    members: [],
    divergences: [],
    sourceMappings: [],
  };
}

test("without creation history the first available selected project owns creation", () => {
  const a = logical("a");
  const b = logical("b");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "b", logicalProject: null, logicalProjects: [a, b],
    projects: [physical("a"), physical("b")], selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved?.project, a);
  assert.deepEqual(resolved?.location, a.locations[0]!.target);
});

test("browsing a thread cannot change the no-history fallback", () => {
  const a = logical("a");
  const b = logical("b");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "a", logicalProject: null, logicalProjects: [a, b],
    presentation: presentation([a, b]),
    projects: [physical("a"), physical("b")], selectedOwnerProjectId: b.id,
    selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved?.project, a);
});

test("the newest accepted thread inside the selection keeps its exact folder", () => {
  const a = logical("a");
  const b = logical("b");
  const bWorktree = physical("b-worktree");
  b.locations.push({
    target: { daemonId, projectId: bWorktree.id },
    daemonId,
    hostname: "local",
    name: bWorktree.name,
    rootPath: bWorktree.rootPath,
    project: bWorktree,
  });
  const outside = logical("outside");
  const state = presentation([a, b, outside]);
  state.recentLaunches = [{
    logicalProjectId: b.id,
    target: b.locations[1]!.target,
    revision: 3,
  }, {
    logicalProjectId: outside.id,
    target: outside.locations[0]!.target,
    revision: 4,
  }];
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "a",
    logicalProject: a,
    logicalProjects: [a, b, outside],
    presentation: state,
    projects: [physical("a"), physical("b"), physical("outside")],
    selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved?.project, b);
  assert.deepEqual(resolved?.location, b.locations[1]!.target);
});

test("an unavailable selected project does not block an available one", () => {
  const offline = logical("offline", false);
  const online = logical("online");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "online", logicalProject: null, logicalProjects: [offline, online],
    projects: [physical("online")], selectedOwnerProjectId: offline.id,
    selectedProjectIds: [offline.id, online.id],
  });
  assert.equal(resolved?.project, online);
});

test("unselected logical projects never own sidebar creation", () => {
  const selected = logical("selected");
  const other = logical("other");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "other", logicalProject: null, logicalProjects: [selected, other],
    projects: [physical("selected"), physical("other")], selectedProjectIds: [selected.id],
  });
  assert.equal(resolved?.project, selected);
});

test("physical-only mode resolves the selected physical project", () => {
  const projects = [physical("a"), physical("b")];
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "b", logicalProject: null, logicalProjects: undefined,
    projects, selectedProjectIds: ["a", "b"],
  });
  assert.equal(resolved?.project, projects[1]);
  assert.equal(resolved?.location, null);
});
