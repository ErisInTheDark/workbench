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
 * operationPresentationTables: current presentation table map. Keywords: database, schema, presentation.
 * OperationPresentationSchemaRows: current presentation selected-row registry. Keywords: database, schema, types.
 * interactionTables: current interaction table map. Keywords: database, schema, interaction.
 * InteractionSchemaRows: current interaction selected-row registry. Keywords: database, schema, types.
 * evidenceTables: current evidence table map. Keywords: database, schema, evidence.
 * EvidenceSchemaRows: current evidence selected-row registry. Keywords: database, schema, types.
 */
import type Database from "better-sqlite3";

import { coreSchemaHistory } from "./schema/core-schema.ts";
import { evidenceSchemaHistory } from "./schema/evidence-schema.ts";
import { interactionSchemaHistory } from "./schema/interaction-schema.ts";
import { itemSchemaHistory } from "./schema/item-schema.ts";
import { operationPresentationSchemaHistory } from "./schema/operation-presentation-schema.ts";
import { operationSourceSchemaHistory } from "./schema/operation-source-schema.ts";
import { applyWorkbenchDatabaseSchema, defineWorkbenchDatabaseSchema } from "./schema/schema-history.ts";

export { coreTables } from "./schema/core-schema.ts";
export type { CoreSchemaRows } from "./schema/core-schema.ts";
export { evidenceTables } from "./schema/evidence-schema.ts";
export type { EvidenceSchemaRows } from "./schema/evidence-schema.ts";
export { interactionTables } from "./schema/interaction-schema.ts";
export type { InteractionSchemaRows } from "./schema/interaction-schema.ts";
export { itemTables } from "./schema/item-schema.ts";
export type { ItemSchemaRows } from "./schema/item-schema.ts";
export { operationPresentationTables } from "./schema/operation-presentation-schema.ts";
export type { OperationPresentationSchemaRows } from "./schema/operation-presentation-schema.ts";
export { operationSourceTables } from "./schema/operation-source-schema.ts";
export type { OperationSourceSchemaRows } from "./schema/operation-source-schema.ts";

const workbenchDatabaseSchema = defineWorkbenchDatabaseSchema({
  subsystems: [
    coreSchemaHistory,
    itemSchemaHistory,
    operationSourceSchemaHistory,
    operationPresentationSchemaHistory,
    interactionSchemaHistory,
    evidenceSchemaHistory,
  ],
});

export const WORKBENCH_DATABASE_TABLE_NAMES = Object.freeze(
  workbenchDatabaseSchema.currentTables.map((table) => table.name),
);

export const WORKBENCH_DATABASE_SCHEMA_VERSION = workbenchDatabaseSchema.currentVersion;

export function installWorkbenchDatabaseSchema(database: Database.Database) {
  applyWorkbenchDatabaseSchema(database, workbenchDatabaseSchema);
}
