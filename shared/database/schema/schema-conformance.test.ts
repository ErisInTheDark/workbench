/*
 * No production exports. Tests protect row and row-array compatibility repair plus incompatible-row rejection. Keywords: database, schema, conformance, array, enum identity.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { conformSelectedRow, conformSelectedRows } from "./schema-conformance.ts";
import { blob, booleanInteger, defineTable, enumText, integer, jsonText, primaryKey, publishCurrentTable, text } from "./schema-definition.ts";

test("binary conformance preserves typed bytes and rejects JSON-shaped substitutes", () => {
  const binary = defineTable("conformance_binary", { bytes: blob().notNull(), optional_bytes: blob() });
  const bytes = new Uint8Array([0, 255, 128]);
  const result = conformSelectedRow(binary, { bytes });
  assert.ok(result.success);
  assert.equal(result.data.bytes, bytes);
  assert.equal(result.data.optional_bytes, null);
  for (const invalid of ["AP+A", [0, 255, 128], { type: "Buffer", data: [0, 255, 128] }, null]) {
    assert.equal(conformSelectedRow(binary, { bytes: invalid }).success, false);
  }
});

const table = publishCurrentTable(defineTable("conformance_examples", {
  id: text().primaryKey(),
  state: enumText("ready", "done").notNull(),
  enabled: booleanInteger().notNull().default(1),
  count: integer().notNull().nonNegative(),
  note: text(),
  payload_json: jsonText().notNull(),
}));

const preferenceTable = publishCurrentTable(defineTable("conformance_preferences", {
  owner: text().notNull(),
  key: enumText("open", "count").notNull(),
  value: integer().notNull().nonNegative(),
}, (columns) => ({
  constraints: [primaryKey([columns.owner, columns.key])],
})));

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

test("selected-row array conformance drops future enum identities but rejects malformed known rows", () => {
  const compatible = conformSelectedRows(preferenceTable, [
    { owner: "shell", key: "open", value: 1 },
    { owner: "shell", key: "future", value: 2 },
  ], ["rows"]);
  assert.equal(compatible.success, true);
  if (compatible.success) {
    assert.deepEqual(compatible.data, [{ owner: "shell", key: "open", value: 1 }]);
    assert.deepEqual(compatible.repairedPaths, [["rows", 1]]);
  }

  const malformed = conformSelectedRows(preferenceTable, [
    { owner: "shell", key: "open", value: -1 },
  ], ["rows"]);
  assert.equal(malformed.success, false);
  if (!malformed.success) {
    assert.deepEqual(malformed.issues, [{ code: "invalidValue", path: ["rows", 0, "value"] }]);
  }
});
