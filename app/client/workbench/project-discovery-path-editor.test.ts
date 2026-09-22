/* No production exports. Protect ordered draft rows and stable server-issue targets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blurProjectDiscoveryRow,
  createProjectDiscoveryRows,
  editProjectDiscoveryRow,
  populatedProjectDiscoveryRows,
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
