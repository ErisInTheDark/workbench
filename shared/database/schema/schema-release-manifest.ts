/*
 * Exports:
 * - SchemaReleaseRegistry: named global releases and their independently sealed fingerprints.
 * - fingerprintSchemaReleases: describe executable history independently of source layout.
 * - inspectSchemaReleases: validate sealed history and report the one unsealed final release.
 * - assertSchemaReleaseManifest: reject unsealed or rewritten history before database opening.
 */
import { createHash } from "node:crypto";
import type { ForeignTarget, TableDefinition } from "./schema-definition.ts";
import { readWorkbenchDatabaseSchemaHistory, type TableMigration, type WorkbenchDatabaseSchema } from "./schema-history.ts";

export type SchemaReleaseRegistry = Readonly<Record<string, { readonly version: number; readonly fingerprint: string | null }>>;

function foreignTarget(target?: ForeignTarget) {
  return target ? [target.table, target.columns, target.onDelete ?? null] : null;
}

function tableShape(table: TableDefinition) {
  return [
    table.name,
    Object.entries(table.columns).map(([name, { runtime: column }]) => [
      name, column.storageType, column.notNull, column.hasDefault, column.defaultValue ?? null,
      column.primaryKey, column.autoincrement, column.unique, foreignTarget(column.reference),
      column.enumValues ?? null, column.booleanInteger, column.jsonText, column.nonNegative,
    ]),
    table.constraints.map(constraint => {
      if (constraint.kind === "check") return [constraint.kind, constraint.expression.text];
      const columns = constraint.columns.map(column => column.columnName);
      return constraint.kind === "foreignKey"
        ? [constraint.kind, columns, foreignTarget(constraint.target)]
        : [constraint.kind, columns];
    }),
    table.indexes.map(index => [
      index.name, index.columns.map(column => column.columnName), index.unique, index.where?.text ?? null,
    ]),
  ];
}

function operationShape(operation: TableMigration) {
  switch (operation.kind) {
    case "createTable": return [operation.kind, tableShape(operation.table)];
    case "addColumns": return [operation.kind, tableShape(operation.from), tableShape(operation.to), operation.columns];
    case "createIndexes": return [operation.kind, tableShape(operation.from), tableShape(operation.to), operation.names];
    case "deleteRows": return [operation.kind, operation.tableName, operation.where];
    case "dropTable": return [operation.kind, tableShape(operation.table)];
    case "rebuildTable": return [
      operation.kind, tableShape(operation.from), tableShape(operation.to),
      operation.copy.map(copy => [copy.targetColumn, copy.expression]),
    ];
  }
}

export function fingerprintSchemaReleases(schema: WorkbenchDatabaseSchema): readonly { version: number; fingerprint: string }[] {
  return readWorkbenchDatabaseSchemaHistory(schema).map(({ version, operations }) => ({
    version,
    // The positional format is fixed independently of SQL rendering and object property order.
    fingerprint: createHash("sha256").update(JSON.stringify([1, version, operations.map(operationShape)])).digest("hex"),
  }));
}

export function inspectSchemaReleases(schema: WorkbenchDatabaseSchema, releases: SchemaReleaseRegistry): readonly { name: string; version: number; fingerprint: string }[] {
  const registered = new Map<number, { name: string; fingerprint: string | null }>();
  for (const [name, release] of Object.entries(releases)) {
    if (!Number.isSafeInteger(release.version) || release.version < 1) throw new Error(`Invalid release version for ${name}`);
    if (registered.has(release.version)) throw new Error(`Duplicate release version ${release.version}`);
    if (release.version > schema.currentVersion) throw new Error(`Release ${name}@${release.version} has no declarations`);
    if (release.fingerprint !== null && !/^[0-9a-f]{64}$/.test(release.fingerprint)) {
      throw new Error(`Invalid release fingerprint for ${name}@${release.version}`);
    }
    if (release.fingerprint === null && release.version !== schema.currentVersion) {
      throw new Error(`Only the new final release may be unsealed; append a release instead of clearing ${name}@${release.version}`);
    }
    registered.set(release.version, { name, fingerprint: release.fingerprint });
  }
  const candidates: { name: string; version: number; fingerprint: string }[] = [];
  for (const actual of fingerprintSchemaReleases(schema)) {
    const release = registered.get(actual.version);
    if (!release) throw new Error(`Missing release registration for version ${actual.version}; append a named release`);
    if (release.fingerprint === null) {
      candidates.push({ name: release.name, ...actual });
    } else if (release.fingerprint !== actual.fingerprint) {
      throw new Error(`Sealed release ${release.name}@${actual.version} changed. Append a new release; do not reseal old history. No database repair is indicated.`);
    }
  }
  return candidates;
}

export function assertSchemaReleaseManifest(schema: WorkbenchDatabaseSchema, releases: SchemaReleaseRegistry, database: string): void {
  const candidates = inspectSchemaReleases(schema, releases);
  if (candidates.length) {
    const candidate = candidates[0]!;
    throw new Error(`Release ${candidate.name}@${candidate.version} is unsealed. Run node scripts/inspect-database-releases.mjs ${database}, then seal the new release before opening the database.`);
  }
}
