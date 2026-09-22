/*
 * Exports:
 * - commandApprovalRules: project-owned execution-directory permissions.
 * - commandApprovalTokens: ordered literal prefix tokens.
 * - commandApprovalSchemaHistory: additive permission schema.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { defineTable, integer, primaryKey, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";

const rules = defineTable("command_approval_rules", {
  id: text().primaryKey(),
  project_id: text().notNull().references("workbench_projects", "id", { onDelete: "CASCADE" }),
  workdir: text().notNull(),
});
const tokens = defineTable("command_approval_tokens", {
  rule_id: text().notNull().references("command_approval_rules", "id", { onDelete: "CASCADE" }),
  token_index: integer().notNull().nonNegative(),
  token: text().notNull(),
}, table => ({ constraints: [primaryKey([table.rule_id, table.token_index])] }));
const ruleHistory = defineTableHistory({
  versions: [tableVersion({ schemaVersion: databaseReleases.commandApprovals.version, table: rules, migration: createTable(rules) })],
  current: rules,
});
const tokenHistory = defineTableHistory({
  versions: [tableVersion({ schemaVersion: databaseReleases.commandApprovals.version, table: tokens, migration: createTable(tokens) })],
  current: tokens,
});
export const commandApprovalRules = ruleHistory.current;
export const commandApprovalTokens = tokenHistory.current;
export const commandApprovalSchemaHistory = defineSubsystemHistory([ruleHistory, tokenHistory]);
