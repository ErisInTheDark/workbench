/* No production exports. Tests protect addressed-feedback ordering, scope, single-report detaching, and per-thread counts. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadAddressedFeedbackStore from "./WorkbenchThreadAddressedFeedbackStore";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("addressed-feedback-store-");
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
  return { store: new WorkbenchThreadAddressedFeedbackStore(database), threadId: threadId!, otherThreadId: otherThreadId! };
}

const report = (id: number, daemonId = "daemon-a"): WorkbenchThreadAddressedFeedback => ({
  kind: "feedback", id, daemonId, category: "bug", title: `report ${id}`, author: "model",
  thread: "thread", createdAt: id, report: "text",
});

test("addressed feedback keeps first-recorded order, ignores repeats, counts per thread, and detaches one report by daemon and id", async context => {
  const { store, threadId, otherThreadId } = await fixture(context);
  store.execute({ kind: "record", threadId, feedback: [report(2), report(1)] });
  store.execute({ kind: "record", threadId, feedback: [report(1), report(1, "daemon-b")] });
  store.execute({ kind: "record", threadId: otherThreadId, feedback: [report(1)] });

  assert.deepEqual(store.execute({ kind: "read", threadId }).map(item => `${item.daemonId}:${item.id}`),
    ["daemon-a:2", "daemon-a:1", "daemon-b:1"]);
  assert.deepEqual(store.counts(), { [threadId]: 3, [otherThreadId]: 1 });
  assert.deepEqual(store.execute({ kind: "detach", threadId, daemonId: "daemon-a", feedbackId: 1 }).map(item => `${item.daemonId}:${item.id}`),
    ["daemon-a:2", "daemon-b:1"]);
  assert.deepEqual(store.counts(), { [threadId]: 2, [otherThreadId]: 1 });
});
