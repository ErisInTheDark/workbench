/*
 * WORKBENCH_DATABASE_TABLE_NAMES: exact current Workbench database table inventory. Keywords: database, schema, tables.
 * WORKBENCH_DATABASE_SCHEMA_VERSION: current global SQLite schema version. Keywords: database, schema, version.
 * installWorkbenchDatabaseSchema: apply every missing schema version transactionally. Keywords: database, schema, install.
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
 * workbenchDatabaseTables: every current table keyed by its SQLite name. Keywords: database, schema, statements.
 */
import type Database from "better-sqlite3";

import { codexSandboxNetworkSchemaHistory } from "../../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
import { coreSchemaHistory } from "workbench-shared/workbench/database/schema/core-schema";
import { evidenceSchemaHistory } from "workbench-shared/workbench/database/schema/evidence-schema";
import { interactionSchemaHistory } from "workbench-shared/workbench/database/schema/interaction-schema";
import { itemSchemaHistory } from "workbench-shared/workbench/database/schema/item-schema";
import { operationSourceSchemaHistory } from "workbench-shared/workbench/database/schema/operation-source-schema";
import { searchSchemaHistory } from "workbench-shared/workbench/database/schema/search-schema";
import { usageSchemaHistory } from "workbench-shared/workbench/database/schema/usage-schema";
import { threadStateSchemaHistory } from "../../lib/workbench/database/schema/thread-state-schema.ts";
import type { CurrentTableDefinition } from "workbench-shared/database/schema/schema-definition";
import { applyWorkbenchDatabaseSchema, defineWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { codexSandboxNetworkTables } from "../../lib/workbench/database/schema/codex-sandbox-network-schema.ts";
import { coreTables } from "workbench-shared/workbench/database/schema/core-schema";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import { interactionTables } from "workbench-shared/workbench/database/schema/interaction-schema";
import { itemTables } from "workbench-shared/workbench/database/schema/item-schema";
import { operationSourceTables } from "workbench-shared/workbench/database/schema/operation-source-schema";
import { searchTables } from "workbench-shared/workbench/database/schema/search-schema";
import { usageTables } from "workbench-shared/workbench/database/schema/usage-schema";
import { threadStateTables } from "../../lib/workbench/database/schema/thread-state-schema.ts";

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

const workbenchDatabaseSchema = defineWorkbenchDatabaseSchema({
  subsystems: [
    codexSandboxNetworkSchemaHistory,
    coreSchemaHistory,
    itemSchemaHistory,
    operationSourceSchemaHistory,
    interactionSchemaHistory,
    evidenceSchemaHistory,
    threadStateSchemaHistory,
    searchSchemaHistory,
    usageSchemaHistory,
  ],
});

const currentTables = {
  ...codexSandboxNetworkTables,
  ...coreTables,
  ...itemTables,
  ...operationSourceTables,
  ...interactionTables,
  ...evidenceTables,
  ...threadStateTables,
  ...searchTables,
  ...usageTables,
};

export const workbenchDatabaseTables = Object.freeze(Object.fromEntries(
  Object.values(currentTables).map((table) => [table.name, table]),
)) as Readonly<Record<string, CurrentTableDefinition>>;

export const WORKBENCH_DATABASE_TABLE_NAMES = Object.freeze(
  workbenchDatabaseSchema.currentTables.map((table) => table.name),
);

export const WORKBENCH_DATABASE_SCHEMA_VERSION = workbenchDatabaseSchema.currentVersion;

export function installWorkbenchDatabaseSchema(database: Database.Database) {
  applyWorkbenchDatabaseSchema(database, workbenchDatabaseSchema);
}
