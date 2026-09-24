/*
 * No production exports. Tests protect sealed executable migration history.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, defineTable, index, integer, sql, text } from "./schema-definition.ts";
import {
  copyDistinctValues, createTable, defineSubsystemHistory, defineTableHistory, defineWorkbenchDatabaseSchema,
  rebuildTable, sqlData, tableVersion, type WorkbenchDatabaseSchema,
} from "./schema-history.ts";
import {
  assertSchemaReleaseManifest, fingerprintSchemaReleases, inspectSchemaReleases, type SchemaReleaseRegistry,
} from "./schema-release-manifest.ts";

function fixture(options: {
  addition?: number;
  map?: "original" | "changed";
  index?: boolean;
  constraint?: boolean;
  defaultValue?: number;
} = {}) {
  const first = defineTable("records", { id: integer().primaryKey(), value: text().notNull() });
  const current = defineTable("records", {
    id: integer().primaryKey(), value: text().notNull(), score: integer().notNull().default(options.defaultValue ?? 0),
  }, table => ({
    constraints: options.constraint ? [check(sql`${table.score} >= 0`)] : [],
    indexes: options.index ? [index("record_values", [table.value], { unique: true })] : [],
  }));
  const histories = [defineTableHistory({
    current,
    versions: [
      tableVersion({ schemaVersion: 1, table: first, migration: createTable(first) }),
      tableVersion({
        schemaVersion: 2, table: current,
        migration: rebuildTable({
          from: first, to: current,
          map: options.map === "changed" ? () => ({ value: sql.text`'changed'` }) : undefined,
        }),
      }),
    ],
  })];
  const extra = defineTable("extra", { id: integer().primaryKey() });
  return defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      ...histories,
      ...(options.addition ? [defineTableHistory({
        current: extra,
        versions: [tableVersion({ schemaVersion: options.addition, table: extra, migration: createTable(extra) })],
      })] : []),
    ])],
  });
}

function seal(schema: WorkbenchDatabaseSchema): SchemaReleaseRegistry {
  return Object.fromEntries(fingerprintSchemaReleases(schema).map(release => [`release${release.version}`, release]));
}

test("sealed SQL data conversion rejects a changed operation", () => {
  const build = (value: string) => {
    const table = defineTable("data_conversion", { id: integer().primaryKey(), value: text().notNull() });
    return defineWorkbenchDatabaseSchema({ subsystems: [defineSubsystemHistory([
      defineTableHistory({ current: table, versions: [
        tableVersion({ schemaVersion: 1, table, migration: createTable(table) }),
        tableVersion({ schemaVersion: 2, table,
          migration: sqlData([`UPDATE data_conversion SET value = '${value}'`]) }),
      ] }),
    ])] });
  };
  assert.throws(() => assertSchemaReleaseManifest(build("changed"), seal(build("original")), "fixture"), /changed/u);
});

test("changing a reference backfill changes only its own release fingerprint", () => {
  const providers = defineTable("providers", { id: text().primaryKey() });
  const old = defineTable("records", { id: integer().primaryKey(), provider: text(), alternative: text() });
  const next = defineTable("records", {
    id: integer().primaryKey(), provider: text().references("providers", "id"), alternative: text(),
  });
  const build = (sourceColumn: "provider" | "alternative") => defineWorkbenchDatabaseSchema({
    subsystems: [defineSubsystemHistory([
      defineTableHistory({ current: providers, versions: [
        tableVersion({ schemaVersion: 1, table: providers, migration: createTable(providers) }),
      ] }),
      defineTableHistory({ current: next, versions: [
        tableVersion({ schemaVersion: 1, table: old, migration: createTable(old) }),
        tableVersion({ schemaVersion: 2, table: next, migration: [
          copyDistinctValues({ from: old, sourceColumn, to: providers, targetColumn: "id" }),
          rebuildTable({ from: old, to: next }),
        ] }),
      ] }),
    ])],
  });
  const original = build("provider");
  const changed = build("alternative");
  assert.deepEqual(fingerprintSchemaReleases(original)[0], fingerprintSchemaReleases(changed)[0]);
  assert.throws(() => assertSchemaReleaseManifest(changed, seal(original), "fixture"), /changed/);
});
test("independently reconstructed declarations retain their release fingerprints", () => {
  const releases = seal(fixture());
  assert.doesNotThrow(() => assertSchemaReleaseManifest(fixture(), releases, "fixture"));
  assert.deepEqual(inspectSchemaReleases(fixture(), releases), []);
});

for (const change of [
  { addition: 1 }, { addition: 2 }, { map: "changed" as const },
  { index: true }, { constraint: true }, { defaultValue: 7 },
]) {
  test(`sealed history rejects a retroactive semantic change ${JSON.stringify(change)}`, () => {
    const releases = seal(fixture());
    assert.throws(() => inspectSchemaReleases(fixture(change), releases), /sealed.*changed/i);
  });
}

test("only the new final release can be fingerprinted and must be sealed before opening", () => {
  const schema = fixture({ addition: 3 });
  const releases = { ...seal(fixture()), newFeature: { version: 3, fingerprint: null } };
  const candidates = inspectSchemaReleases(schema, releases);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.version, 3);
  assert.throws(() => assertSchemaReleaseManifest(schema, releases, "fixture"), /unsealed/i);
  assert.doesNotThrow(() => assertSchemaReleaseManifest(schema, {
    ...releases, newFeature: { version: 3, fingerprint: candidates[0]!.fingerprint },
  }, "fixture"));
});

test("an old changed release cannot be hidden by adding a new unsealed release", () => {
  const releases = { ...seal(fixture()), newFeature: { version: 3, fingerprint: null } };
  assert.throws(() => inspectSchemaReleases(fixture({ addition: 3, map: "changed" }), releases), /sealed.*changed/i);
});

test("release collisions, gaps, absent declarations, and malformed fingerprints are rejected", () => {
  const schema = fixture();
  const releases = seal(schema);
  assert.throws(() => inspectSchemaReleases(schema, { ...releases, collision: releases.release2! }), /duplicate/i);
  assert.throws(() => inspectSchemaReleases(schema, { release2: releases.release2! }), /missing/i);
  assert.throws(() => inspectSchemaReleases(schema, { ...releases, future: { version: 3, fingerprint: null } }), /declaration/i);
  assert.throws(() => inspectSchemaReleases(schema, { ...releases, release2: { version: 2, fingerprint: "bad" } }), /fingerprint/i);
  assert.throws(() => inspectSchemaReleases(schema, {
    release1: { version: 1, fingerprint: null }, release2: { version: 2, fingerprint: null },
  }), /final/i);
});

test("several tables can belong to one sealed atomic release", () => {
  const schema = fixture({ addition: 2 });
  assert.doesNotThrow(() => assertSchemaReleaseManifest(schema, seal(schema), "fixture"));
});
