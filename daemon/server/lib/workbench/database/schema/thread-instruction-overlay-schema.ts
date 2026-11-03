/*
 * Exports:
 * - threadInstructionOverlays: the modes and checklists each thread's last built instructions and activated skills declared,
 *   and the fingerprint of the prefix that build delivered.
 * - threadInstructionOverlaySchemaHistory: additive storage history.
 */
import { addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import releases from "workbench-shared/workbench/database/schema/releases";

const layersV1 = defineTable("workbench_thread_instruction_overlays", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  base_json: text(),
  skills_json: text().notNull(),
  updated_at: integer().notNull(),
});
const table = defineTable("workbench_thread_instruction_overlays", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  base_json: text(),
  skills_json: text().notNull(),
  prefix_json: text(),
  updated_at: integer().notNull(),
});
const history = defineTableHistory({
  current: table,
  versions: [
    tableVersion({ schemaVersion: releases.threadInstructionOverlays.version, table: layersV1, migration: createTable(layersV1) }),
    tableVersion({
      schemaVersion: releases.threadInstructionPrefixes.version, table,
      migration: addColumns({ from: layersV1, to: table, columns: ["prefix_json"] }),
    }),
  ],
});
export const threadInstructionOverlays = history.current;
export const threadInstructionOverlaySchemaHistory = defineSubsystemHistory([history]);
