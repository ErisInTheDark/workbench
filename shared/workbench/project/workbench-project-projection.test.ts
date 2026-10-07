/*
 * No production exports. Protect one display identity, qualified locations, and remote-label collisions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { preferredLogicalLaunchLocation, projectLogicalGroups, projectLogicalProjects, projectLogicalSummaries, projectLogicalThreadRows } from "./workbench-project-projection";
import { groupWorkbenchThreadSidebarEntries, type WorkbenchProjectThreadSidebars, type WorkbenchThreadLifecycle, type WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";

const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
const concrete = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
const remoteId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
const collisionId = LogicalProjectIdSchema.parse("a12f7e1e-81b6-4c30-bdc0-f83475981002");
const localId = LogicalProjectIdSchema.parse("b12f7e1e-81b6-4c30-bdc0-f83475981003");

test("pinned draft summaries use app facts even when retained daemon drafts disagree or the source is offline", () => {
  const draftId = DraftIdSchema.parse("40000000-0000-4000-8000-000000000001");
  const oldDraftId = DraftIdSchema.parse("40000000-0000-4000-8000-000000000002");
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
    pinnedThreads: [{
      entryKind: "draft" as const, draftId: oldDraftId, activityAt: 1, hasAttachments: false,
      metadata: { archived: false as const, pinned: true as const, snoozed: false as const },
      status: "draft" as const, title: "retained daemon draft",
    }],
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
  assert.equal(projects.length, 3);
  assert.deepEqual(projects.slice(0, 2).map(project => project.label), [
    "example.test/team/repo", "other.test/team/repo",
  ]);
  assert.equal(projects[2]?.label, "C:/other");
  assert.deepEqual(projects[0]?.locations.map(location => [
    location.hostname, location.rootPath, location.project !== null,
  ]), [["desktop", "C:/repo", true], ["laptop", "/home/repo", false]]);
  assert.equal(projects[0]?.locations[1]?.target.daemonId, second);
  assert.equal(projects[0]?.displayName, "repo");
  assert.equal(projects[0]?.displayPath, "desktop:/repo");
  assert.equal(projects[2]?.displayName, "C:/other");
  const source = (threadId: string, working: number) => ({
    projects: [{
      projectId: concrete, revision: 1, lastThreadUpdateAt: working,
      counts: { completed: 0, needsAttention: 0, needsAttentionActive: 0,
        proposedCommit: 0, stopped: 0, working },
      pinnedThreads: [],
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
  assert.equal(summaries.get(remoteId)?.counts.working, 3);
  assert.deepEqual(summaries.get(remoteId)?.unsettledThreads.map(item => [
    item.location.daemonId, item.entry.identity.threadId,
  ]), [[second, "laptop-thread"], [first, "desktop-thread"]]);
  const groups = projectLogicalGroups(projects, Object.fromEntries(summaries), new Map(), snapshot);
  assert.deepEqual(groups.unsettledProjectIds, [remoteId]);
  assert.deepEqual(groups.unarchivedProjectIds, [remoteId]);
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
  assert.equal(project.displayPath, "bak");
});

test("a daemon's own project shows its host instead of its hidden workspace and stays listed without threads", () => {
  const snapshot: PresentationSnapshot = {
    revision: 1, daemons: [{ id: first, hostname: "tower-of-floof" }],
    projects: [{ id: localId, matchKey: `daemon://${first}`, label: "tower-of-floof" }],
    locations: [{
      target: { daemonId: first, projectId: ProjectIdSchema.parse("daemon") }, logicalProjectId: localId,
      identityKey: `daemon://${first}`, name: "tower-of-floof", rootPath: "C:/data/daemon/workspace",
    }],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const projects = projectLogicalProjects(snapshot, new Map());
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
  const labels = (projects: PresentationSnapshot["projects"]) =>
    projectLogicalProjects({ ...base, projects }, new Map()).map(project => project.label);
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
    drafts: [{ target: secondTarget, logicalProjectId: remoteId, revision: 10,
      phase: "accepted" } as PresentationSnapshot["drafts"][number]],
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
  const rows = projectLogicalThreadRows(projectLogicalProjects(snapshot, new Map()), sidebars, snapshot);
  assert.deepEqual(rows.map(row => [row.logicalProjectId, row.location.daemonId,
    row.entry.entryKind === "thread" ? row.entry.identity.threadId : null]), [
    [remoteId, first, "first-thread"], [remoteId, second, "second-thread"],
  ]);
});

test("merged project rows keep priority and lifecycle layers across daemon folders", () => {
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
  };
  const completed: WorkbenchThreadLifecycle = { kind: "completed", reason: "providerInactive", settled: false };
  const attention: WorkbenchThreadLifecycle = { kind: "needsAttention", reason: "noActiveTurn", settled: false };
  const working: WorkbenchThreadLifecycle = {
    kind: "working", reason: "acceptedIntent", settled: false,
    agent: { agentStatus: "working", turnId: WorkbenchTurnIdSchema.parse("turn") },
  };
  const thread = (
    id: string, activityAt: number, lifecycle: WorkbenchThreadLifecycle,
    options: { claimed?: boolean; pinned?: boolean; snoozed?: boolean } = {},
  ): WorkbenchThreadSidebarEntry => ({
    entryKind: "thread", title: id, activityAt,
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(id) },
    lifecycle,
    metadata: { archived: false, pinned: options.pinned ?? false, snoozed: options.snoozed ?? false },
    ...(options.claimed ? { gitArc: {
      checkpointCommit: "a".repeat(40), claimedPaths: ["src/file.ts"], intentDescription: "",
      intentName: id, phase: "active" as const, proposals: [], updatedAt: "2026-08-25T00:00:00.000Z",
    } } : {}),
  });
  const sources: ReadonlyMap<typeof first, WorkbenchProjectThreadSidebars> = new Map([
    [first, { projects: [{ projectId: concrete, revision: 1, error: null, freshness: "fresh", entries: [
      thread("attention", 3, attention),
      thread("claimed", 1, completed, { claimed: true }),
      thread("pinned", 1, completed, { pinned: true }),
      thread("settled", 11, { ...completed, settled: true }),
    ] }] }],
    [second, { projects: [{ projectId: concrete, revision: 1, error: null, freshness: "fresh", entries: [
      thread("complete", 9, completed),
      thread("working", 4, working),
      thread("snoozed", 10, attention, { snoozed: true }),
    ] }] }],
  ]);
  const rows = projectLogicalThreadRows(projectLogicalProjects(snapshot, new Map()), sources, snapshot);
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
  const rows = projectLogicalThreadRows(projects, sidebars, snapshot);
  assert.equal(rows[0]?.entry.entryKind, "thread");
  assert.equal(rows[0]?.observedOnly, true);
});
