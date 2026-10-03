/*
 * Exports:
 * - threadSkillSchemaHistory: per-thread active skills and their undelivered agent notices.
 */
import { defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// A row stays while its skill is active or while its deactivation notice is undelivered.
const skills = defineTable("workbench_thread_skills", {
  thread_id: text().notNull().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  path: text().notNull(),
  name: text().notNull(),
  source: text().notNull(),
  activated_at: integer().notNull(),
  active: integer().notNull(),
  pending_notice: text(),
}, table => ({ constraints: [primaryKey([table.thread_id, table.path])] }));

export const threadSkillSchemaHistory = defineSubsystemHistory([defineTableHistory({
  current: skills,
  versions: [tableVersion({ schemaVersion: releases.threadSkills.version, table: skills, migration: createTable(skills) })],
})]);
