/*
 * Exports:
 * - threadInstructionOverlays: the modes and checklists each thread's last built instructions and activated skills declared.
 * - threadInstructionOverlaySchemaHistory: additive storage history.
 */
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const table = defineTable("workbench_thread_instruction_overlays", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  base_json: text(),
  skills_json: text().notNull(),
  updated_at: integer().notNull(),
});
const history = defineTableHistory({
  current: table,
  versions: [tableVersion({ schemaVersion: releases.threadInstructionOverlays.version, table, migration: createTable(table) })],
});
export const threadInstructionOverlays = history.current;
export const threadInstructionOverlaySchemaHistory = defineSubsystemHistory([history]);
