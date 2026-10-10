/* No production exports. Tests protect thread-scoped todo edits and the addressed-feedback references a thread keeps. */
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
import WorkbenchThreadAddressedFeedbackStore from "../feedback/WorkbenchThreadAddressedFeedbackStore";
import WorkbenchThreadTodoStore from "./WorkbenchThreadTodoStore";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("todo-store-");
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
  return {
    todos: new WorkbenchThreadTodoStore(database), addressed: new WorkbenchThreadAddressedFeedbackStore(database),
    threadId: threadId!, otherThreadId: otherThreadId!,
  };
}

test("todos stay in creation order and every edit is scoped to its own thread", async context => {
  const { todos, threadId, otherThreadId } = await fixture(context);
  const first = todos.execute({ kind: "add", threadId, text: " rerun tests ", required: true, at: 5 }).added!;
  const second = todos.execute({ kind: "add", threadId, text: "polish", required: false, at: 6 }).added!;
  const foreign = todos.execute({ kind: "add", threadId: otherThreadId, text: "theirs", required: false, at: 7 }).added!;
  assert.deepEqual(first, { id: 1, text: "rerun tests", required: true, createdAt: 5 });
  assert.equal(second.id, 2);
  assert.equal(foreign.id, 1, "each thread numbers its own todos");

  const removed = todos.execute({ kind: "remove", threadId, ids: [foreign.id, first.id, 999] });
  assert.deepEqual(removed.removed, [first.id], "another thread's todo is never removed");
  todos.execute({ kind: "setRequired", threadId, id: foreign.id, required: true });
  todos.execute({ kind: "setText", threadId, id: foreign.id, text: "hijacked" });
  assert.deepEqual(todos.execute({ kind: "list", threadId: otherThreadId }).todos.map(todo => [todo.text, todo.required]), [["theirs", false]]);
  assert.equal(todos.execute({ kind: "setText", threadId, id: second.id, text: " polish more " }).todos[0]?.text, "polish more");

  assert.deepEqual(todos.execute({ kind: "setRequired", threadId, id: second.id, required: true }).todos, [{ ...second, text: "polish more", required: true }]);
  assert.deepEqual(todos.counts(), { [threadId]: 1, [otherThreadId]: 1 }, "counts follow every thread's current todos");
});

test("addressed feedback keeps first-recorded order, ignores repeats, and clears per thread", async context => {
  const { addressed, threadId, otherThreadId } = await fixture(context);
  const report = (id: number, daemonId = "daemon-a"): WorkbenchThreadAddressedFeedback => ({
    kind: "feedback", id, daemonId, category: "bug", title: `report ${id}`, author: "model", thread: "thread", createdAt: id, report: "text",
  });
  addressed.execute({ kind: "record", threadId, feedback: [report(2), report(1)] });
  addressed.execute({ kind: "record", threadId, feedback: [report(1), report(1, "daemon-b")] });
  addressed.execute({ kind: "record", threadId: otherThreadId, feedback: [report(3)] });
  assert.deepEqual(addressed.execute({ kind: "read", threadId }).map(item => `${item.daemonId}:${item.id}`),
    ["daemon-a:2", "daemon-a:1", "daemon-b:1"]);
  assert.deepEqual(addressed.execute({ kind: "clear", threadId }), []);
  assert.equal(addressed.execute({ kind: "read", threadId: otherThreadId }).length, 1);
});
