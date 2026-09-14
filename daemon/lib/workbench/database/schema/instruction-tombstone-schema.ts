/*
 * Exports:
 * - instructionTombstones: durable one-time retired instruction file receipts.
 * - instructionTombstoneTables: current instruction tombstone table inventory.
 * - instructionTombstoneSchemaHistory: instruction tombstone schema history.
 */
import {
  check,
  defineTable,
  enumText,
  integer,
  literal,
  sql,
  text,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_instruction_tombstones", {
  target_path: text().primaryKey(),
  quarantine_path: text().notNull().unique(),
  state: enumText("pending", "consumed").notNull(),
  first_observed_at: integer().notNull().nonNegative(),
  consumed_at: integer().nonNegative(),
}, table => ({
  constraints: [check(sql`
    (${table.state} = ${literal("pending")} AND ${table.consumed_at} IS NULL)
    OR (${table.state} = ${literal("consumed")} AND ${table.consumed_at} IS NOT NULL)
  `)],
}));
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({
    migration: createTable(table),
    schemaVersion: databaseReleases.instructionTombstones.version,
    table,
  })],
});

export const instructionTombstones = history.current;
export const instructionTombstoneTables = Object.freeze({ instructionTombstones });
export const instructionTombstoneSchemaHistory = defineSubsystemHistory([history]);
