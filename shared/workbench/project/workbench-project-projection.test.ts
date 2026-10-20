/*
 * No production exports. Protect one display identity, qualified locations, remote-label collisions, hidden and retired
 * folders, folderless identities and collision-only project paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import {
  materializeWorkspaceThreadRow, preferredLogicalLaunchLocation, preferredSelectedLaunchTarget,
  projectLogicalGroups, projectLogicalProjects, projectLogicalSummaries, projectLogicalThreadRows,
  projectWorkbenchThreadMembership,
} from "./workbench-project-projection";
import { groupWorkbenchThreadSidebarEntries, type WorkbenchProjectThreadSidebars, type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";

const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
const concrete = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
const remoteId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
const collisionId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
const localId = LogicalProjectIdSchema.parse("b12f7e1e-81b6-4c30-bdc0-f83475981003");

test("pinned draft summaries use app facts even when the source is offline", () => {
  const draftId = DraftIdSchema.parse("40000000-0000-4000-8000-000000000001");
  const location = { daemonId: first, projectId: concrete };
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [], projects: [{ id: localId, label: "local", matchKey: "local://C:/repo" }],
    locations: [{ target: location, logicalProjectId: localId, identityKey: "local://C:/repo", name: "repo", rootPath: "C:/repo" }],
    defaults: [], folders: [], members: [], divergences: [], sourceMappings: [],
    drafts: [{
      id: draftId, logicalProjectId: localId, target: location, prompt: "app draft", updatedAt: 2,
      phase: "unsent", revision: 1, pinned: true, snoozed: false, launchId: null, acceptedThreadId: null,
      attachments: [{ id: "image", mediaType: "image/png", contentHash: "stored" }],
      selection: { kind: "custom", settings: { harness: "codex", model: "", agentPath: null,
        agentSource: null, reasoningEffort: null, serviceTier: null } },
    }],
  };
  const projects = projectLogicalProjects(snapshot, new Map());
  const sources = new Map([[first, { projects: [{
    projectId: concrete, revision: 1, lastThreadUpdateAt: null,
    counts: { working: 0, needsAttention: 0, needsAttentionActive: 0, completed: 0, stopped: 0, proposedCommit: 0 },
    unsettledThreads: [],
  }] }]]);
  const entries = projectLogicalSummaries(projects, sources, snapshot).get(localId)!.pinnedThreads;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.entry.entryKind === "draft" ? entries[0].entry.draftId : null, draftId);
  assert.equal(entries[0]?.entry.entryKind === "draft" && entries[0].entry.hasAttachments, true);
  assert.deepEqual(projectLogicalGroups(projects, {}, new Map(), snapshot).unarchivedProjectIds, [localId]);
  snapshot.drafts[0]!.phase = "deleted";
  assert.deepEqual(projectLogicalSummaries(projects, sources, snapshot).get(localId)!.pinnedThreads, []);
  assert.deepEqual(projectLogicalGroups(projects, {}, new Map(), snapshot).unarchivedProjectIds, []);
});

test("pinned thread summaries come from the app's watched rows in the project's own folders, never settled or snoozed ones", () => {
  const location = { daemonId: first, projectId: concrete };
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [], projects: [{ id: localId, label: "local", matchKey: "local://C:/repo" }],
    locations: [{ target: location, logicalProjectId: localId, identityKey: "local://C:/repo", name: "repo", rootPath: "C:/repo" }],
    defaults: [], folders: [], members: [], divergences: [], sourceMappings: [], drafts: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map());
  const row = (threadId: string, lifecycle: WorkbenchThreadLifecycle, snoozed = false): WorkbenchThreadSidebarEntry => ({
    entryKind: "thread", title: threadId, activityAt: 1, lifecycle,
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(threadId) },
    metadata: { archived: false, pinned: true, snoozed },
  });
  const completed: WorkbenchThreadLifecycle = { kind: "completed", reason: "providerInactive", settled: false };
  const pinnedRows = new Map([
    ["kept", { location, row: row("kept", completed) }],
    ["settled", { location, row: row("settled", { ...completed, settled: true }) }],
    ["snoozed", { location, row: row("snoozed", completed, true) }],
    ["elsewhere", { location: { daemonId: second, projectId: concrete }, row: row("elsewhere", completed) }],
  ]);
  const pinned = projectLogicalSummaries(projects, new Map(), snapshot, pinnedRows).get(localId)!.pinnedThreads;
  assert.deepEqual(pinned.map(item => item.entry.entryKind === "thread" ? item.entry.identity.threadId : null), ["kept"]);
  assert.equal(pinned[0]?.entry.entryKind === "thread" && pinned[0].entry.status, "completed");
});

function catalog(rootPath: string): WorkbenchProjectOption {
  return { id: concrete, kind: "git", name: "repo", relativePath: "repo", rootPath,
    lastCommitTimeMs: null, roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath }] };
}

test("remote identity has one row, collisions show hosts, and unavailable locations keep their own labels", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [
      { id: remoteId, matchKey: "remote://example.test/team/repo", label: "example.test/team/repo" },
      { id: collisionId, matchKey: "remote://other.test/team/repo", label: "other.test/team/repo" },
      { id: localId, matchKey: "local://C:/other/.git", label: "C:/other" },
    ],
    locations: [
      { target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" },
      { target: { daemonId: second, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "/home/repo" },
      { target: { daemonId: second, projectId: ProjectIdSchema.parse("other") }, logicalProjectId: collisionId,
        identityKey: "remote://other.test/team/repo", name: "repo", rootPath: "/home/other" },
    ],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map([[first, [catalog("C:/repo")]]]));
  // The local identity owns no folders, so there is nothing to list.
  assert.deepEqual(projects.map(project => project.label), [
    "example.test/team/repo", "other.test/team/repo",
  ]);
  assert.deepEqual(projects[0]?.locations.map(location => [
    location.hostname, location.rootPath, location.project !== null,
  ]), [["desktop", "C:/repo", true], ["laptop", "/home/repo", false]]);
  assert.equal(projects[0]?.locations[1]?.target.daemonId, second);
  assert.equal(projects[0]?.displayName, "repo");
  // Both projects read "repo", so the folder path tells them apart.
  assert.equal(projects[0]?.displayPath, "desktop:/repo");
  const source = (threadId: string, working: number) => ({
    projects: [{
      projectId: concrete, revision: 1, lastThreadUpdateAt: working,
      counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0,
        proposedCommit: 0, stopped: 0, working },
      unsettledThreads: [{
        activityAt: working, identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(threadId) },
        status: "working" as const, title: threadId,
      }],
    }],
  });
  const summaries = projectLogicalSummaries(projects, new Map([
    [first, source("desktop-thread", 1)],
    [second, source("laptop-thread", 2)],
  ]), snapshot);
  assert.equal(summaries.get(remoteId)?.counts.working, 2);
  assert.deepEqual(summaries.get(remoteId)?.unsettledThreads.map(item => [
    item.location.daemonId, item.entry.identity.threadId,
  ]), [[second, "laptop-thread"], [first, "desktop-thread"]]);
  const groups = projectLogicalGroups(projects, Object.fromEntries(summaries), new Map(), snapshot);
  assert.deepEqual(groups.unsettledProjectIds, [remoteId]);
  assert.deepEqual(groups.unarchivedProjectIds, [remoteId]);
});

test("hidden registered and observed folders leave every projection and only remain listed as hidden", () => {
  const observedId = ProjectIdSchema.parse("observed");
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "example.test/team/repo" }],
    locations: [
      { target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" },
      { target: { daemonId: second, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "/home/repo" },
    ],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
    hiddenLocations: [
      { logicalProjectId: remoteId, target: { daemonId: second, projectId: concrete } },
      { logicalProjectId: remoteId, target: { daemonId: second, projectId: observedId } },
    ],
  };
  const observations = new Map([[second, { hostname: "laptop", data: [{
    identityKey: ProjectIdentityKeySchema.parse("remote://example.test/team/repo"),
    rootIdentityKeys: [ProjectIdentityKeySchema.parse("remote://example.test/team/repo")],
    project: { ...catalog("/home/clone"), id: observedId },
  }] }]]);
  const [project] = projectLogicalProjects(snapshot, new Map(), observations);
  assert.deepEqual(project?.locations.map(location => location.target.daemonId), [first]);
  assert.equal(project?.observedLocations, undefined);
  assert.deepEqual(project?.hiddenLocations?.map(location => [location.daemonId, location.projectId]),
    [[second, concrete], [second, observedId]]);
  // With one visible daemon left, the path no longer needs its host prefix.
  assert.equal(project?.locations[0]?.displayPath, "repo");
  const working = (threadId: string) => ({ projects: [{
    projectId: concrete, revision: 1, lastThreadUpdateAt: 1,
    counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0, proposedCommit: 0, stopped: 0, working: 1 },
    unsettledThreads: [{ activityAt: 1, status: "working" as const, title: threadId,
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(threadId) } }],
  }] });
  const summary = projectLogicalSummaries([project!], new Map([[first, working("desktop")], [second, working("laptop")]]), snapshot)
    .get(remoteId);
  assert.equal(summary?.counts.working, 1);
  assert.deepEqual(summary?.unsettledThreads.map(item => item.location.daemonId), [first]);
});

test("a local project's name stays separate from its shortest daemon folder address", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "tower-of-floof" }],
    projects: [{ id: localId, matchKey: "local://c:/git/app/bak/.git", label: "C:/git/app/bak" }],
    locations: [{
      target: { daemonId: first, projectId: concrete }, logicalProjectId: localId,
      identityKey: "local://c:/git/app/bak/.git", name: "bak", rootPath: "C:/git/app/bak",
    }],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const project = projectLogicalProjects(snapshot, new Map([[first, [catalog("C:/git/app/bak")]]]))[0]!;
  assert.equal(project.displayName, "bak");
  assert.equal(project.locations[0]?.displayPath, "bak");
});

test("a project only carries a folder path when another listed project reads the same", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [
      { id: remoteId, matchKey: "remote://example.test/team/transition-rust", label: "example.test/team/transition-rust" },
      { id: collisionId, matchKey: "local://c:/one/app/.git", label: "C:/one/app" },
      { id: localId, matchKey: "local://c:/two/app/.git", label: "C:/two/app" },
    ],
    locations: [
      { target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/transition-rust", name: "transition", rootPath: "C:/rust/transition" },
      { target: { daemonId: second, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/transition-rust", name: "transition-rust", rootPath: "/home/transition-rust" },
      { target: { daemonId: first, projectId: ProjectIdSchema.parse("one") }, logicalProjectId: collisionId,
        identityKey: "local://c:/one/app/.git", name: "app", rootPath: "C:/one/app" },
      { target: { daemonId: first, projectId: ProjectIdSchema.parse("two") }, logicalProjectId: localId,
        identityKey: "local://c:/two/app/.git", name: "App", rootPath: "C:/two/app" },
    ],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map());
  assert.deepEqual(projects.map(project => [project.displayName, project.displayPath]), [
    ["transition-rust", null], ["app", "one/app"], ["App", "two/app"],
  ]);
  assert.deepEqual(projects[0]?.locations.map(location => location.displayPath), [
    "desktop:/transition", "laptop:/transition-rust",
  ]);
});

test("folders a connected daemon stopped cataloguing drop out, while offline daemons keep theirs", () => {
  const retiredId = LogicalProjectIdSchema.parse("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [
      { id: remoteId, matchKey: "remote://example.test/team/repo", label: "example.test/team/repo" },
      { id: retiredId, matchKey: "remote://file:///C:/sandbox/source", label: "C:/sandbox/wb" },
    ],
    locations: [
      { target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" },
      { target: { daemonId: first, projectId: ProjectIdSchema.parse("gone") }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo+old", rootPath: "C:/repo+old" },
      { target: { daemonId: second, projectId: concrete }, logicalProjectId: remoteId,
        identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "/home/repo" },
      { target: { daemonId: first, projectId: ProjectIdSchema.parse("sandbox") }, logicalProjectId: retiredId,
        identityKey: "remote://file:///C:/sandbox/source", name: "0123abcd", rootPath: "C:/sandbox/wb" },
    ],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map([[first, [catalog("C:/repo")]]]));
  assert.deepEqual(projects.map(project => project.id), [remoteId]);
  assert.deepEqual(projects[0]?.locations.map(location => [location.hostname, location.rootPath, location.project !== null]), [
    ["desktop", "C:/repo", true], ["laptop", "/home/repo", false],
  ]);
});

test("a daemon's own project shows its host instead of its hidden workspace and stays listed without threads", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "tower-of-floof" }],
    projects: [{ id: localId, matchKey: `daemon://${first}`, label: "tower-of-floof" }],
    locations: [{
      target: { daemonId: first, projectId: ProjectIdSchema.parse("daemon") }, logicalProjectId: localId,
      identityKey: `daemon://${first}`, name: "nixos", rootPath: "C:/data/daemon/workspace",
    }],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map());
  assert.equal(projects[0]?.label, "tower-of-floof");
  assert.equal(projects[0]?.displayName, "tower-of-floof");
  assert.equal(projects[0]?.displayPath, null);
  assert.equal(projects[0]?.locations[0]?.displayPath, "tower-of-floof");
  assert.deepEqual(projectLogicalGroups(projects, {}, new Map(), snapshot).unarchivedProjectIds, [localId]);
});

test("one-daemon worktree locations use distinct short names without a redundant host", () => {
  const root = "C:/git/web/workbench";
  const worktree = `${root}/.workbench/worktrees/convex-lab`;
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "tower-of-floof" }],
    projects: [{ id: localId, matchKey: "remote://example.test/workbench", label: "workbench" }],
    locations: [root, worktree].map((rootPath, index) => ({
      target: { daemonId: first, projectId: ProjectIdSchema.parse(`folder-${index}`) },
      logicalProjectId: localId, identityKey: "remote://example.test/workbench",
      name: index ? "convex-lab" : "workbench", rootPath,
    })),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const project = projectLogicalProjects(snapshot, new Map());
  assert.deepEqual(project[0]?.locations.map(location => location.displayPath), ["workbench", "+convex-lab"]);

  const secondHost = {
    ...snapshot,
    daemons: [...snapshot.daemons, { id: second, hostname: "laptop" }],
    locations: [...snapshot.locations, {
      ...snapshot.locations[0]!,
      target: { daemonId: second, projectId: ProjectIdSchema.parse("laptop-folder") },
      rootPath: "/home/workbench",
    }],
  };
  const qualified = projectLogicalProjects(secondHost, new Map())[0]!;
  assert.deepEqual(qualified.locations.map(location => location.displayPath), [
    "laptop:/workbench", "tower-of-floof:/workbench", "tower-of-floof:/+convex-lab",
  ]);
});

test("duplicate worktree names keep an unambiguous folder address", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "tower-of-floof" }],
    projects: [{ id: localId, matchKey: "remote://example.test/workbench", label: "workbench" }],
    locations: ["C:/first/.workbench/worktrees/lab", "C:/second/.workbench/worktrees/lab"].map((rootPath, index) => ({
      target: { daemonId: first, projectId: ProjectIdSchema.parse(`folder-${index}`) },
      logicalProjectId: localId, identityKey: "remote://example.test/workbench", name: "lab", rootPath,
    })),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const paths = projectLogicalProjects(snapshot, new Map())[0]!.locations.map(location => location.displayPath);
  assert.equal(new Set(paths).size, 2);
  assert(paths.every(path => path?.includes("+lab")));
});

test("remote project labels use the shortest unambiguous repository suffix", () => {
  const base: PresentationSnapshot = {
    revision: 1, daemons: [], locations: [], defaults: [], drafts: [], folders: [],
    members: [], divergences: [], sourceMappings: [],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "example.test/team/repo" }],
  };
  // Each identity owns one folder; folderless identities are not listed.
  const labels = (projects: PresentationSnapshot["projects"]) => projectLogicalProjects({
    ...base, projects,
    locations: projects.map((project, index) => ({
      target: { daemonId: first, projectId: ProjectIdSchema.parse(`folder-${index}`) }, logicalProjectId: project.id,
      identityKey: project.matchKey, name: "repo", rootPath: `C:/folder-${index}/repo`,
    })),
  }, new Map()).map(project => project.label);
  assert.deepEqual(labels(base.projects), ["repo"]);
  assert.deepEqual(labels([
    ...base.projects,
    { id: collisionId, matchKey: "remote://example.test/other/repo", label: "example.test/other/repo" },
  ]), ["team/repo", "other/repo"]);
  assert.deepEqual(labels([
    ...base.projects,
    { id: collisionId, matchKey: "remote://other.test/team/repo", label: "other.test/team/repo" },
  ]), ["example.test/team/repo", "other.test/team/repo"]);
  assert.deepEqual(labels([
    ...base.projects,
    { id: localId, matchKey: "local://C:/git/repo", label: "repo" },
  ]), ["team/repo", "local://C:/git/repo"]);
  assert.deepEqual(labels([
    ...base.projects,
    { id: collisionId, matchKey: "remote://example.test/group/other/repo", label: "other/repo" },
  ]), ["team/repo", "other/repo"]);
});

test("launch suggestion follows the latest used target inside one logical project", () => {
  const firstTarget = { daemonId: first, projectId: concrete };
  const secondTarget = { daemonId: second, projectId: concrete };
  const snapshot: PresentationSnapshot = {
    revision: 15,
    daemons: [],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [firstTarget, secondTarget].map(target => ({
      target, logicalProjectId: remoteId, identityKey: "remote://example.test/team/repo",
      name: "repo", rootPath: "C:/repo",
    })),
    defaults: [{ target: firstTarget, revision: 5,
      selection: {} as PresentationSnapshot["defaults"][number]["selection"] }],
    drafts: [],
    recentLaunches: [{ target: secondTarget, logicalProjectId: remoteId, revision: 10 }],
    folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const project = projectLogicalProjects(snapshot, new Map([
    [first, [catalog("C:/repo")]], [second, [catalog("/home/repo")]],
  ]))[0]!;
  assert.deepEqual(preferredLogicalLaunchLocation(project, snapshot), secondTarget);
  const available = { ...snapshot, locations: snapshot.locations.slice(0, 1) };
  assert.deepEqual(preferredLogicalLaunchLocation(
    projectLogicalProjects(available, new Map([[first, [catalog("C:/repo")]]]))[0]!, available,
  ), firstTarget);
});

test("selected launch target ignores newer accepted threads outside the selected projects", () => {
  const firstTarget = { daemonId: first, projectId: concrete };
  const secondTarget = { daemonId: second, projectId: ProjectIdSchema.parse("c597a4b6-7af9-41f1-83ea-a53aed6f3b0b") };
  const unavailableTarget = { daemonId: second, projectId: ProjectIdSchema.parse("d597a4b6-7af9-41f1-83ea-a53aed6f3b0c") };
  const snapshot: PresentationSnapshot = {
    revision: 20,
    daemons: [],
    projects: [
      { id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" },
      { id: localId, matchKey: "local://C:/local", label: "local" },
    ],
    locations: [
      { target: firstTarget, logicalProjectId: remoteId, identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" },
      { target: secondTarget, logicalProjectId: localId, identityKey: "local://C:/local", name: "local", rootPath: "C:/local" },
    ],
    defaults: [],
    recentLaunches: [
      { logicalProjectId: remoteId, target: firstTarget, revision: 10 },
      { logicalProjectId: localId, target: secondTarget, revision: 12 },
      { logicalProjectId: localId, target: unavailableTarget, revision: 16 },
    ],
    drafts: [
      { id: DraftIdSchema.parse("40000000-0000-4000-8000-000000000013"), logicalProjectId: remoteId,
        target: firstTarget, prompt: "", updatedAt: 3, revision: 14, phase: "unsent",
        pinned: false, snoozed: false, launchId: null, acceptedThreadId: null, attachments: [],
        selection: {} as PresentationSnapshot["drafts"][number]["selection"] },
    ],
    folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map([
    [first, [catalog("C:/repo")]],
    [second, [{ ...catalog("C:/local"), id: secondTarget.projectId }]],
  ]));

  assert.deepEqual(preferredSelectedLaunchTarget(projects, [remoteId], snapshot), {
    project: projects.find(project => project.id === remoteId),
    location: firstTarget,
  });
  assert.deepEqual(preferredSelectedLaunchTarget(projects, [remoteId, localId], snapshot), {
    project: projects.find(project => project.id === localId),
    location: secondTarget,
  });
  assert.deepEqual(preferredSelectedLaunchTarget(projects, [remoteId, localId], { ...snapshot, recentLaunches: [] }), {
    project: projects.find(project => project.id === remoteId),
    location: firstTarget,
  });
  assert.equal(preferredSelectedLaunchTarget(projects, [], snapshot), null);
});

test("one logical project includes thread rows from both daemon folders", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1,
    daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [first, second].map(daemonId => ({
      target: { daemonId, projectId: concrete }, logicalProjectId: remoteId,
      identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo",
    })),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const entry = (id: string): WorkbenchProjectThreadSidebars["projects"][number]["entries"][number] => ({
    entryKind: "thread", title: id, activityAt: 1,
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(id) },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
  });
  const sidebars = new Map([
    [first, { projects: [{ projectId: concrete, revision: 1, error: null,
      freshness: "fresh" as const, entries: [entry("first-thread")] }] }],
    [second, { projects: [{ projectId: concrete, revision: 1, error: null,
      freshness: "fresh" as const, entries: [entry("second-thread")] }] }],
  ]);
  const rows = projectLogicalThreadRows(projectLogicalProjects(snapshot, new Map()), sidebars, snapshot, new Set());
  assert.deepEqual(rows.map(row => [row.logicalProjectId, row.location.daemonId,
    row.entry.entryKind === "thread" ? row.entry.identity.threadId : null]), [
    [remoteId, first, "first-thread"], [remoteId, second, "second-thread"],
  ]);
});

test("app snoozes place and count rows on any daemon, waiting on targets elsewhere", () => {
  const target = { identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("target") },
    projectId: concrete, title: "Target" };
  const snapshot: PresentationSnapshot = {
    revision: 1,
    daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [first, second].map(daemonId => ({
      target: { daemonId, projectId: concrete }, logicalProjectId: remoteId,
      identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo",
    })),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
    threadSnoozes: ["waiting", "attention"].map(id => ({
      threadId: WorkbenchThreadIdSchema.parse(id), basis: { lifecycleKind: "completed" as const, turnId: null, questionnaireKey: null },
      targets: id === "waiting" ? [target] : [],
    })),
  };
  const entry = (id: string, status: "completed" | "needsAttentionActive") => ({
    activityAt: 1, status, title: id, identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(id) },
  });
  const project = projectLogicalProjects(snapshot, new Map())[0]!;
  const summary = projectLogicalSummaries([project], new Map([
    [first, { projects: [{ projectId: concrete, revision: 1, lastThreadUpdateAt: 1,
      counts: { completed: 1, needsAttention: 0, needsAttentionActive: 1, proposedCommit: 0, stopped: 0, working: 0 },
      unsettledThreads: [entry("waiting", "completed"), entry("attention", "needsAttentionActive")] }] }],
  ]), snapshot).get(remoteId)!;
  assert.deepEqual([summary.counts.completed, summary.counts.needsAttention, summary.counts.needsAttentionActive], [0, 1, 0]);

  const rows = projectLogicalThreadRows([project], new Map([[first, { projects: [{ projectId: concrete, entries: [{
    entryKind: "thread" as const, title: "waiting", activityAt: 1,
    identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("waiting") },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false },
    metadata: { archived: false as const, pinned: false, snoozed: false },
  }] }] }]]), snapshot, new Set());
  const waiting = rows[0]!.entry;
  assert.ok(waiting.entryKind === "thread");
  assert.equal(waiting.metadata.snoozed, true);
  assert.equal(waiting.waitingFor, "other");
  assert.deepEqual(waiting.waitingOnThreads, [target]);
});

test("an in-flight launch's draft holds its new thread's slot until accepted; an orphaned reservation is a plain draft", () => {
  const launchId = "dc085242-b595-4a51-9bd0-099013ead304";
  const orphanLaunchId = "dc085242-b595-4a51-9bd0-099013ead305";
  const draft = (id: string, prompt: string, updatedAt: number, launch: string | null): PresentationSnapshot["drafts"][number] => ({
    id: DraftIdSchema.parse(id), logicalProjectId: remoteId, target: { daemonId: first, projectId: concrete },
    prompt, selection: { kind: "custom", settings: {
      agentPath: null, agentSource: null, harness: "codex", model: "", reasoningEffort: null, serviceTier: null,
    } },
    updatedAt, revision: 1, phase: launch ? "submitting" : "unsent", pinned: false, snoozed: false,
    launchId: launch, acceptedThreadId: null, attachments: [],
  });
  const presentation = (drafts: PresentationSnapshot["drafts"]): PresentationSnapshot => ({
    revision: 1, daemons: [{ id: first, hostname: "desktop" }],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [{ target: { daemonId: first, projectId: concrete }, logicalProjectId: remoteId,
      identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo" }],
    defaults: [], drafts, folders: [], members: [], divergences: [], sourceMappings: [],
  });
  const working: WorkbenchThreadLifecycle = { kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working" } };
  const thread = (id: string, orderAt: number, lifecycle: WorkbenchThreadLifecycle, launch?: string): WorkbenchThreadSidebarEntry => ({
    entryKind: "thread", title: id, activityAt: orderAt, orderAt,
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(id) },
    lifecycle, metadata: { archived: false, pinned: false, snoozed: false }, ...(launch ? { launchId: launch } : {}),
  });
  const sources: ReadonlyMap<typeof first, WorkbenchProjectThreadSidebars> = new Map([[first, { projects: [{
    projectId: concrete, revision: 1, error: null, freshness: "fresh", entries: [
      thread("attention", 1, { kind: "needsAttention", reason: "noActiveTurn", settled: false }),
      thread("launched", 60, working, launchId),
      thread("orphan-thread", 40, working, orphanLaunchId),
      thread("older-working", 5, working),
    ],
  }] }]]);
  const launchingDraftId = "00000000-0000-4000-8000-000000000002";
  const titles = (snapshot: PresentationSnapshot) => projectLogicalThreadRows(
    projectLogicalProjects(snapshot, new Map()), sources, snapshot, new Set([launchingDraftId]),
  ).map(row => row.entry.title);

  const idea = draft("00000000-0000-4000-8000-000000000001", "idea", 2, null);
  const orphan = draft("00000000-0000-4000-8000-000000000003", "orphan", 3, orphanLaunchId);
  assert.deepEqual(titles(presentation([idea, orphan, draft(launchingDraftId, "launch me", 50, launchId)])),
    ["orphan", "idea", "attention", "launch me", "orphan-thread", "older-working"]);
  assert.deepEqual(titles(presentation([idea, orphan])),
    ["orphan", "idea", "attention", "launched", "orphan-thread", "older-working"]);
});

test("merged project rows keep priority and lifecycle layers across daemon folders, and membership places them the same way", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1,
    daemons: [{ id: first, hostname: "desktop" }, { id: second, hostname: "laptop" }],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [first, second].map(daemonId => ({
      target: { daemonId, projectId: concrete }, logicalProjectId: remoteId,
      identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "C:/repo",
    })),
    defaults: [], drafts: [{
      id: DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
      logicalProjectId: remoteId, target: { daemonId: second, projectId: concrete },
      prompt: "draft", selection: { kind: "custom", settings: {
        agentPath: null, agentSource: null, harness: "codex", model: "",
        reasoningEffort: null, serviceTier: null,
      } },
      updatedAt: 2, revision: 1, phase: "unsent", pinned: false, snoozed: false,
      launchId: null, acceptedThreadId: null, attachments: [],
    }], folders: [], members: [], divergences: [], sourceMappings: [],
    threadSnoozes: [{ threadId: WorkbenchThreadIdSchema.parse("snoozed"), targets: [],
      basis: { lifecycleKind: "needsAttention", turnId: null, questionnaireKey: null } }],
    threadPins: [WorkbenchThreadIdSchema.parse("pinned")],
  };
  const completed: WorkbenchThreadLifecycle = { kind: "completed", reason: "providerInactive", settled: false };
  const attention: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };
  const working: WorkbenchThreadLifecycle = {
    kind: "working", reason: "acceptedIntent", settled: false,
    agent: { agentStatus: "working", turnId: WorkbenchTurnIdSchema.parse("turn") },
  };
  const thread = (
    id: string, activityAt: number, lifecycle: WorkbenchThreadLifecycle,
    options: { claimed?: boolean; pinned?: boolean } = {},
  ): WorkbenchThreadSidebarEntry => ({
    entryKind: "thread", title: id, activityAt,
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(id) },
    lifecycle,
    metadata: { archived: false, pinned: options.pinned ?? false, snoozed: false },
    ...(options.claimed ? { gitArc: {
      checkpointCommit: "a".repeat(40), claimedPaths: ["src/file.ts"], intentDescription: "",
      intentName: id, phase: "active" as const, proposals: [], updatedAt: "2026-08-25T00:00:00.000Z",
    } } : {}),
  });
  const sources: ReadonlyMap<typeof first, WorkbenchProjectThreadSidebars> = new Map([
    [first, { projects: [{ projectId: concrete, revision: 1, error: null, freshness: "fresh", entries: [
      thread("attention", 3, attention),
      thread("claimed", 1, completed, { claimed: true }),
      thread("pinned", 1, completed),
      thread("settled", 11, { ...completed, settled: true }),
    ] }] }],
    [second, { projects: [{ projectId: concrete, revision: 1, error: null, freshness: "fresh", entries: [
      // A stale daemon flag cannot pin; only the app's pins place a thread.
      thread("complete", 9, completed, { pinned: true }),
      thread("working", 4, working),
      thread("snoozed", 10, attention),
    ] }] }],
  ]);
  const rows = projectLogicalThreadRows(projectLogicalProjects(snapshot, new Map()), sources, snapshot, new Set());
  const title = (entry: { title: string }) => entry.title;
  assert.deepEqual(rows.map(row => title(row.entry)), [
    "pinned", "claimed", "draft", "attention", "working", "complete", "snoozed", "settled",
  ]);
  const grouped = groupWorkbenchThreadSidebarEntries(rows.map(row => row.entry));
  assert.deepEqual(grouped.mainEntries.map(title), ["claimed", "draft", "attention", "working", "complete"]);
  assert.deepEqual(grouped.pinnedEntries.map(title), ["pinned"]);
  assert.deepEqual(grouped.snoozedEntries.map(title), ["snoozed"]);
  assert.deepEqual(grouped.settledEntries.map(title), ["settled"]);
  assert.equal(rows.find(row => row.entry.title === "working")?.location.daemonId, second);
  assert.equal(rows.find(row => row.entry.title === "claimed")?.location.daemonId, first);

  // The app server ships the same sections as placement keys; members carry everything a row needs to come back.
  const membership = projectWorkbenchThreadMembership(rows, snapshot);
  const byKey = new Map(membership.members.map(member => [member.homeKey, member]));
  const titles = (keys: readonly string[]) => keys.map(key => byKey.get(key)?.title);
  const itemTitles = (items: typeof membership.placement.pinned) =>
    titles(items.flatMap(item => item.kind === "thread" ? [item.key] : item.keys));
  assert.deepEqual(titles(membership.placement.main), ["claimed", "draft", "attention", "working", "complete"]);
  assert.deepEqual(itemTitles(membership.placement.pinned), ["pinned"]);
  assert.deepEqual(itemTitles(membership.placement.snoozed), ["snoozed"]);
  assert.deepEqual(itemTitles(membership.placement.settled), ["settled"]);
  assert.deepEqual(byKey.get(membership.placement.main[1]!)?.ref, { kind: "draft", draftId: "00000000-0000-4000-8000-000000000001" });
  for (const [index, member] of membership.members.entries()) {
    assert.deepEqual(materializeWorkspaceThreadRow(member, rows[index]!.entry), rows[index]);
  }
  const snoozedWork = projectWorkbenchThreadMembership(rows.map(row =>
    row.entry.entryKind === "thread" && !row.entry.metadata.archived && row.entry.title === "working"
      ? { ...row, entry: { ...row.entry, metadata: { ...row.entry.metadata, snoozed: true } } }
      : row), snapshot);
  assert.deepEqual(titles(snoozedWork.placement.working ?? []), ["working"]);
  assert.deepEqual(titles(snoozedWork.placement.main), ["claimed", "draft", "attention", "complete"]);
  assert.deepEqual(itemTitles(snoozedWork.placement.snoozed), ["snoozed"]);

  // A browser's settled page lists only that much history, and subagents ride on their parent instead of as rows.
  const parent = rows.find(row => row.entry.title === "claimed")!;
  if (parent.entry.entryKind !== "thread") throw new Error("Expected the claimed parent thread.");
  const child = {
    ...parent,
    entry: {
      entryKind: "subagent" as const, title: "child", activityAt: 1, createdAt: 1, updatedAt: 1, cwd: "C:/repo",
      directSubagentIndex: 0, name: "Lily", parentThreadId: parent.entry.identity.threadId, pinned: false,
      profileId: "", profileName: "", projectId: concrete,
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("child") },
      lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
      gitArc: { checkpointCommit: "a".repeat(40), phase: "active" as const, claimedPaths: ["child.ts"] as [string], proposals: [] },
    },
  };
  const closed = projectWorkbenchThreadMembership([...rows, child], snapshot, { settledLimit: 0 });
  const closedTitles = closed.members.map(member => member.title);
  assert.deepEqual(closed.placement.settled, []);
  assert.equal(closed.placement.settledCount, 1);
  assert.ok(!closedTitles.includes("settled") && !closedTitles.includes("child"), "closed history and subagents stay app-side");
  assert.deepEqual(closed.members.find(member => member.title === "claimed")?.subagentClaims?.map(claim => claim.claimedPaths), [["child.ts"]]);
  const open = projectWorkbenchThreadMembership([...rows, child], snapshot, { settledLimit: 5 });
  assert.ok(open.members.some(member => member.title === "settled"));
});

test("observed daemon facts show Home rows without becoming persisted launch targets", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1,
    daemons: [],
    projects: [{ id: remoteId, matchKey: "remote://example.test/team/repo", label: "repo" }],
    locations: [], defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const observed = new Map([[first, {
    hostname: "desktop",
    data: [{
      identityKey: ProjectIdentityKeySchema.parse("remote://example.test/team/repo"),
      rootIdentityKeys: [],
      project: catalog("C:/repo"),
    }],
  }]]);
  const projects = projectLogicalProjects(snapshot, new Map([[first, [catalog("C:/repo")]]]), observed);
  assert.equal(projects[0]?.locations.length, 0);
  assert.equal(projects[0]?.observedLocations?.[0]?.project.id, concrete);
  assert.equal(preferredLogicalLaunchLocation(projects[0]!, snapshot), null);
  const sidebars: ReadonlyMap<typeof first, WorkbenchProjectThreadSidebars> = new Map([[first, {
    projects: [{
      projectId: concrete, revision: 1, error: null, freshness: "fresh",
      entries: [{
        entryKind: "thread", title: "Observed thread", activityAt: 1,
        identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse("observed-thread") },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false },
      }],
    }],
  }]]);
  const rows = projectLogicalThreadRows(projects, sidebars, snapshot, new Set());
  assert.equal(rows[0]?.entry.entryKind, "thread");
  assert.equal(rows[0]?.observedOnly, true);
});
