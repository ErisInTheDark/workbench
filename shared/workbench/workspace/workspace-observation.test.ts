/*
 * No exports. Protect workspace observation shapes from resending whole thread rows when one entry field changes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyObservationDelta, diffObservationValue } from "./observation-patch";
import {
  DaemonWorkspaceQuerySchema, WorkspaceObservationSchema, WorkspaceQuerySchema,
  workspaceObservationShape, workspaceThreadRowKey, type WorkspaceObservation,
} from "./workspace-observation";

const value = (activityAt: number) => WorkspaceObservationSchema.parse({
  kind: "projectThreads", subscriptionId: "00000000-0000-4000-8000-000000000001", generation: 1, revision: 1,
  phase: "current", failure: null,
  data: {
    rows: [{
      logicalProjectId: null, location: { daemonId: "00000000-0000-4000-8000-0000000000da", projectId: "project" }, hostname: "host", rootPath: "C:/project",
      entry: {
        entryKind: "thread", title: "thread", activityAt, waitingOnThreads: [],
        identity: { harness: "codex", threadId: "00000001-0000-4000-8000-000000000000" },
        metadata: { archived: false, pinned: false, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      },
    }],
    projects: [],
  },
}) as Extract<WorkspaceObservation, { kind: "projectThreads" }>;

test("an entry field change on an app thread row patches only that field and still validates the entry", () => {
  const shape = workspaceObservationShape("projectThreads");
  const delta = diffObservationValue(value(10_000), value(20_000), shape)!;
  const update = delta.objects?.data?.collections?.rows?.update?.[0]?.delta;
  assert.deepEqual(update, { objects: { entry: { set: { activityAt: 20_000 } } } });
  assert.deepEqual(applyObservationDelta(value(10_000), delta, shape), value(20_000));
  const key = workspaceThreadRowKey(value(10_000).data.rows[0]!);
  assert.throws(() => applyObservationDelta(value(10_000), {
    objects: { data: { collections: { rows: { update: [{ key, delta: { objects: { entry: { set: { activityAt: "soon" } } } } }] } } } },
  }, shape), /invalid/u);
});

test("sidebar row protocol v2 is explicit while legacy rows conform compacting to false", () => {
  assert.deepEqual(WorkspaceQuerySchema.parse({
    kind: "projectThreads", projects: null, sidebarRowVersion: 2,
  }), { kind: "projectThreads", projects: null, sidebarRowVersion: 2 });
  assert.deepEqual(DaemonWorkspaceQuerySchema.parse({
    kind: "projectThreads", projectIds: ["project"], sidebarRowVersion: 2,
  }), { kind: "projectThreads", projectIds: ["project"], sidebarRowVersion: 2 });
  const entry = value(10_000).data.rows[0]?.entry;
  assert.equal(entry?.entryKind === "thread" ? entry.compacting ?? false : null, false);
});

test("project tree updates ship changed counts and touched nodes, not the whole tree", () => {
  const tree = (extra: boolean) => WorkspaceObservationSchema.parse({
    kind: "projectTree", subscriptionId: "00000000-0000-4000-8000-000000000001", generation: 1, revision: 1, sourceGeneration: 1,
    phase: "current", failure: null,
    data: { projectId: "project", revision: extra ? 2 : 1, updateKind: "project", snapshot: {
      projectId: "project", root: "C:/project", rootPath: "C:/project", roots: [], workbenchStorageRootPath: "C:/project/.workbench",
      changes: extra ? { "src/a.ts": { additions: 2, deletions: 0 } } : { "src/a.ts": { additions: 1, deletions: 0 }, "old.ts": { additions: 0, deletions: 3 } },
      tree: [
        { type: "file", name: "old.ts", path: "old.ts" },
        { type: "directory", name: "src", path: "src", children: [
          { type: "file", name: "a.ts", path: "src/a.ts" },
          ...extra ? [{ type: "file", name: "b.ts", path: "src/b.ts" }] : [],
        ] },
      ],
    } },
  }) as Extract<WorkspaceObservation, { kind: "projectTree" }>;
  const shape = workspaceObservationShape("projectTree");
  const delta = diffObservationValue(tree(false), tree(true), shape)!;
  assert.deepEqual(delta.objects?.data?.objects?.snapshot, {
    objects: {
      changes: { set: { "src/a.ts": { additions: 2, deletions: 0 } }, unset: ["old.ts"] },
    },
    collections: {
      tree: { update: [{ key: "src", delta: { collections: { children: { add: [{ key: "src/b.ts", item: { type: "file", name: "b.ts", path: "src/b.ts" } }] } } } }] },
    },
  });
  const before = tree(false);
  const applied = applyObservationDelta(before, delta, shape);
  assert.deepEqual(applied, tree(true));
  assert.equal(applied.data?.snapshot.tree[0], before.data?.snapshot.tree[0], "untouched nodes keep their identity");
});
