/*
 * Exports:
 * - defineThreadGitObservationSchema: preserve absent, null and ordered Git observations.
 */
import {
  booleanInteger, check, ColumnDefinition, defineTable, enumText, foreignKey, integer, literal,
  primaryKey, sql, text, unique, type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion,
} from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

export function defineThreadGitObservationSchema(schemaVersion: number) {
  function install<Table extends TableDefinition>(table: Table) {
    return defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    });
  }

  const observations = install(defineTable("workbench_thread_git_observations", {
    id: text().primaryKey(),
    thread_id: text().notNull().references("workbench_thread_states", "thread_id", { onDelete: "CASCADE" }),
    observation_kind: enumText("arc", "plan").notNull(),
    has_value: booleanInteger().notNull(),
  }, (table) => ({
    constraints: [
      unique([table.thread_id, table.observation_kind]),
      unique([table.id, table.observation_kind, table.has_value]),
    ],
  })));

  function defineEntries(phase: ColumnDefinition<string>) {
    return defineTable("workbench_thread_git_entries", {
      id: text().primaryKey(),
      observation_id: text().notNull(),
      observation_kind: enumText("arc", "plan").notNull(),
      has_value: booleanInteger().notNull(),
      entry_kind: enumText("summary", "member").notNull(),
      entry_index: integer().notNull().nonNegative(),
      checkpoint_commit: text().notNull(),
      intent_name: text().notNull(),
      intent_description: text().notNull(),
      updated_at: text().notNull(),
      phase,
      harness: text(),
      thread_id: text(),
      repo_root: text(),
      root_id: text(),
    }, (table) => ({
      constraints: [
        foreignKey([table.observation_id, table.observation_kind, table.has_value], {
          table: "workbench_thread_git_observations", columns: ["id", "observation_kind", "has_value"], onDelete: "CASCADE",
        }),
        unique([table.observation_id, table.entry_kind, table.entry_index]),
        unique([table.id, table.observation_kind]),
        unique([table.id, table.entry_kind]),
        check(sql`${table.has_value} = ${literal(1)}`),
        check(sql`(${table.observation_kind} = ${literal("arc")} AND ${table.phase} IS NOT NULL) OR (${table.observation_kind} = ${literal("plan")} AND ${table.phase} IS NULL)`),
        check(sql`(${table.entry_kind} = ${literal("summary")} AND ${table.entry_index} = ${literal(0)} AND ${table.harness} IS NULL AND ${table.thread_id} IS NULL AND ${table.repo_root} IS NULL AND ${table.root_id} IS NULL) OR (${table.entry_kind} = ${literal("member")} AND ${table.harness} IS NOT NULL AND ${table.thread_id} IS NOT NULL AND ${table.repo_root} IS NOT NULL AND ${table.root_id} IS NOT NULL)`),
      ],
    }));
  }

  const entriesV1 = defineEntries(enumText("active", "resolved"));
  const entriesTable = defineEntries(enumText("active", "stashed", "resolved"));
  const entries = defineTableHistory({
    current: entriesTable,
    versions: [
      tableVersion({ schemaVersion, table: entriesV1, migration: createTable(entriesV1) }),
      tableVersion({
        schemaVersion: databaseReleases.stashedGitArcObservations.version,
        table: entriesTable,
        migration: rebuildTable({ from: entriesV1, to: entriesTable }),
      }),
    ],
  });

  const paths = install(defineTable("workbench_thread_git_paths", {
    entry_id: text().notNull().references("workbench_thread_git_entries", "id", { onDelete: "CASCADE" }),
    path_index: integer().notNull().nonNegative(),
    path: text().notNull(),
  }, (table) => ({ constraints: [primaryKey([table.entry_id, table.path_index])] })));

  const proposals = install(defineTable("workbench_thread_git_proposals", {
    entry_id: text().notNull(),
    observation_kind: enumText("arc").notNull(),
    proposal_index: integer().notNull().nonNegative(),
    proposal_id: text().notNull(),
    root_id: text(),
    status: enumText("committed", "proposed").notNull(),
  }, (table) => ({
    constraints: [
      primaryKey([table.entry_id, table.proposal_index]),
      foreignKey([table.entry_id, table.observation_kind], {
        table: "workbench_thread_git_entries", columns: ["id", "observation_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  const memberRoots = install(defineTable("workbench_thread_git_member_roots", {
    entry_id: text().notNull(),
    entry_kind: enumText("member").notNull(),
    root_index: integer().notNull().nonNegative(),
    root_id: text().notNull(),
  }, (table) => ({
    constraints: [
      primaryKey([table.entry_id, table.root_index]),
      foreignKey([table.entry_id, table.entry_kind], {
        table: "workbench_thread_git_entries", columns: ["id", "entry_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  return {
    tables: {
      observations: observations.current, entries: entries.current, paths: paths.current,
      proposals: proposals.current, memberRoots: memberRoots.current,
    },
    history: defineSubsystemHistory([observations, entries, paths, proposals, memberRoots]),
  };
}
