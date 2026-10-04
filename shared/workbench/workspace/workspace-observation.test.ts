/*
 * No exports. Protect workspace observation shapes from resending whole thread rows when one entry field changes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyObservationDelta, diffObservationValue } from "./observation-patch";
import {
  WorkspaceObservationSchema, workspaceObservationShape, workspaceThreadRowKey, type WorkspaceObservation,
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
