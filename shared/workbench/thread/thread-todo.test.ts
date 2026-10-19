import assert from "node:assert/strict";
import { test } from "node:test";

import { workbenchThreadTodoTitle } from "./thread-todo";

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
