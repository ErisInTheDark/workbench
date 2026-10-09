/*
 * Exports:
 * - agentFeedbackSchemaHistory: agent-submitted friction reports with the caller's model and effort.
 */
import { check, defineTable, enumText, evolveTable, index, integer, sql, text } from "workbench-shared/database/schema/schema-definition";
import { addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// Feedback outlives its thread; the project owns it.
const feedbackV1 = defineTable("workbench_agent_feedback", {
  id: integer().primaryKey({ autoincrement: true }),
  project_id: text().notNull().references("workbench_projects", "id", { onDelete: "CASCADE" }),
  thread_id: text().references("workbench_threads", "id", { onDelete: "SET NULL" }),
  harness_id: text().notNull().references("workbench_harnesses", "id"),
  model: text(),
  reasoning_effort: text(),
  channel: enumText("wb", "project").notNull(),
  category: enumText("bug", "waste", "confusion", "opportunity").notNull(),
  report: text().notNull(),
  created_at: integer().notNull().nonNegative(),
}, table => ({
  constraints: [check(sql`length(${table.report}) BETWEEN 1 AND 4000`)],
  indexes: [index("workbench_agent_feedback_project_idx", [table.project_id, table.created_at])],
}));
const feedback = evolveTable(feedbackV1, {
  // Old daemon generations may still submit during reload; the new command boundary always supplies a real title.
  add: { title: text().notNull().default("Feedback report") },
});

export const agentFeedbackSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: feedback,
  versions: [
    tableVersion({ schemaVersion: releases.agentFeedback.version, table: feedbackV1, migration: createTable(feedbackV1) }),
    tableVersion({
      schemaVersion: releases.feedbackTitles.version,
      table: feedback,
      migration: addColumns({ from: feedbackV1, to: feedback, columns: ["title"] }),
    }),
  ],
})]);
