/*
 * WORKBENCH_DATABASE_TABLE_NAMES: exact current Workbench database table inventory. Keywords: database, schema, tables.
 * WORKBENCH_DATABASE_SCHEMA_VERSION: current global SQLite schema version. Keywords: database, schema, version.
 * installWorkbenchDatabaseSchema: apply every missing schema version transactionally. Keywords: database, schema, install.
 * coreTables: current core table map. Keywords: database, schema, core.
 * CoreSchemaRows: current core selected-row registry. Keywords: database, schema, types.
 * itemTables: current item table map. Keywords: database, schema, item.
 * ItemSchemaRows: current item selected-row registry. Keywords: database, schema, types.
 * operationSourceTables: current operation source table map. Keywords: database, schema, operation.
 * OperationSourceSchemaRows: current operation source selected-row registry. Keywords: database, schema, types.
 * interactionTables: current interaction table map. Keywords: database, schema, interaction.
 * InteractionSchemaRows: current interaction selected-row registry. Keywords: database, schema, types.
 * evidenceTables: current evidence table map. Keywords: database, schema, evidence.
 * EvidenceSchemaRows: current evidence selected-row registry. Keywords: database, schema, types.
 * workbenchDatabaseTables: every current table keyed by its SQLite name. Keywords: database, schema, statements.
 */
import type Database from "better-sqlite3";

import { coreSchemaHistory } from "../../lib/workbench/database/schema/core-schema.ts";
import { evidenceSchemaHistory } from "../../lib/workbench/database/schema/evidence-schema.ts";
import { interactionSchemaHistory } from "../../lib/workbench/database/schema/interaction-schema.ts";
import { itemSchemaHistory } from "../../lib/workbench/database/schema/item-schema.ts";
import { operationSourceSchemaHistory } from "../../lib/workbench/database/schema/operation-source-schema.ts";
import { applyWorkbenchDatabaseSchema, defineWorkbenchDatabaseSchema } from "../../lib/workbench/database/schema/schema-history.ts";
import type { CurrentTableDefinition } from "../../lib/workbench/database/schema/schema-definition.ts";
import { coreTables } from "../../lib/workbench/database/schema/core-schema.ts";
import { evidenceTables } from "../../lib/workbench/database/schema/evidence-schema.ts";
import { interactionTables } from "../../lib/workbench/database/schema/interaction-schema.ts";
import { itemTables } from "../../lib/workbench/database/schema/item-schema.ts";
import { operationSourceTables } from "../../lib/workbench/database/schema/operation-source-schema.ts";

export { coreTables } from "../../lib/workbench/database/schema/core-schema.ts";
export type { CoreSchemaRows } from "../../lib/workbench/database/schema/core-schema.ts";
export { evidenceTables } from "../../lib/workbench/database/schema/evidence-schema.ts";
export type { EvidenceSchemaRows } from "../../lib/workbench/database/schema/evidence-schema.ts";
export { interactionTables } from "../../lib/workbench/database/schema/interaction-schema.ts";
export type { InteractionSchemaRows } from "../../lib/workbench/database/schema/interaction-schema.ts";
export { itemTables } from "../../lib/workbench/database/schema/item-schema.ts";
export type { ItemSchemaRows } from "../../lib/workbench/database/schema/item-schema.ts";
export { operationSourceTables } from "../../lib/workbench/database/schema/operation-source-schema.ts";
export type { OperationSourceSchemaRows } from "../../lib/workbench/database/schema/operation-source-schema.ts";

const workbenchDatabaseSchema = defineWorkbenchDatabaseSchema({
  subsystems: [
    coreSchemaHistory,
    itemSchemaHistory,
    operationSourceSchemaHistory,
    interactionSchemaHistory,
    evidenceSchemaHistory,
  ],
});

const currentTables = {
  ...coreTables,
  ...itemTables,
  ...operationSourceTables,
  ...interactionTables,
  ...evidenceTables,
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
