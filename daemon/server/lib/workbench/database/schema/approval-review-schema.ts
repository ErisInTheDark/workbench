/*
 * Exports:
 * - approvalReviewSelection: the singleton selected auto-approve reviewer.
 * - approvalReviewSecrets: Workbench-held reviewer credentials, sealed per device and user.
 * - approvalReviewSchemaHistory: auto-approve reviewer settings schema.
 */
import { blob, check, defineTable, enumText, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

// Release 66 pinned reviewer ids in SQL; ids are now validated against the shared registry on read.
const pinnedReviewerIds = ["typesafe-jev", "zen-jev", "codex-auto-review"] as const;

const pinnedSelection = defineTable("approval_review_selection", {
  id: text().primaryKey(),
  reviewer_id: enumText(...pinnedReviewerIds),
}, table => ({ constraints: [check(sql`${table.id} = ${literal("global")}`)] }));

const pinnedSecrets = defineTable("approval_review_secrets", {
  reviewer_id: enumText(...pinnedReviewerIds).primaryKey(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
});

const selection = defineTable("approval_review_selection", {
  id: text().primaryKey(),
  reviewer_id: text(),
}, table => ({ constraints: [check(sql`${table.id} = ${literal("global")}`)] }));

const secrets = defineTable("approval_review_secrets", {
  reviewer_id: text().primaryKey(),
  nonce: blob().notNull(),
  ciphertext: blob().notNull(),
  updated_at: integer().notNull().nonNegative(),
});

const selectionHistory = defineTableHistory({
  current: selection,
  versions: [
    tableVersion({ schemaVersion: releases.daemonProjects.version, table: pinnedSelection, migration: createTable(pinnedSelection) }),
    tableVersion({ schemaVersion: releases.openApprovalReviewers.version, table: selection, migration: rebuildTable({ from: pinnedSelection, to: selection }) }),
  ],
});
const secretHistory = defineTableHistory({
  current: secrets,
  versions: [
    tableVersion({ schemaVersion: releases.daemonProjects.version, table: pinnedSecrets, migration: createTable(pinnedSecrets) }),
    tableVersion({ schemaVersion: releases.openApprovalReviewers.version, table: secrets, migration: rebuildTable({ from: pinnedSecrets, to: secrets }) }),
  ],
});

export const approvalReviewSelection = selectionHistory.current;
export const approvalReviewSecrets = secretHistory.current;
export const approvalReviewSchemaHistory = defineSubsystemHistory([selectionHistory, secretHistory]);
