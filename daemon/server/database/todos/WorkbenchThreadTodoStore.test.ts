/* No production exports. Tests protect thread-scoped todo edits, whole-list moves and required-count summaries. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
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
    todos: new WorkbenchThreadTodoStore(database),
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
  assert.deepEqual(removed.removed, [first], "another thread's todo is never removed, and the removed one comes back whole");
  todos.execute({ kind: "setRequired", threadId, id: foreign.id, required: true });
  todos.execute({ kind: "setText", threadId, id: foreign.id, text: "hijacked" });
  assert.deepEqual(todos.execute({ kind: "list", threadId: otherThreadId }).todos.map(todo => [todo.text, todo.required]), [["theirs", false]]);
  assert.equal(todos.execute({ kind: "setText", threadId, id: second.id, text: " polish more " }).todos[0]?.text, "polish more");

  assert.deepEqual(todos.execute({ kind: "setRequired", threadId, id: second.id, required: true }).todos, [{ ...second, text: "polish more", required: true }]);
  assert.deepEqual(todos.requiredCounts(), { [threadId]: 1 }, "only required todos count, per thread");
});

test("moving todos appends them after the destination's own and empties the source", async context => {
  const { todos, threadId, otherThreadId } = await fixture(context);
  todos.execute({ kind: "add", threadId: otherThreadId, text: "parent's", required: false, at: 1 });
  todos.execute({ kind: "add", threadId, text: "fix bug", required: true, at: 2 });
  todos.execute({ kind: "add", threadId, text: "polish", required: false, at: 3 });

  const result = todos.execute({ kind: "move", threadId, toThreadId: otherThreadId });
  assert.deepEqual(result.todos, []);
  assert.deepEqual(result.moved, {
    ids: [2, 3],
    todos: [
      { id: 1, text: "parent's", required: false, createdAt: 1 },
      { id: 2, text: "fix bug", required: true, createdAt: 2 },
      { id: 3, text: "polish", required: false, createdAt: 3 },
    ],
  });
  assert.deepEqual(todos.requiredCounts(), { [otherThreadId]: 1 }, "the obligation follows the todo");
  assert.throws(() => todos.execute({ kind: "move", threadId: otherThreadId, toThreadId: otherThreadId }));
});
