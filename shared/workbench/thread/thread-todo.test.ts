/* No production exports. Tests protect todo titles and reading printed todos back. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatWorkbenchThreadTodos, parseWorkbenchThreadTodos, workbenchThreadTodoTitle } from "./thread-todo";

test("todos printed for an agent read back whole, after any heading, multi-line text included", () => {
  const todos = [
    { id: 1, required: false, text: "Fix stale pill — cache\n\nkeeps old text" },
    { id: 12, required: true, text: "Rerun tests — after the fix" },
  ];
  assert.deepEqual(parseWorkbenchThreadTodos(`Removed todos 1, 12:\n\n${formatWorkbenchThreadTodos(todos)}\n`), todos);
  assert.deepEqual(parseWorkbenchThreadTodos("Removed todo 1.\n"), [], "outputs without todo text read as none");
});

test("todo title is the text before the first separator", () => {
  assert.equal(workbenchThreadTodoTitle("Fix stale pill — the cache keeps old text — even after save"), "Fix stale pill");
});

test("todos without the title form have no title", () => {
  assert.equal(workbenchThreadTodoTitle("fix x - y because z"), null);
  assert.equal(workbenchThreadTodoTitle("first line\nsecond — line"), null);
});

test("todos with an empty title or context have no title", () => {
  assert.equal(workbenchThreadTodoTitle(" — context only"), null);
  assert.equal(workbenchThreadTodoTitle("Title only — "), null);
});
