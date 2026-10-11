/* No exports. Protect source-qualified sidebar replacement, stable external-store snapshots and quiet listing pushes. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadListing } from "workbench-shared/types";
import {
  DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import ThreadSidebarClient from "./ThreadSidebarClient";

type Location = { daemonId: ReturnType<typeof DaemonIdSchema.parse>; projectId: ReturnType<typeof ProjectIdSchema.parse> };
function rowsFor(location: Location, sidebar: WorkbenchThreadSidebarSnapshot) {
  return sidebar.entries.map(entry => ({ logicalProjectId: null, location, hostname: "local", rootPath: "/project", entry }));
}
function projectsFor(...locations: Location[]): WorkspaceThreadRows["projects"] {
  return locations.map(location => ({ location, phase: "current" as const, failure: null }));
}

test("switching between equal physical project IDs never retains the previous daemon's rows", async () => {
  const projectId = ProjectIdSchema.parse("project");
  const a = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
  const b = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
  const snapshots: Array<WorkbenchThreadSidebarSnapshot | null> = [];
  const client = new ThreadSidebarClient({
    onChange: value => snapshots.push(value),
    remove: async () => { throw new Error("Unexpected mutation."); },
    move: async () => { throw new Error("Unexpected mutation."); },
  });
  const sidebar: WorkbenchThreadSidebarSnapshot = {
    projectId, revision: 1, displayOrder: {}, freshness: "fresh", error: null,
    entries: [{ entryKind: "thread", identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse("a-thread") },
      title: "A", activityAt: 1, metadata: { pinned: false, snoozed: false, archived: false as const },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } }],
  };
  client.acceptFacts(a, rowsFor(a, sidebar), projectsFor(a));
  const first = client.getSnapshot();
  client.acceptFacts(a, rowsFor(a, structuredClone(sidebar)), projectsFor(a));
  assert.equal(client.getSnapshot(), first);
  assert.equal(snapshots.length, 1);
  client.acceptFacts(b, [], []);
  assert.equal(client.getSnapshot(), null);
  assert.equal(client.getProjectSnapshot(projectId), null);
  client.acceptFacts(b, rowsFor(b, { ...sidebar, entries: [] }), projectsFor(b));
  assert.deepEqual(client.getSnapshot()?.entries, []);
  await client.dispose();
});

test("owner rows stay source-qualified when no folder is selected for browsing", async () => {
  const projectId = ProjectIdSchema.parse("project");
  const a = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
  const b = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    remove: async () => { throw new Error("Unexpected mutation."); },
    move: async () => { throw new Error("Unexpected mutation."); },
  });
  const sidebar = {
    projectId, revision: 1, displayOrder: {}, freshness: "fresh" as const, error: null,
    entries: [{ entryKind: "thread" as const,
      identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("a-thread") },
      title: "A", activityAt: 1, metadata: { pinned: false, snoozed: false, archived: false as const },
      lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const } }],
  };
  const rows = [
    { logicalProjectId: null, location: a, hostname: "local", rootPath: "/a", entry: sidebar.entries[0]! },
    { logicalProjectId: null, location: b, hostname: "remote", rootPath: "/b",
      entry: { ...sidebar.entries[0]!, title: "B", identity: {
        harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("b-thread"),
      } } },
  ];
  client.acceptFacts(null, rows, projectsFor(a, b));
  assert.equal(client.getSnapshot(), null);
  assert.deepEqual(client.getLocationSnapshot(a)?.entries.map(entry => entry.title), ["A"]);
  assert.deepEqual(client.getLocationSnapshot(b)?.entries.map(entry => entry.title), ["B"]);
  const firstA = client.getLocationSnapshot(a);
  client.acceptFacts(null, [rows[0]!, { ...rows[1]!, entry: { ...rows[1]!.entry, title: "B updated" } }], projectsFor(a, b));
  assert.equal(client.getLocationSnapshot(a), firstA);
  assert.deepEqual(client.getLocationSnapshot(b)?.entries.map(entry => entry.title), ["B updated"]);
  await client.dispose();
});

test("an equal listing push keeps every identity and stays silent; a changed row alone is replaced", async () => {
  const location = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId: ProjectIdSchema.parse("project") };
  const logicalProjectId = LogicalProjectIdSchema.parse(crypto.randomUUID());
  const entry = (threadId: string, title: string) => ({
    entryKind: "thread" as const, identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(threadId) },
    title, activityAt: 1, metadata: { pinned: false, snoozed: false, archived: false as const },
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
  });
  const listing = (bTitle: string): WorkbenchThreadListing => ({
    rows: [entry("a", "A"), entry("b", bTitle)].map(item => ({ logicalProjectId, location, hostname: "local", rootPath: "/p", entry: item })),
    members: {}, archivedCount: 2, status: { listed: true, loading: false, error: "" },
  });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    remove: async () => { throw new Error("Unexpected mutation."); },
    move: async () => { throw new Error("Unexpected mutation."); },
  });
  let notified = 0;
  client.subscribeListing(() => { notified += 1; });
  client.acceptListing(listing("B"));
  const first = client.getListing();
  client.acceptListing(structuredClone(listing("B")));
  assert.equal(client.getListing(), first);
  assert.equal(notified, 1);
  client.acceptListing(listing("B renamed"));
  const second = client.getListing();
  assert.equal(notified, 2);
  assert.equal(second.rows[0], first.rows[0]);
  assert.notEqual(second.rows[1], first.rows[1]);
  assert.equal(second.status, first.status);
  await client.dispose();
});

test("thread activity leaves the listing structure untouched; a placement change replaces it", async () => {
  const location = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId: ProjectIdSchema.parse("project") };
  const member = (activityAt: number, title: string) => ({
    key: "k", homeKey: "home:k", logicalProjectId: null, location, hostname: "local", rootPath: "/p", title, activityAt,
    ref: { kind: "thread" as const, identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("t") } },
  });
  const placement = (main: string[]) => ({ main, archived: [], pinned: [], snoozed: [], settled: [] });
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    remove: async () => { throw new Error("Unexpected mutation."); },
    move: async () => { throw new Error("Unexpected mutation."); },
  });
  const listing = (activityAt: number, title: string, main: string[]): WorkbenchThreadListing => ({
    members: { "home:k": member(activityAt, title) }, rows: [], archivedCount: 0, placement: placement(main),
    status: { listed: true, loading: false, error: "" },
  });
  client.acceptListing(listing(1, "first", ["home:k"]));
  const structure = client.getListingStructure();
  client.acceptListing(listing(2, "renamed while working", ["home:k"]));
  assert.notEqual(client.getListing().members["home:k"], undefined);
  assert.equal(client.getListingStructure(), structure);
  client.acceptListing(listing(2, "renamed while working", []));
  assert.notEqual(client.getListingStructure(), structure);
  await client.dispose();
});
