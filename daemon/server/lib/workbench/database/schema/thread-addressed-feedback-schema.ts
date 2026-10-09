/*
 * Exports:
 * - threadAddressedFeedbackSchemaHistory: feedback reports a thread was launched to address, kept as the references it received.
 */
import { defineTable, enumText, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// Reports can live on another machine's daemon, so rows reference them by daemon and id rather than by foreign key.
const addressed = defineTable("workbench_thread_addressed_feedback", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  source_daemon_id: text().notNull(),
  feedback_id: integer().notNull().nonNegative(),
  position: integer().notNull().nonNegative(),
  category: enumText("bug", "waste", "confusion", "opportunity").notNull(),
  title: text().notNull(),
  author: text().notNull(),
  thread_label: text().notNull(),
  report: text().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.source_daemon_id, table.feedback_id])] }));

export const threadAddressedFeedbackSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: addressed,
  versions: [tableVersion({ schemaVersion: releases.threadTodos.version, table: addressed, migration: createTable(addressed) })],
})]);
