/* No exports. Protect identity-stable project facts: equal pushes stay silent, changes replace only what changed. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { WorkspaceProjects } from "workbench-shared/workbench/workspace/workspace-observation";
import ProjectFactsStore, { type ProjectFactsWorkspace } from "./ProjectFactsStore";

function fakeWorkspace() {
  const listeners = new Map<string, () => void>();
  const values = new Map<string, unknown>();
  let released = 0;
  const workspace = {
    observe: (query: { kind: string }, listener: () => void) => {
      listeners.set(query.kind, listener);
      return {
        getSnapshot: () => ({ phase: values.has(query.kind) ? "current" : "pending", failure: null,
          value: values.has(query.kind) ? { data: values.get(query.kind) } : null }),
        release: () => { released += 1; },
      };
    },
  } as unknown as ProjectFactsWorkspace;
  return {
    workspace,
    set: (kind: "projects" | "projectGroups", data: unknown) => { values.set(kind, data); },
    notify: (kind: "projects" | "projectGroups") => listeners.get(kind)?.(),
    push: (kind: "projects" | "projectGroups", data: unknown) => { values.set(kind, data); listeners.get(kind)?.(); },
    released: () => released,
  };
}

const daemonId = DaemonIdSchema.parse(crypto.randomUUID());
function project(name: string, label = name) {
  const target = { daemonId, projectId: ProjectIdSchema.parse(name) };
  return {
    id: LogicalProjectIdSchema.parse(`00000000-0000-4000-8000-${name.padStart(12, "0")}`), matchKey: `local://${name}`, label,
    locations: [{ target, daemonId, hostname: "local", name, rootPath: `/${name}`, project: null }],
  };
}
function facts(betaLabel: string): WorkspaceProjects {
  return {
    projects: [project("1"), project("2", betaLabel)], observedProjects: [], summaries: {},
    sources: [], catalogues: [{ daemonId, phase: "current", failure: null }], navigation: [],
  };
}

test("an equal push keeps every identity and stays silent; a changed project alone is replaced", () => {
  const fake = fakeWorkspace();
  let changes = 0;
  const store = new ProjectFactsStore(fake.workspace, () => { changes += 1; });
  let notified = 0;
  store.subscribe(() => { notified += 1; });

  fake.push("projects", facts("beta"));
  const [first, second] = store.getProjects();
  const folders = store.getFolders();
  assert.equal(notified, 1);

  fake.push("projects", structuredClone(facts("beta")));
  assert.equal(notified, 1);
  assert.equal(changes, 2);
  assert.equal(store.getProjects()[0], first);
  assert.equal(store.getFolders(), folders);

  fake.push("projects", facts("beta renamed"));
  assert.equal(notified, 2);
  assert.equal(store.getProjects()[0], first);
  assert.notEqual(store.getProjects()[1], second);
  assert.equal(store.getProjects()[1]?.label, "beta renamed");
  assert.equal(store.getFolders(), folders);
  assert.equal(store.getForLocation({ daemonId, projectId: ProjectIdSchema.parse("2") })?.label, "beta renamed");

  store.dispose();
  assert.equal(fake.released(), 2);
});

test("a read that reconciles an update before its observation callback still notifies", () => {
  const fake = fakeWorkspace();
  const store = new ProjectFactsStore(fake.workspace, () => {});
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  fake.set("projects", facts("beta"));
  assert.equal(store.getProjects().length, 2);
  fake.notify("projects");
  assert.equal(notified, 1);
  store.dispose();
});

test("folder ownership includes observed worktrees without crossing daemons", () => {
  const fake = fakeWorkspace();
  const store = new ProjectFactsStore(fake.workspace, () => {});
  const data = facts("beta");
  const target = { daemonId, projectId: ProjectIdSchema.parse("worktree") };
  const otherDaemon = DaemonIdSchema.parse(crypto.randomUUID());
  const physical = {
    id: target.projectId, kind: "git" as const, name: "worktree", rootPath: "/worktree",
    relativePath: "worktree", roots: [], lastCommitTimeMs: null,
  };
  data.projects[0]!.observedLocations = [{ ...target, hostname: "local", rootPath: "/worktree", project: physical }];
  data.projects[1]!.locations.push({
    target: { ...target, daemonId: otherDaemon }, daemonId: otherDaemon,
    hostname: "remote", name: "worktree", rootPath: "/worktree", project: physical,
  });
  fake.push("projects", data);
  assert.equal(store.getForLocation(target)?.id, data.projects[0]!.id);
  assert.equal(store.getForLocation({ ...target, daemonId: otherDaemon })?.id, data.projects[1]!.id);
  assert.equal(store.getForLocation({ ...target, projectId: ProjectIdSchema.parse("missing") }), null);
  store.dispose();
});

test("group tiers notify only when their phase or tiers change", () => {
  const fake = fakeWorkspace();
  const store = new ProjectFactsStore(fake.workspace, () => {});
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  const tiers = { orderedProjectIds: [project("1").id], unsettledProjectIds: [], unarchivedProjectIds: [project("1").id] };

  fake.push("projectGroups", tiers);
  const groups = store.getGroups();
  assert.equal(groups.phase, "current");
  fake.push("projectGroups", structuredClone(tiers));
  assert.equal(store.getGroups(), groups);
  assert.equal(notified, 1);
  store.dispose();
});
