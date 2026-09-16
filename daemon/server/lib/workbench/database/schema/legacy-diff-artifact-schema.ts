/*
 * Exports:
 * - legacyDiffArtifacts: thread-owned immutable legacy diff text.
 * - legacyDiffArtifactSchemaHistory: legacy artifact installation history.
 */
import { defineTable, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_legacy_diff_artifacts", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  digest: text().notNull(),
  diff: text().notNull(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.digest])] }));
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.legacyDiffArtifacts.version, table, migration: createTable(table) })],
});
export const legacyDiffArtifacts = history.current;
export const legacyDiffArtifactSchemaHistory = defineSubsystemHistory([history]);
