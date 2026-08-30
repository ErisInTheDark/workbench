/*
 * No production exports. Tests protect compatibility repair and incompatible-row rejection from the declared database owner. Keywords: database, schema, conformance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { conformSelectedRow } from "./schema-conformance.ts";
import { booleanInteger, defineTable, enumText, integer, jsonText, publishCurrentTable, text } from "./schema-definition.ts";

const table = publishCurrentTable(defineTable("conformance_examples", {
  id: text().primaryKey(),
  state: enumText("ready", "done").notNull(),
  enabled: booleanInteger().notNull().default(1),
  count: integer().notNull().nonNegative(),
  note: text(),
  payload_json: jsonText().notNull(),
}));

test("selected-row conformance repairs compatible schema skew without replacing valid siblings", () => {
  const result = conformSelectedRow(table, {
    id: "item",
    state: "ready",
    count: 4,
    payload_json: "{}",
    future_column: "ignored",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data, {
    id: "item",
    state: "ready",
    enabled: 1,
    count: 4,
    note: null,
    payload_json: "{}",
  });
  assert.deepEqual(result.repairedPaths, [["future_column"], ["enabled"], ["note"]]);
});

test("selected-row conformance rejects incompatible required and constrained values", () => {
  const result = conformSelectedRow(table, {
    id: "item",
    state: "future",
    enabled: 2,
    count: -1,
    note: null,
    payload_json: "{",
  });

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.issues, [
    { code: "invalidValue", path: ["state"] },
    { code: "invalidValue", path: ["enabled"] },
    { code: "invalidValue", path: ["count"] },
    { code: "invalidValue", path: ["payload_json"] },
  ]);

  const missing = conformSelectedRow(table, {
    state: "ready",
    count: 0,
    payload_json: "{}",
  });
  assert.equal(missing.success, false);
  if (!missing.success) assert.deepEqual(missing.issues, [{ code: "missingRequired", path: ["id"] }]);
});
