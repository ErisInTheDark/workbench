/*
 * Keywords: observations, bootstrap race, release, disconnect, revision.
 * Exports: none. Tests protect connection-owned delivery without stale resurrection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchThreadObservationSnapshot } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadObservationController from "./WorkbenchThreadObservationController";

const request = {
  projectId: "project",
  subscriptionId: "253ad0f8-04d1-4c4b-b03f-7b6f357dddf9",
  target: { kind: "provider" as const, harness: "codex" as const, threadId: "thread" },
};

function snapshot(revision: number): WorkbenchThreadObservationSnapshot {
  return { ...request, entries: [], error: null, freshness: "fresh", revision, updateKind: "threadObservation", version: 1 };
}

test("an update during bootstrap wins over its older read and remains live", async () => {
  const delivered: WorkbenchThreadObservationSnapshot[] = [];
  const owner = new WorkbenchThreadObservationController((_connection, value) => delivered.push(value));
  let finish!: (value: WorkbenchThreadObservationSnapshot) => void;
  const opening = owner.observe("viewer", request, () => new Promise(resolve => { finish = resolve; }));
  owner.update("project", () => snapshot(2));
  finish(snapshot(1));
  assert.equal((await opening).revision, 2);
  owner.update("project", () => snapshot(3));
  assert.deepEqual(delivered.map(value => value.revision), [2, 3]);
  assert.equal(owner.hasProject("project"), true);
  owner.dispose();
  assert.equal(owner.hasProject("project"), false);
});

for (const end of ["release", "disconnect", "dispose"] as const) {
  test(`${end} during bootstrap cannot register or publish the late read`, async () => {
    const delivered: WorkbenchThreadObservationSnapshot[] = [];
    const owner = new WorkbenchThreadObservationController((_connection, value) => delivered.push(value));
    let finish!: (value: WorkbenchThreadObservationSnapshot) => void;
    const opening = owner.observe("viewer", request, () => new Promise(resolve => { finish = resolve; }));
    const rejected = assert.rejects(opening, /released|disposed/);
    if (end === "release") owner.release("viewer", request.subscriptionId);
    else if (end === "disconnect") owner.disconnect("viewer");
    else owner.dispose();
    finish(snapshot(1));
    await rejected;
    owner.update("project", () => snapshot(2));
    assert.equal(delivered.length, 0);
    assert.equal(owner.hasProject("project"), false);
  });
}

test("subscription ids are connection scoped and a failed bootstrap releases only its own record", async () => {
  const connections: string[] = [];
  const owner = new WorkbenchThreadObservationController(connection => connections.push(connection));
  await owner.observe("first", request, async () => snapshot(1));
  await assert.rejects(owner.observe("second", request, async () => { throw new Error("read failed"); }), /read failed/);
  await owner.observe("second", request, async () => snapshot(1));
  owner.release("first", request.subscriptionId);
  owner.update("project", () => snapshot(2));
  assert.deepEqual(connections, ["second"]);
  owner.dispose();
});
