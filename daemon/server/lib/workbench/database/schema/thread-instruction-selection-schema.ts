/*
 * Exports:
 * - threadInstructionSelectionSchemaHistory: each thread's last chosen instruction selection.
 */
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const selections = defineTable("workbench_thread_instruction_selections", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  selection_json: text().notNull(),
  updated_at: integer().notNull(),
});

export const threadInstructionSelectionSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: selections,
  versions: [tableVersion({
    schemaVersion: releases.threadInstructionSelections.version, table: selections, migration: createTable(selections),
  })],
})]);
