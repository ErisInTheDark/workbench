/*
 * No production exports. Tests protect typed row inference, current-table branding, and STRICT schema rendering. Keywords: database, schema, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  index,
  integer,
  jsonText,
  literal,
  primaryKey,
  renderCreateIndexes,
  renderCreateTable,
  sql,
  tableColumns,
  text,
  unique,
  type CurrentTableDefinition,
  type InsertRow,
  type SelectRow,
} from "./schema-definition";
import { createTable, defineTableHistory, tableVersion } from "./schema-history";
import * as coreSchemaModule from "./core-schema";
import * as evidenceSchemaModule from "./evidence-schema";
import * as interactionSchemaModule from "./interaction-schema";
import * as itemSchemaModule from "./item-schema";
import * as operationPresentationSchemaModule from "./operation-presentation-schema";
import * as operationSourceSchemaModule from "./operation-source-schema";

const parentsV1 = defineTable("schema_test_parents", {
  id: text().primaryKey(),
  category: enumText("one", "two").notNull(),
}, (table) => ({
  constraints: [unique([table.id, table.category])],
}));

const childrenV1 = defineTable("schema_test_children", {
  id: integer().notNull(),
  parent_id: text().notNull(),
  parent_category: enumText("one", "two").notNull(),
  enabled: booleanInteger().notNull().default(0),
  count: integer().notNull().nonNegative(),
  optional_count: integer().nonNegative(),
  payload_json: jsonText(),
}, (table) => ({
  constraints: [
    primaryKey([table.parent_id, table.id]),
    foreignKey([table.parent_id, table.parent_category], {
      table: "schema_test_parents",
      columns: ["id", "category"],
      onDelete: "CASCADE",
    }),
    check(sql`${table.enabled} = ${literal(0)} OR ${table.count} > ${literal(0)}`),
  ],
  indexes: [
    index("schema_test_children_enabled_idx", [table.parent_id], {
      unique: true,
      where: sql`${table.enabled} = ${literal(1)}`,
    }),
  ],
}));

const childrenHistory = defineTableHistory({
  versions: [tableVersion({ schemaVersion: 1, table: childrenV1, migration: createTable(childrenV1) })],
  current: childrenV1,
});

type ExpectedSelectedChild = {
  id: number;
  parent_id: string;
  parent_category: "one" | "two";
  enabled: 0 | 1;
  count: number;
  optional_count: number | null;
  payload_json: string | null;
};

type ExpectedInsertedChild = {
  id: number;
  parent_id: string;
  parent_category: "one" | "two";
  count: number;
  enabled?: 0 | 1;
  optional_count?: number | null;
  payload_json?: string | null;
};

function inferredSelectedIsExpected(row: SelectRow<typeof childrenHistory.current>): ExpectedSelectedChild {
  return row;
}

function expectedSelectedIsInferred(row: ExpectedSelectedChild): SelectRow<typeof childrenHistory.current> {
  return row;
}

function inferredInsertIsExpected(row: InsertRow<typeof childrenHistory.current>): ExpectedInsertedChild {
  return row;
}

function expectedInsertIsInferred(row: ExpectedInsertedChild): InsertRow<typeof childrenHistory.current> {
  return row;
}

void inferredSelectedIsExpected;
void expectedSelectedIsInferred;
void inferredInsertIsExpected;
void expectedInsertIsInferred;

function acceptsCurrent(_table: CurrentTableDefinition) {}

acceptsCurrent(childrenHistory.current);
// @ts-expect-error A private version descriptor is not a production table.
acceptsCurrent(childrenV1);

test("generated declarations enforce their storage, value, key, index, and cascade semantics", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(renderCreateTable(parentsV1));
    database.exec(renderCreateTable(childrenV1));
    for (const statement of renderCreateIndexes(childrenV1)) database.exec(statement);

    database.prepare("INSERT INTO schema_test_parents(id,category) VALUES ('parent','one')").run();
    database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,count,payload_json)
      VALUES (1,'parent','one',0,'{}')
    `).run();
    assert.deepEqual(database.prepare("SELECT enabled,count,payload_json FROM schema_test_children WHERE id = 1").get(), {
      enabled: 0,
      count: 0,
      payload_json: "{}",
    });

    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,enabled,count)
      VALUES (2,'parent','one',2,1)
    `).run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,count)
      VALUES (2,'parent','one',-1)
    `).run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,count,payload_json)
      VALUES (2,'parent','one',1,'not-json')
    `).run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,count)
      VALUES ('text','parent','one',1)
    `).run(), /cannot store TEXT value in INTEGER column/);
    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,count)
      VALUES (2,'parent','two',1)
    `).run(), /FOREIGN KEY constraint failed/);

    database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,enabled,count)
      VALUES (2,'parent','one',1,1)
    `).run();
    assert.throws(() => database.prepare(`
      INSERT INTO schema_test_children(id,parent_id,parent_category,enabled,count)
      VALUES (3,'parent','one',1,1)
    `).run(), /UNIQUE constraint failed/);

    database.prepare("DELETE FROM schema_test_parents WHERE id = 'parent'").run();
    const remaining = database.prepare("SELECT COUNT(*) AS count FROM schema_test_children").get() as { count: number };
    assert.equal(remaining.count, 0);
  } finally {
    database.close();
  }
});

test("declarations reject empty, duplicate, and foreign-version column ownership", () => {
  assert.throws(() => defineTable("empty_table", {}), /at least one column/);
  assert.throws(() => defineTable("not-valid", { id: text() }), /Invalid SQLite identifier/);
  assert.throws(() => text().nonNegative(), /requires an INTEGER/);
  assert.throws(() => text().primaryKey({ autoincrement: true }), /requires an INTEGER/);
  assert.throws(() => foreignKey([], { table: "schema_test_parents", columns: [] }), /at least one column/);
  assert.throws(() => foreignKey([tableColumns(childrenV1).parent_id], {
    table: "schema_test_parents",
    columns: ["id", "category"],
  }), /column counts must match/);

  const parentColumns = tableColumns(parentsV1);
  assert.throws(() => defineTable("ownership_test", { id: text() }, () => ({
    constraints: [unique([parentColumns.id])],
  })), /another table version/);
  assert.throws(() => defineTable("ownership_test", { id: text() }, () => ({
    constraints: [check(sql`${parentColumns.id} IS NOT NULL`)],
  })), /another table version/);
  assert.throws(() => defineTable("ownership_test", { id: text() }, () => ({
    indexes: [index("ownership_test_idx", [parentColumns.id])],
  })), /another table version/);
  assert.throws(() => defineTable("duplicate_reference_test", { id: text() }, (table) => ({
    constraints: [primaryKey([table.id, table.id])],
  })), /repeats column/);
  assert.throws(() => defineTable("empty_index_test", { id: text() }, () => ({
    indexes: [index("empty_index_test_idx", [])],
  })), /at least one column/);
  assert.throws(() => evolveTable(parentsV1, { add: { id: text() } }), /duplicate added columns/);
});

test("a table history rejects an older current descriptor", () => {
  const childrenV2 = evolveTable(childrenV1, { add: { label: text() } });
  assert.throws(() => defineTableHistory({
    versions: [
      tableVersion({ schemaVersion: 1, table: childrenV1, migration: createTable(childrenV1) }),
      tableVersion({ schemaVersion: 2, table: childrenV2, migration: createTable(childrenV2) }),
    ],
    current: childrenV1,
  }), /not the final registered table version/);
});

test("evolution rejects constraints that still reference a dropped column", () => {
  assert.throws(() => evolveTable(childrenV1, {
    drop: ["parent_id"],
  }), /preserves a missing column/);
});

test("subsystem modules do not export versioned table descriptors", () => {
  const subsystemModules = [
    coreSchemaModule,
    itemSchemaModule,
    operationSourceSchemaModule,
    operationPresentationSchemaModule,
    interactionSchemaModule,
    evidenceSchemaModule,
  ];
  for (const subsystemModule of subsystemModules) {
    assert.deepEqual(Object.keys(subsystemModule).filter((name) => /V\d+$/.test(name)), []);
  }
});
