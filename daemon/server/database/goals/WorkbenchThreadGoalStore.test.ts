/* No production exports. Tests protect thread-goal set/clear notices, compaction re-delivery, and acknowledgement that never eats newer transitions. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadGoalStore from "./WorkbenchThreadGoalStore";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("goal-store-");
  const database = new Database(path.join(temporary.path, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await temporary.dispose(); });
  const identities = new WorkbenchThreadIdentityRepository(database);
  const [threadId, otherThreadId] = ["one", "two"].map(native => identities.observe({
    native: { harness: "claude", nativeLocation: temporary.path, nativeThreadId: NativeThreadIdSchema.parse(native) },
    projectId: testProjectIds.fixture, projectRoot: temporary.path,
    title: native, createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId);
  return { store: new WorkbenchThreadGoalStore(database), threadId: threadId!, otherThreadId: otherThreadId! };
}

test("set records an update notice; acknowledging an older delivery keeps the newer update pending", async context => {
  const { store, threadId, otherThreadId } = await fixture(context);
  const first = store.execute({ kind: "set", threadId, objective: " ship it ", at: 10 });
  assert.deepEqual(first.goal, { objective: "ship it", updatedAt: 10 });
  assert.equal(first.pending?.notice, "updated");
  const second = store.execute({ kind: "set", threadId, objective: "ship it twice", at: 10 });
  assert.equal(second.goal?.updatedAt, 11, "same-millisecond edits still get a newer stamp");
  const stale = store.execute({ kind: "acknowledge", threadId, notice: "updated", updatedAt: 10 });
  assert.deepEqual(stale.pending, { notice: "updated", objective: "ship it twice", updatedAt: 11 });
  assert.equal(store.execute({ kind: "acknowledge", threadId, notice: "updated", updatedAt: 11 }).pending, null);
  assert.equal(store.execute({ kind: "set", threadId, objective: "ship it twice", at: 20 }).pending, null, "an unchanged objective sends nothing");
  assert.deepEqual(store.execute({ kind: "read", threadId: otherThreadId }), { goal: null, pending: null });
});

test("compaction re-delivers a delivered goal, and an undelivered update already covers it", async context => {
  const { store, threadId } = await fixture(context);
  assert.equal(store.execute({ kind: "markCompacted", threadId }).pending, null, "no goal, nothing to re-send");
  const set = store.execute({ kind: "set", threadId, objective: "goal", at: 1 });
  assert.equal(store.execute({ kind: "markCompacted", threadId }).pending?.notice, "updated");
  store.execute({ kind: "acknowledge", threadId, notice: "updated", updatedAt: set.goal!.updatedAt });
  assert.deepEqual(store.execute({ kind: "markCompacted", threadId }).pending, { notice: "redeliver", objective: "goal", updatedAt: 1 });
});

test("clear hides the goal at once, keeps its notice until delivery, then removes the row", async context => {
  const { store, threadId } = await fixture(context);
  assert.deepEqual(store.execute({ kind: "clear", threadId, at: 1 }), { goal: null, pending: null }, "clearing nothing is a no-op");
  store.execute({ kind: "set", threadId, objective: "goal", at: 1 });
  const cleared = store.execute({ kind: "clear", threadId, at: 1 });
  assert.equal(cleared.goal, null);
  assert.deepEqual(cleared.pending, { notice: "cleared", objective: null, updatedAt: 2 });
  assert.equal(store.execute({ kind: "markCompacted", threadId }).pending?.notice, "cleared", "a cleared goal is never re-sent");
  const resetBeforeDelivery = store.execute({ kind: "set", threadId, objective: "again", at: 1 });
  assert.equal(store.execute({ kind: "acknowledge", threadId, notice: "cleared", updatedAt: 2 }).goal?.objective, "again",
    "a late clear acknowledgement cannot delete a newer goal");
  store.execute({ kind: "clear", threadId, at: 1 });
  assert.deepEqual(store.execute({ kind: "acknowledge", threadId, notice: "cleared", updatedAt: resetBeforeDelivery.goal!.updatedAt + 1 }),
    { goal: null, pending: null });
});
