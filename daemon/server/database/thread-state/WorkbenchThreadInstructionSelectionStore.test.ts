/* No production exports. Tests protect durable thread instruction selections and conformance of drifted stored values. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadInstructionSelectionStore from "./WorkbenchThreadInstructionSelectionStore";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const { threadId } = new WorkbenchThreadIdentityRepository(database).observe({
    native: { harness: "claude", nativeLocation: "C:/project", nativeThreadId: NativeThreadIdSchema.parse("native") },
    projectId: testProjectIds.project, projectRoot: "C:/project", title: "thread", createdAt: 1, updatedAt: 2, activityAt: 2,
  });
  return { database, threadId, store: new WorkbenchThreadInstructionSelectionStore(database) };
}

test("a recorded selection replaces the previous one and reads back", () => {
  const { database, threadId, store } = fixture();
  try {
    assert.equal(store.execute({ kind: "read", threadId }), null);
    store.execute({ kind: "record", threadId, selection: { workflowIds: ["review"], subagentName: "mira" }, at: 1 });
    store.execute({ kind: "record", threadId, selection: { workflowIds: [] }, at: 2 });
    assert.deepEqual(store.execute({ kind: "read", threadId }), { workflowIds: [] });
  } finally { database.close(); }
});

test("a drifted stored field drops only itself", () => {
  const { database, threadId, store } = fixture();
  try {
    store.execute({ kind: "record", threadId, selection: { workflowIds: ["review"] }, at: 1 });
    database.prepare("UPDATE workbench_thread_instruction_selections SET selection_json = ? WHERE thread_id = ?")
      .run(JSON.stringify({ workflowIds: "review", workbenchOrigin: "http://wb", retired: true }), threadId);
    assert.deepEqual(store.execute({ kind: "read", threadId }), { workbenchOrigin: "http://wb" });
  } finally { database.close(); }
});
