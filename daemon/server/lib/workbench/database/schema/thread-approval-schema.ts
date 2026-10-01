/*
 * Exports:
 * - itemApprovalOutcomes: per-tool-item approval result bound to stable transcript item identity.
 * - itemApprovalSchemaHistory: additive approval outcome schema.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { enumText, defineTable, foreignKey, index, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import { WORKBENCH_APPROVAL_OUTCOMES } from "workbench-shared/workbench/provider/provider-approval";

// Keyed on item identity, not thread_items rows, so rematerialised transcripts keep their outcomes.
const outcomes = defineTable("workbench_item_approvals", {
  item_id: text().primaryKey(),
  thread_id: text().notNull(),
  turn_id: text().notNull(),
  outcome: enumText(...WORKBENCH_APPROVAL_OUTCOMES).notNull(),
  resolved_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [
    foreignKey([table.item_id, table.thread_id], {
      table: "workbench_transcript_item_identities", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
    foreignKey([table.turn_id, table.thread_id], {
      table: "thread_turns", columns: ["id", "thread_id"], onDelete: "CASCADE",
    }),
  ],
  indexes: [index("workbench_item_approvals_thread_idx", [table.thread_id, table.turn_id])],
}));
const outcomeHistory = defineTableHistory({
  versions: [tableVersion({ schemaVersion: databaseReleases.itemApprovals.version, table: outcomes, migration: createTable(outcomes) })],
  current: outcomes,
});
export const itemApprovalOutcomes = outcomeHistory.current;
export const itemApprovalSchemaHistory = defineSubsystemHistory([outcomeHistory]);
