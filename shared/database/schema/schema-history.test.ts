/* No production exports. Tests protect schema migration declarations, atomicity, rollback, versioning, and foreign keys. */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  check,
  defineTable,
  evolveTable,
  index,
  integer,
  sql,
  tableColumns,
  text,
} from "./schema-definition.ts";
import {
  addColumns,
  applyWorkbenchDatabaseSchema,
  createIndexes,
  createTable,
  deleteRows,
  defineSubsystemHistory,
  defineTableHistory,
  defineWorkbenchDatabaseSchema,
  rebuildTable,
  retireTableHistory,
  tableVersion,
} from "./schema-history.ts";

interface TableInfoRow {
  name: string;
}

interface IndexListRow {
  name: string;
}

const recordsV1 = defineTable("schema_history_records", {
  id: integer().primaryKey(),
  legacy_value: text().notNull(),
  kept_value: text().notNull(),
}, (table) => ({
  indexes: [index("schema_history_records_kept_idx", [table.kept_value])],
}));

const recordsV2 = evolveTable(recordsV1, {
  add: {
    added_value: text(),
  },
});

const recordsV3 = evolveTable(recordsV2, {
  drop: ["legacy_value"],
});

const version1History = defineTableHistory({
  versions: [tableVersion({ schemaVersion: 1, table: recordsV1, migration: createTable(recordsV1) })],
  current: recordsV1,
});

const currentHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: 1, table: recordsV1, migration: createTable(recordsV1) }),
    tableVersion({
      schemaVersion: 2,
      table: recordsV2,
      migration: addColumns({ from: recordsV1, to: recordsV2, columns: ["added_value"] }),
    }),
    tableVersion({
      schemaVersion: 3,
      table: recordsV3,
      migration: rebuildTable({ from: recordsV2, to: recordsV3 }),
    }),
  ],
  current: recordsV3,
});

const version1Schema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([version1History])],
});

const currentSchema = defineWorkbenchDatabaseSchema({
  subsystems: [defineSubsystemHistory([currentHistory])],
});

test("explicit historical installation upgrades through the same history without losing data", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, currentSchema, { targetVersion: 1 });
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    database.prepare("INSERT INTO schema_history_records(id, legacy_value, kept_value) VALUES (1, 'old', 'retained')").run();
    applyWorkbenchDatabaseSchema(database, currentSchema, { targetVersion: 2 });
    database.prepare("UPDATE schema_history_records SET added_value = 'new' WHERE id = 1").run();
    applyWorkbenchDatabaseSchema(database, currentSchema);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_records").get(), {
      id: 1, kept_value: "retained", added_value: "new",
    });
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    database.close();
  }
});

test("invalid schema targets and downgrades do not mutate installed history", () => {
  const database = new Database(":memory:");
  try {
    applyWorkbenchDatabaseSchema(database, currentSchema, { targetVersion: 2 });
    const before = database.serialize();
    for (const targetVersion of [0, -1, 1.5, 4, NaN, Infinity, 1]) {
      assert.throws(() => applyWorkbenchDatabaseSchema(database, currentSchema, { targetVersion }));
      assert.deepEqual(database.serialize(), before);
    }
  } finally {
    database.close();
  }
});

test("schema history adds and deletes columns while preserving current data", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, version1Schema);
    database.prepare("INSERT INTO schema_history_records(id,legacy_value,kept_value) VALUES (1,'legacy','kept')").run();

    applyWorkbenchDatabaseSchema(database, currentSchema);

    assert.equal(database.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(database.prepare("PRAGMA table_info(schema_history_records)").all().map((row) => (row as TableInfoRow).name), [
      "id",
      "kept_value",
      "added_value",
    ]);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_records").get(), {
      id: 1,
      kept_value: "kept",
      added_value: null,
    });
    assert.deepEqual(database.prepare("PRAGMA index_list(schema_history_records)").all().map((row) => (row as IndexListRow).name), [
      "schema_history_records_kept_idx",
    ]);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    database.close();
  }
});

test("one release atomically deletes obsolete rows, rebuilds their owner, and retires a table", () => {
  const ownerV1 = defineTable("schema_history_retirement_owner", {
    id: integer().primaryKey(),
    kind: text().notNull(),
  });
  const ownerV2 = defineTable("schema_history_retirement_owner", {
    id: integer().primaryKey(),
    kind: text().notNull(),
  }, table => ({ constraints: [check(sql`${table.kind} <> 'retired'`)] }));
  const detail = defineTable("schema_history_retirement_detail", {
    id: integer().primaryKey(),
    owner_id: integer().notNull().references("schema_history_retirement_owner", "id"),
  });
  const ownerBase = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: ownerV1, migration: createTable(ownerV1) })],
    current: ownerV1,
  });
  const detailBase = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: detail, migration: createTable(detail) })],
    current: detail,
  });
  const base = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([ownerBase, detailBase])],
  });
  const current = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({
        versions: [
          ...ownerBase.versions,
          tableVersion({
            schemaVersion: 2,
            table: ownerV2,
            migration: [
              deleteRows(detail.name, sql`owner_id IN (SELECT id FROM schema_history_retirement_owner WHERE kind = 'retired')`),
              deleteRows(ownerV1.name, sql`kind = 'retired'`),
              rebuildTable({ from: ownerV1, to: ownerV2 }),
            ],
          }),
        ],
        current: ownerV2,
      }),
      retireTableHistory(detailBase, 2),
    ])],
  });
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, base);
    database.exec(`
      INSERT INTO schema_history_retirement_owner VALUES (1, 'retired'), (2, 'kept');
      INSERT INTO schema_history_retirement_detail VALUES (1, 1);
    `);
    applyWorkbenchDatabaseSchema(database, current);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_retirement_owner").all(), [{ id: 2, kind: "kept" }]);
    assert.equal(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_history_retirement_detail'",
    ).get(), undefined);
    assert.deepEqual(current.currentTables.map(({ name }) => name), ["schema_history_retirement_owner"]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("user_version", { simple: true }), 2);
  } finally {
    database.close();
  }
});

test("a failed rebuild rolls back schema, data, version, and foreign-key state", () => {
  const recordsV4 = evolveTable(recordsV3, {
    add: {
      required_value: text().notNull(),
    },
  });
  const failingHistory = defineTableHistory({
    versions: [
      ...currentHistory.versions,
      tableVersion({
        schemaVersion: 4,
        table: recordsV4,
        migration: rebuildTable({
          from: recordsV3,
          to: recordsV4,
          map: ({ from, expression }) => ({
            required_value: expression.text`missing_schema_function(${from.id})`,
          }),
        }),
      }),
    ],
    current: recordsV4,
  });
  const failingSchema = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([failingHistory])],
  });
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, currentSchema);
    database.prepare("INSERT INTO schema_history_records(id,kept_value) VALUES (1,'kept')").run();

    assert.throws(() => applyWorkbenchDatabaseSchema(database, failingSchema), /missing_schema_function/);
    assert.equal(database.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(database.prepare("PRAGMA table_info(schema_history_records)").all().map((row) => (row as TableInfoRow).name), [
      "id",
      "kept_value",
      "added_value",
    ]);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_records").get(), {
      id: 1,
      kept_value: "kept",
      added_value: null,
    });
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    database.close();
  }
});

test("a newer database version fails closed", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("user_version = 99");
    assert.throws(() => applyWorkbenchDatabaseSchema(database, currentSchema), /newer than supported/);
  } finally {
    database.close();
  }
});

test("index-only migrations and repeated application preserve rows and version", () => {
  const indexedV1 = defineTable("schema_history_indexed", {
    id: integer().primaryKey(),
    value: text().notNull(),
  });
  const indexedV2 = evolveTable(indexedV1, {
    extras: (table) => ({ indexes: [index("schema_history_indexed_value_idx", [table.value])] }),
  });
  const base = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [tableVersion({ schemaVersion: 1, table: indexedV1, migration: createTable(indexedV1) })],
      current: indexedV1,
    })])],
  });
  const current = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [
        tableVersion({ schemaVersion: 1, table: indexedV1, migration: createTable(indexedV1) }),
        tableVersion({
          schemaVersion: 2,
          table: indexedV2,
          migration: createIndexes({ from: indexedV1, to: indexedV2, names: ["schema_history_indexed_value_idx"] }),
        }),
      ],
      current: indexedV2,
    })])],
  });
  const database = new Database(":memory:");
  try {
    applyWorkbenchDatabaseSchema(database, base);
    database.prepare("INSERT INTO schema_history_indexed(id,value) VALUES (1,'kept')").run();
    applyWorkbenchDatabaseSchema(database, current);
    applyWorkbenchDatabaseSchema(database, current);
    assert.equal(database.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_indexed").get(), { id: 1, value: "kept" });
    assert.deepEqual(database.prepare("PRAGMA index_list(schema_history_indexed)").all().map((row) => (row as IndexListRow).name), [
      "schema_history_indexed_value_idx",
    ]);
  } finally {
    database.close();
  }
});

test("an explicit rebuild mapping produces the declared current row", () => {
  const mappedV1 = defineTable("schema_history_mapped", {
    id: integer().primaryKey(),
    old_value: text().notNull(),
  });
  const mappedV2 = defineTable("schema_history_mapped", {
    id: integer().primaryKey(),
    current_value: text().notNull(),
  });
  const base = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [tableVersion({ schemaVersion: 1, table: mappedV1, migration: createTable(mappedV1) })],
      current: mappedV1,
    })])],
  });
  const current = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [
        tableVersion({ schemaVersion: 1, table: mappedV1, migration: createTable(mappedV1) }),
        tableVersion({
          schemaVersion: 2,
          table: mappedV2,
          migration: rebuildTable({
            from: mappedV1,
            to: mappedV2,
            map: ({ from, expression }) => ({ current_value: expression.text`${from.old_value}` }),
          }),
        }),
      ],
      current: mappedV2,
    })])],
  });
  const database = new Database(":memory:");
  try {
    applyWorkbenchDatabaseSchema(database, base);
    database.prepare("INSERT INTO schema_history_mapped(id,old_value) VALUES (1,'mapped')").run();
    applyWorkbenchDatabaseSchema(database, current);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_mapped").get(), { id: 1, current_value: "mapped" });
  } finally {
    database.close();
  }
});

test("one failing table rolls back every table in the same global schema version", () => {
  const firstV1 = defineTable("schema_history_atomic_first", { id: integer().primaryKey() });
  const firstV2 = evolveTable(firstV1, { add: { note: text() } });
  const secondV1 = defineTable("schema_history_atomic_second", { id: integer().primaryKey() });
  const secondV2 = evolveTable(secondV1, { add: { required_value: text().notNull() } });
  const firstBase = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: firstV1, migration: createTable(firstV1) })],
    current: firstV1,
  });
  const secondBase = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: secondV1, migration: createTable(secondV1) })],
    current: secondV1,
  });
  const base = defineWorkbenchDatabaseSchema({ subsystems: [defineSubsystemHistory([firstBase, secondBase])] });
  const current = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({
        versions: [
          ...firstBase.versions,
          tableVersion({ schemaVersion: 2, table: firstV2, migration: addColumns({ from: firstV1, to: firstV2, columns: ["note"] }) }),
        ],
        current: firstV2,
      }),
      defineTableHistory({
        versions: [
          ...secondBase.versions,
          tableVersion({
            schemaVersion: 2,
            table: secondV2,
            migration: rebuildTable({
              from: secondV1,
              to: secondV2,
              map: ({ from, expression }) => ({ required_value: expression.text`missing_schema_function(${from.id})` }),
            }),
          }),
        ],
        current: secondV2,
      }),
    ])],
  });
  const database = new Database(":memory:");
  try {
    applyWorkbenchDatabaseSchema(database, base);
    assert.throws(() => applyWorkbenchDatabaseSchema(database, current), /missing_schema_function/);
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(database.prepare("PRAGMA table_info(schema_history_atomic_first)").all().map((row) => (row as TableInfoRow).name), ["id"]);
  } finally {
    database.close();
  }
});

test("foreign-key check failure rolls back a rebuild and restores enabled enforcement", () => {
  const parentV1 = defineTable("schema_history_fk_parent", { id: integer().primaryKey() });
  const parentV2 = defineTable("schema_history_fk_parent", { id: integer().primaryKey() });
  const childV1 = defineTable("schema_history_fk_child", {
    id: integer().primaryKey(),
    parent_id: integer().notNull().references("schema_history_fk_parent", "id"),
  });
  const parentBase = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: parentV1, migration: createTable(parentV1) })],
    current: parentV1,
  });
  const childHistory = defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: childV1, migration: createTable(childV1) })],
    current: childV1,
  });
  const base = defineWorkbenchDatabaseSchema({ subsystems: [defineSubsystemHistory([parentBase, childHistory])] });
  const current = defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({
        versions: [
          ...parentBase.versions,
          tableVersion({
            schemaVersion: 2,
            table: parentV2,
            migration: rebuildTable({
              from: parentV1,
              to: parentV2,
              map: ({ from, expression }) => ({ id: expression.integer`${from.id} + 100` }),
            }),
          }),
        ],
        current: parentV2,
      }),
      childHistory,
    ])],
  });
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyWorkbenchDatabaseSchema(database, base);
    database.prepare("INSERT INTO schema_history_fk_parent(id) VALUES (1)").run();
    database.prepare("INSERT INTO schema_history_fk_child(id,parent_id) VALUES (1,1)").run();
    assert.throws(() => applyWorkbenchDatabaseSchema(database, current), /Foreign-key check failed/);
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(database.prepare("SELECT * FROM schema_history_fk_parent").get(), { id: 1 });
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  } finally {
    database.close();
  }
});

test("a rebuild preserves an originally disabled foreign-key mode", () => {
  const database = new Database(":memory:");
  try {
    applyWorkbenchDatabaseSchema(database, version1Schema);
    database.pragma("foreign_keys = OFF");
    applyWorkbenchDatabaseSchema(database, currentSchema);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 0);
  } finally {
    database.close();
  }
});

test("history declarations reject unsafe or unexplained transitions", () => {
  const guardedV1 = defineTable("schema_history_guarded", { id: integer().primaryKey(), value: text() });
  const guardedAdded = evolveTable(guardedV1, { add: { added: text() } });
  const guardedRequired = evolveTable(guardedV1, { add: { required: text().notNull() } });
  const guardedConstraint = evolveTable(guardedV1, {
    extras: (table) => ({ constraints: [check(sql`${table.id} >= 0`)] }),
  });
  const guardedIndexed = evolveTable(guardedV1, {
    extras: (table) => ({ indexes: [index("schema_history_guarded_value_idx", [table.value])] }),
  });
  const lookalikeV1 = defineTable("schema_history_guarded", { id: integer().primaryKey(), value: text() });

  assert.throws(() => tableVersion({ schemaVersion: 0, table: guardedV1, migration: createTable(guardedV1) }), /Invalid schema version/);
  assert.throws(() => defineTableHistory({ versions: [], current: guardedV1 }), /no schema versions/);
  assert.throws(() => defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table: guardedV1, migration: addColumns({ from: guardedV1, to: guardedV1, columns: [] }) })],
    current: guardedV1,
  }), /must contain one createTable/);
  assert.throws(() => defineTableHistory({
    versions: [
      tableVersion({ schemaVersion: 1, table: guardedV1, migration: createTable(guardedV1) }),
      tableVersion({ schemaVersion: 1, table: guardedAdded, migration: addColumns({ from: guardedV1, to: guardedAdded, columns: ["added"] }) }),
    ],
    current: guardedAdded,
  }), /must increase/);
  assert.throws(() => defineTableHistory({
    versions: [
      tableVersion({ schemaVersion: 1, table: guardedV1, migration: createTable(guardedV1) }),
      tableVersion({ schemaVersion: 2, table: guardedAdded, migration: addColumns({ from: lookalikeV1, to: guardedAdded, columns: ["added"] }) }),
    ],
    current: guardedAdded,
  }), /adjacent table versions/);
  for (const [table, migration, message] of [
    [guardedAdded, [], /does not explain its column changes/],
    [guardedRequired, addColumns({ from: guardedV1, to: guardedRequired, columns: ["required"] }), /requires a rebuild mapping/],
    [guardedConstraint, [], /changes constraints without rebuilding/],
    [guardedIndexed, [], /does not explain its index changes/],
  ] as const) {
    assert.throws(() => defineTableHistory({
      versions: [
        tableVersion({ schemaVersion: 1, table: guardedV1, migration: createTable(guardedV1) }),
        tableVersion({ schemaVersion: 2, table, migration }),
      ],
      current: table,
    }), message);
  }
  assert.throws(() => rebuildTable({ from: guardedV1, to: guardedRequired }), /requires a mapping/);
  assert.throws(() => defineTableHistory({
    versions: [
      tableVersion({ schemaVersion: 1, table: guardedV1, migration: createTable(guardedV1) }),
      tableVersion({
        schemaVersion: 2,
        table: guardedAdded,
        migration: [
          rebuildTable({ from: guardedV1, to: guardedAdded }),
          createIndexes({ from: guardedV1, to: guardedAdded, names: [] }),
        ],
      }),
    ],
    current: guardedAdded,
  }), /must follow only row deletions/);
  const foreignVersionColumns = tableColumns(lookalikeV1);
  assert.throws(() => rebuildTable({
    from: guardedV1,
    to: guardedRequired,
    map: ({ expression }) => ({ required: expression.text`${foreignVersionColumns.value}` }),
  }), /another table version/);
});

test("database schema assembly rejects empty, duplicate, skipped, and invalid foreign histories", () => {
  assert.throws(() => defineWorkbenchDatabaseSchema({ subsystems: [] }), /at least one table version/);
  assert.throws(() => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([version1History]), defineSubsystemHistory([version1History])],
  }), /Duplicate current table/);

  const skipped = defineTable("schema_history_skipped", { id: integer().primaryKey() });
  assert.throws(() => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [tableVersion({ schemaVersion: 2, table: skipped, migration: createTable(skipped) })],
      current: skipped,
    })])],
  }), /skips version 1/);

  const missingTableChild = defineTable("schema_history_missing_table_child", {
    id: integer().primaryKey(),
    parent_id: integer().references("schema_history_absent", "id"),
  });
  assert.throws(() => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([defineTableHistory({
      versions: [tableVersion({ schemaVersion: 1, table: missingTableChild, migration: createTable(missingTableChild) })],
      current: missingTableChild,
    })])],
  }), /misses foreign table/);

  const nonUniqueParent = defineTable("schema_history_non_unique_parent", { id: integer() });
  const nonUniqueChild = defineTable("schema_history_non_unique_child", {
    id: integer().primaryKey(),
    parent_id: integer().references("schema_history_non_unique_parent", "id"),
  });
  assert.throws(() => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({
        versions: [tableVersion({ schemaVersion: 1, table: nonUniqueParent, migration: createTable(nonUniqueParent) })],
        current: nonUniqueParent,
      }),
      defineTableHistory({
        versions: [tableVersion({ schemaVersion: 1, table: nonUniqueChild, migration: createTable(nonUniqueChild) })],
        current: nonUniqueChild,
      }),
    ])],
  }), /foreign target is not unique/);

  const missingColumnParent = defineTable("schema_history_missing_column_parent", { id: integer().primaryKey() });
  const missingColumnChild = defineTable("schema_history_missing_column_child", {
    id: integer().primaryKey(),
    parent_id: integer().references("schema_history_missing_column_parent", "missing"),
  });
  assert.throws(() => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({
        versions: [tableVersion({ schemaVersion: 1, table: missingColumnParent, migration: createTable(missingColumnParent) })],
        current: missingColumnParent,
      }),
      defineTableHistory({
        versions: [tableVersion({ schemaVersion: 1, table: missingColumnChild, migration: createTable(missingColumnChild) })],
        current: missingColumnChild,
      }),
    ])],
  }), /misses foreign column/);
});
