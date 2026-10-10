/*
 * Exports:
 * - threadVisSchemaHistory: a thread's vis sessions, their build contexts, the documents captured when each started
 *   and ended, and the answers each sent back.
 */
import { defineTable, enumText, evolveTable, index, integer, primaryKey, sql, text } from "workbench-shared/database/schema/schema-definition";
import { addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const sessions = defineTable("workbench_thread_vis_sessions", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  /** The provider and working directory the CSS command runs as, so live sessions resume after a reload. */
  harness: text().notNull(),
  cwd: text().notNull(),
  project_id: text().notNull(),
  path: text().notNull(),
  started_at: integer().notNull().nonNegative(),
  ended_at: integer().nonNegative(),
}, (table) => ({
  // One live session per file in a thread; ended sessions keep their history.
  indexes: [index("workbench_thread_vis_sessions_active_idx", [table.thread_id, table.path], {
    unique: true, where: sql`${table.ended_at} IS NULL`,
  })],
}));

// Who ended a session: the user's force-end shows them a transcript note the agent never sees.
const sessionsWithEnder = evolveTable(sessions, { add: { ended_by: enumText("agent", "user") } });

// The build context: null kind (older sessions) and `caller` build with the caller's project; `folder` with build_root's `.wb.json`.
const sessionsWithContext = evolveTable(sessionsWithEnder, {
  add: { build_kind: enumText("caller", "folder", "default"), build_root: text() },
});

/** JSON values a vis sent through `wb.send`; the store keeps each session's newest 100. */
const answers = defineTable("workbench_thread_vis_answers", {
  session_id: text().notNull().references("workbench_thread_vis_sessions", "id", { onDelete: "CASCADE" }),
  sequence: integer().notNull().nonNegative(),
  sent_at: integer().notNull().nonNegative(),
  value: text().notNull(),
}, (table) => ({ constraints: [primaryKey([table.session_id, table.sequence])] }));

const snapshots = defineTable("workbench_thread_vis_snapshots", {
  session_id: text().notNull().references("workbench_thread_vis_sessions", "id", { onDelete: "CASCADE" }),
  kind: enumText("start", "end").notNull(),
  captured_at: integer().notNull().nonNegative(),
  document: text(),
  failure: text(),
}, (table) => ({ constraints: [primaryKey([table.session_id, table.kind])] }));

export const threadVisSchemaHistory = defineSubsystemHistory([
  defineTableHistory({
    current: sessionsWithContext,
    versions: [
      tableVersion({ schemaVersion: releases.threadVis.version, table: sessions, migration: createTable(sessions) }),
      tableVersion({
        schemaVersion: releases.threadVisEnders.version, table: sessionsWithEnder,
        migration: addColumns({ from: sessions, to: sessionsWithEnder, columns: ["ended_by"] }),
      }),
      tableVersion({
        schemaVersion: releases.threadVisContextsAndAnswers.version, table: sessionsWithContext,
        migration: addColumns({ from: sessionsWithEnder, to: sessionsWithContext, columns: ["build_kind", "build_root"] }),
      }),
    ],
  }),
  defineTableHistory({
    current: answers,
    versions: [tableVersion({ schemaVersion: releases.threadVisContextsAndAnswers.version, table: answers, migration: createTable(answers) })],
  }),
  defineTableHistory({
    current: snapshots,
    versions: [tableVersion({ schemaVersion: releases.threadVis.version, table: snapshots, migration: createTable(snapshots) })],
  }),
]);
