/* No exports. Protect sidebar create-thread target resolution across recency, selection, folder, and availability rules. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
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

test("multi-project selection without a route project resolves the selected logical owner", () => {
  const a = logical("a");
  const b = logical("b");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "b", logicalProject: null, logicalProjects: [a, b],
    projects: [physical("a"), physical("b")], selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved?.project, b);
  assert.deepEqual(resolved?.location, b.locations[0]!.target);
});

test("the current thread owner wins over the first selected project", () => {
  const a = logical("a");
  const b = logical("b");
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "a", logicalProject: null, logicalProjects: [a, b],
    presentation: presentation([a, b]),
    projects: [physical("a"), physical("b")], selectedOwnerProjectId: b.id,
    selectedProjectIds: [a.id, b.id],
  });
  assert.equal(resolved?.project, b);
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
  state.drafts.push({
    id: DraftIdSchema.parse(crypto.randomUUID()),
    logicalProjectId: b.id,
    target: b.locations[1]!.target,
    prompt: "",
    updatedAt: 3,
    revision: 3,
    phase: "accepted",
    pinned: false,
    snoozed: false,
    launchId: null,
    acceptedThreadId: "latest",
    attachments: [],
    selection: { kind: "custom", settings: {
      agentPath: null,
      agentSource: null,
      harness: "codex",
      model: "model",
      reasoningEffort: null,
      serviceTier: null,
      contextWindowTokens: null,
    } },
  }, {
    id: DraftIdSchema.parse(crypto.randomUUID()),
    logicalProjectId: outside.id,
    target: outside.locations[0]!.target,
    prompt: "",
    updatedAt: 4,
    revision: 4,
    phase: "accepted",
    pinned: false,
    snoozed: false,
    launchId: null,
    acceptedThreadId: "newer-but-unselected",
    attachments: [],
    selection: { kind: "custom", settings: {
      agentPath: null,
      agentSource: null,
      harness: "codex",
      model: "model",
      reasoningEffort: null,
      serviceTier: null,
      contextWindowTokens: null,
    } },
  });
  const resolved = resolveSidebarCreateTarget({
    createProjectId: "a",
    logicalProject: null,
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
  assert.equal(resolved, null);
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
