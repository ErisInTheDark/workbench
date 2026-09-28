/* No exports. Protect source-qualified sidebar replacement and stable external-store snapshots. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import ThreadSidebarClient from "./ThreadSidebarClient";

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
      title: "A", activityAt: 1, metadata: { pinned: false, snoozed: false, archived: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false } }],
  };
  client.acceptFacts(a, sidebar);
  const first = client.getSnapshot();
  client.acceptFacts(a, structuredClone(sidebar));
  assert.equal(client.getSnapshot(), first);
  assert.equal(snapshots.length, 1);
  client.acceptFacts(b, null);
  assert.equal(client.getSnapshot(), null);
  assert.equal(client.getProjectSnapshot(projectId), null);
  client.acceptFacts(b, { ...sidebar, entries: [] });
  assert.deepEqual(client.getSnapshot()?.entries, []);
  await client.dispose();
});
