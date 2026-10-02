/* No production exports. Protect ordered rows, one trailing blank, stable identities and grouped undo. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InputListRows } from "./input-list-rows.ts";

const values = (rows: readonly { value: string }[]) => rows.map(row => row.value);

test("filling, blanking and settling preserve order and one trailing input", () => {
  let rows = InputListRows.create([]);
  rows = InputListRows.edit(rows, rows[0]!.id, { value: "/first" });
  assert.deepEqual(values(rows), ["/first", ""]);
  const firstId = rows[0]!.id;
  rows = InputListRows.edit(rows, rows.at(-1)!.id, { value: "/second" });
  rows = InputListRows.edit(rows, firstId, { value: "" });
  rows = InputListRows.settle(rows);
  assert.deepEqual(values(rows), ["/second", ""]);
  assert.notEqual(rows[0]!.id, firstId);
});

test("removing rows keeps the next row identity and replaces a removed final blank", () => {
  const rows = InputListRows.create([{ id: "a", value: "/first" }, { id: "b", value: "/second" }]);
  const afterFirst = InputListRows.remove(rows, "a");
  assert.deepEqual(values(afterFirst), ["/second", ""]);
  assert.equal(afterFirst[0]!.id, "b");
  const afterLast = InputListRows.remove(afterFirst, "b");
  assert.deepEqual(values(afterLast), [""]);
  const afterBlank = InputListRows.remove(afterLast, afterLast[0]!.id);
  assert.deepEqual(values(afterBlank), [""]);
  assert.notEqual(afterBlank[0]!.id, afterLast[0]!.id);
});

test("pairs count as filled when either side has text, keeping multiline values exact", () => {
  let rows = InputListRows.create([{ id: "a", key: "KEY", value: "line one\nline two\n" }]);
  rows = InputListRows.edit(rows, rows[1]!.id, { value: "orphan value" });
  assert.equal(rows.length, 3);
  assert.deepEqual(InputListRows.populated(rows).map(row => [row.key, row.value]), [["KEY", "line one\nline two\n"], ["", "orphan value"]]);
});

test("typing in one field is one undo step, structural changes are their own steps, and redo restores", () => {
  const { history } = InputListRows;
  const start = InputListRows.create([{ id: "a", value: "x" }]);
  let state = { rows: start, history: history.empty() };
  const change = (next: typeof start, group: string | null) => {
    state = { rows: next, history: history.record(state.history, state.rows, group) };
  };
  change(InputListRows.edit(state.rows, "a", { value: "xy" }), "a:value");
  change(InputListRows.edit(state.rows, "a", { value: "xyz" }), "a:value");
  change(InputListRows.remove(state.rows, "a"), null);
  const undoRemove = history.undo(state.history, state.rows)!;
  assert.deepEqual(values(undoRemove.rows), ["xyz", ""]);
  const undoTyping = history.undo(undoRemove.history, undoRemove.rows)!;
  assert.deepEqual(values(undoTyping.rows), ["x", ""]);
  assert.equal(history.undo(undoTyping.history, undoTyping.rows), null);
  const redo = history.redo(undoTyping.history, undoTyping.rows)!;
  assert.deepEqual(values(redo.rows), ["xyz", ""]);
});
