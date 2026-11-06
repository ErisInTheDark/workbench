/*
 * Exports:
 * - threadAutoResumeSettings: the daemon's edited auto resume settings; no row uses the defaults.
 * - threadAutoResumeSchemaHistory: settings storage history.
 */
import { booleanInteger, check, defineTable, enumText, integer, sql, type SqlFragment } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const idleSettings = defineTable("workbench_thread_auto_resume", {
  id: enumText("global").primaryKey(),
  enabled: booleanInteger().notNull(),
  idle_minutes: integer().notNull(),
}, table => ({
  constraints: [check(sql`${table.idle_minutes} BETWEEN 10 AND 120 AND ${table.idle_minutes} % 10 = 0`)],
}));
const settings = defineTable("workbench_thread_auto_resume", {
  id: enumText("global").primaryKey(),
  enabled: booleanInteger().notNull(),
  expired_cache: enumText("wait", "compact").notNull(),
});
const history = defineTableHistory({
  current: settings,
  versions: [
    tableVersion({ schemaVersion: releases.threadAutoResume.version, table: idleSettings, migration: createTable(idleSettings) }),
    tableVersion({
      schemaVersion: releases.threadAutoResumeExpiredCache.version,
      table: settings,
      migration: rebuildTable({
        from: idleSettings, to: settings,
        map: ({ expression }) => ({ expired_cache: expression.text`'compact'` as SqlFragment<"wait" | "compact"> }),
      }),
    }),
  ],
});

export const threadAutoResumeSettings = history.current;
export const threadAutoResumeSchemaHistory = defineSubsystemHistory([history]);
