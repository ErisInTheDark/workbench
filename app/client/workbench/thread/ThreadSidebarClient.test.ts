/* No exports. Protect source-qualified sidebar replacement and stable external-store snapshots. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import ThreadSidebarClient from "./ThreadSidebarClient";

function rowsFor(location: { daemonId: ReturnType<typeof DaemonIdSchema.parse>; projectId: ReturnType<typeof ProjectIdSchema.parse> },
  sidebar: WorkbenchThreadSidebarSnapshot): WorkspaceThreadRows {
  return {
    rows: sidebar.entries.map(entry => ({
      logicalProjectId: null, location, hostname: "local", rootPath: "/project", entry,
    })),
    projects: [{ location, phase: "current", failure: null }],
  };
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
  client.acceptFacts(a, rowsFor(a, sidebar));
  const first = client.getSnapshot();
  client.acceptFacts(a, rowsFor(a, structuredClone(sidebar)));
  assert.equal(client.getSnapshot(), first);
  assert.equal(snapshots.length, 1);
  client.acceptFacts(b, null);
  assert.equal(client.getSnapshot(), null);
  assert.equal(client.getProjectSnapshot(projectId), null);
  client.acceptFacts(b, rowsFor(b, { ...sidebar, entries: [] }));
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
  const rows = {
    rows: [
      { logicalProjectId: null, location: a, hostname: "local", rootPath: "/a", entry: sidebar.entries[0]! },
      { logicalProjectId: null, location: b, hostname: "remote", rootPath: "/b",
        entry: { ...sidebar.entries[0]!, title: "B", identity: {
          harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("b-thread"),
        } } },
    ],
    projects: [
      { location: a, phase: "current" as const, failure: null },
      { location: b, phase: "current" as const, failure: null },
    ],
  };
  client.acceptFacts(null, rows);
  assert.equal(client.getSnapshot(), null);
  assert.deepEqual(client.getLocationSnapshot(a)?.entries.map(entry => entry.title), ["A"]);
  assert.deepEqual(client.getLocationSnapshot(b)?.entries.map(entry => entry.title), ["B"]);
  const firstA = client.getLocationSnapshot(a);
  client.acceptFacts(null, { ...rows, rows: [
    rows.rows[0]!,
    { ...rows.rows[1]!, entry: { ...rows.rows[1]!.entry, title: "B updated" } },
  ] });
  assert.equal(client.getLocationSnapshot(a), firstA);
  assert.deepEqual(client.getLocationSnapshot(b)?.entries.map(entry => entry.title), ["B updated"]);
  await client.dispose();
});
