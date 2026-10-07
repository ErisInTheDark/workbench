/*
 * Exports:
 * - approvalReviewSelection: the singleton selected auto-approve reviewer.
 * - approvalReviewSecrets: Workbench-held reviewer credentials, sealed per device and user.
 * - approvalReviewSchemaHistory: auto-approve reviewer settings schema.
 */
import { blob, check, defineTable, enumText, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const reviewerIds = ["typesafe-jev", "zen-jev", "codex-auto-review"] as const;

const selection = defineTable("approval_review_selection", {
  id: text().primaryKey(),
  reviewer_id: enumText(...reviewerIds),
}, table => ({ constraints: [check(sql`${table.id} = ${literal("global")}`)] }));

const secrets = defineTable("approval_review_secrets", {
  reviewer_id: enumText(...reviewerIds).primaryKey(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
});

const selectionHistory = defineTableHistory({
  current: selection,
  versions: [tableVersion({ schemaVersion: releases.daemonProjects.version, table: selection, migration: createTable(selection) })],
});
const secretHistory = defineTableHistory({
  current: secrets,
  versions: [tableVersion({ schemaVersion: releases.daemonProjects.version, table: secrets, migration: createTable(secrets) })],
});

export const approvalReviewSelection = selectionHistory.current;
export const approvalReviewSecrets = secretHistory.current;
export const approvalReviewSchemaHistory = defineSubsystemHistory([selectionHistory, secretHistory]);
