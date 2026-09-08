/*
 * Keywords: database, schema inventory, history, typed tables.
 * WORKBENCH_DATABASE_TABLE_NAMES: exact current Workbench database table inventory. Keywords: database, schema, tables.
 * WORKBENCH_DATABASE_SCHEMA_VERSION: current global SQLite schema version. Keywords: database, schema, version.
 * installWorkbenchDatabaseSchema: install latest or an explicit historical target transactionally, never downgrade. Keywords: database, schema, install.
 * coreTables: current core table map. Keywords: database, schema, core.
 * CoreSchemaRows: current core selected-row registry. Keywords: database, schema, types.
 * codexSandboxNetworkTables: current Codex sandbox network table map. Keywords: database, schema, Codex, network.
 * CodexSandboxNetworkSchemaRows: current Codex sandbox network selected-row registry. Keywords: database, schema, Codex, network.
 * itemTables: current item table map. Keywords: database, schema, item.
 * ItemSchemaRows: current item selected-row registry. Keywords: database, schema, types.
 * operationSourceTables: current operation source table map. Keywords: database, schema, operation.
 * OperationSourceSchemaRows: current operation source selected-row registry. Keywords: database, schema, types.
 * interactionTables: current interaction table map. Keywords: database, schema, interaction.
 * InteractionSchemaRows: current interaction selected-row registry. Keywords: database, schema, types.
 * evidenceTables: current evidence table map. Keywords: database, schema, evidence.
 * EvidenceSchemaRows: current evidence selected-row registry. Keywords: database, schema, types.
 * threadStateTables: current thread-state table map. Keywords: database, schema, thread state.
 * ThreadStateSchemaRows: current thread-state selected-row registry. Keywords: database, schema, thread state, types.
 * searchTables/SearchSchemaRows: current workspace-search projection registry. Keywords: database, schema, search.
 * usageTables/UsageSchemaRows: durable token, rate-limit, and claim-session facts. Keywords: database, schema, stats.
 * transcriptIdentityTables/TranscriptIdentitySchemaRows: permanent identity and compatibility aliases.
 * workbenchDatabaseTables: every current table keyed by its SQLite name. Keywords: database, schema, statements.
 * workbenchDatabaseSchema: assembled history used by protected production migration.
 * validateWorkbenchDatabaseReleases: reject rewritten or unsealed releases before opening SQLite.
 */
import type Database from "better-sqlite3";

import { codexSandboxNetworkSchemaHistory } from "../../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
import { composerProfileSchemaHistory } from "../../lib/workbench/database/schema/composer-profile-schema.ts";
import { coreSchemaHistory } from "workbench-shared/workbench/database/schema/core-schema";
import { evidenceSchemaHistory } from "workbench-shared/workbench/database/schema/evidence-schema";
import { interactionSchemaHistory } from "workbench-shared/workbench/database/schema/interaction-schema";
import { itemSchemaHistory } from "workbench-shared/workbench/database/schema/item-schema";
import { operationSourceSchemaHistory } from "workbench-shared/workbench/database/schema/operation-source-schema";
import { searchSchemaHistory } from "workbench-shared/workbench/database/schema/search-schema";
import { usageSchemaHistory } from "workbench-shared/workbench/database/schema/usage-schema";
import { transcriptIdentitySchemaHistory } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
import { threadStateSchemaHistory } from "../../lib/workbench/database/schema/thread-state-schema.ts";
import { threadTitleHistorySchemaHistory } from "../../lib/workbench/database/schema/thread-title-history-schema.ts";
import type { CurrentTableDefinition } from "workbench-shared/database/schema/schema-definition";
import { applyWorkbenchDatabaseSchema, defineWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { assertSchemaReleaseManifest } from "workbench-shared/database/schema/schema-release-manifest";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

export { codexSandboxNetworkTables } from "../../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
export type { CodexSandboxNetworkSchemaRows } from "../../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
export { coreTables } from "workbench-shared/workbench/database/schema/core-schema";
export type { CoreSchemaRows } from "workbench-shared/workbench/database/schema/core-schema";
export { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
export type { EvidenceSchemaRows } from "workbench-shared/workbench/database/schema/evidence-schema";
export { interactionTables } from "workbench-shared/workbench/database/schema/interaction-schema";
export type { InteractionSchemaRows } from "workbench-shared/workbench/database/schema/interaction-schema";
export { itemTables } from "workbench-shared/workbench/database/schema/item-schema";
export type { ItemSchemaRows } from "workbench-shared/workbench/database/schema/item-schema";
export { operationSourceTables } from "workbench-shared/workbench/database/schema/operation-source-schema";
export type { OperationSourceSchemaRows } from "workbench-shared/workbench/database/schema/operation-source-schema";
export { searchTables } from "workbench-shared/workbench/database/schema/search-schema";
export type { SearchSchemaRows } from "workbench-shared/workbench/database/schema/search-schema";
export { usageTables } from "workbench-shared/workbench/database/schema/usage-schema";
export type { UsageSchemaRows } from "workbench-shared/workbench/database/schema/usage-schema";
export { threadStateTables } from "../../lib/workbench/database/schema/thread-state-schema.ts";
export type { ThreadStateSchemaRows } from "../../lib/workbench/database/schema/thread-state-schema.ts";
export { transcriptIdentityTables } from "workbench-shared/workbench/database/schema/transcript-identity-schema";
export type { TranscriptIdentitySchemaRows } from "workbench-shared/workbench/database/schema/transcript-identity-schema";

export const workbenchDatabaseSchema = defineWorkbenchDatabaseSchema({
  subsystems: [
    composerProfileSchemaHistory,
    codexSandboxNetworkSchemaHistory,
    coreSchemaHistory,
    transcriptIdentitySchemaHistory,
    itemSchemaHistory,
    operationSourceSchemaHistory,
    interactionSchemaHistory,
    evidenceSchemaHistory,
    threadStateSchemaHistory,
    threadTitleHistorySchemaHistory,
    searchSchemaHistory,
    usageSchemaHistory,
  ],
});

export const workbenchDatabaseTables = Object.freeze(Object.fromEntries(
  workbenchDatabaseSchema.currentTables.map((table) => [table.name, table]),
)) as Readonly<Record<string, CurrentTableDefinition>>;

export const WORKBENCH_DATABASE_TABLE_NAMES = Object.freeze(
  workbenchDatabaseSchema.currentTables.map((table) => table.name),
);

export const WORKBENCH_DATABASE_SCHEMA_VERSION = workbenchDatabaseSchema.currentVersion;

export function validateWorkbenchDatabaseReleases() {
  assertSchemaReleaseManifest(workbenchDatabaseSchema, databaseReleases, "orchestrator");
}

export function installWorkbenchDatabaseSchema(database: Database.Database, options: { targetVersion?: number } = {}) {
  validateWorkbenchDatabaseReleases();
  applyWorkbenchDatabaseSchema(database, workbenchDatabaseSchema, options);
}
