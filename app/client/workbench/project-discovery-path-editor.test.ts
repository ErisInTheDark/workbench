/* No production exports. Protect ordered draft rows and stable server-issue targets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blurProjectDiscoveryRow,
  createProjectDiscoveryRows,
  editProjectDiscoveryRow,
  populatedProjectDiscoveryRows,
  removeProjectDiscoveryRow,
} from "./project-discovery-path-editor.ts";

test("filling, blanking and blurring preserve ordered paths and one trailing input", () => {
  let rows = createProjectDiscoveryRows([]);
  rows = editProjectDiscoveryRow(rows, rows[0]!.id, "/first");
  assert.deepEqual(populatedProjectDiscoveryRows(rows).map(row => row.value), ["/first"]);
  const firstId = rows[0]!.id;
  rows = editProjectDiscoveryRow(rows, rows.at(-1)!.id, "/second");
  rows = editProjectDiscoveryRow(rows, firstId, "");
  rows = blurProjectDiscoveryRow(rows);
  assert.deepEqual(populatedProjectDiscoveryRows(rows).map(row => row.value), ["/second"]);
  assert.equal(rows.length, 2);
  assert.equal(rows.at(-1)!.value, "");
  assert.equal(rows[0]!.id !== firstId, true);
});

test("removing a path keeps the next path and one trailing blank, including the final input", () => {
  const rows = createProjectDiscoveryRows(["/first", "/second"]);
  const afterFirst = removeProjectDiscoveryRow(rows, rows[0]!.id);
  assert.deepEqual(afterFirst.map(row => row.value), ["/second", ""]);
  assert.equal(afterFirst[0]!.id, rows[1]!.id);

  const afterLast = removeProjectDiscoveryRow(afterFirst, afterFirst[0]!.id);
  assert.deepEqual(afterLast.map(row => row.value), [""]);

  const afterBlank = removeProjectDiscoveryRow(afterLast, afterLast[0]!.id);
  assert.deepEqual(afterBlank.map(row => row.value), [""]);
  assert.notEqual(afterBlank[0]!.id, afterLast[0]!.id);
});
