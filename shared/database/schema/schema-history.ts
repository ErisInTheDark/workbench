/*
 * TableVersion: one immutable table shape and the explicit migration that produces it. Keywords: database, schema, version.
 * TableHistory: private table versions plus the only current branded export. Keywords: database, schema, history.
 * SubsystemSchemaHistory: ordered table histories owned by one schema subsystem. Keywords: database, schema, subsystem.
 * WorkbenchDatabaseSchema: assembled current tables and executable global history. Keywords: database, schema, migration.
 * tableVersion: declare one table version. Keywords: database, schema, version.
 * createTable: declare initial STRICT table creation. Keywords: database, schema, migration.
 * addColumns: declare a compatible SQLite column addition. Keywords: database, schema, migration.
 * createIndexes: declare compatible index additions. Keywords: database, schema, migration.
 * rebuildTable: declare a transactional table replacement. Keywords: database, schema, migration.
 * defineTableHistory: validate private versions and brand only the final table. Keywords: database, schema, history.
 * defineSubsystemHistory: combine table histories under one owner. Keywords: database, schema, subsystem.
 * defineWorkbenchDatabaseSchema: assemble and validate all subsystem histories. Keywords: database, schema, assembly.
 * applyWorkbenchDatabaseSchema: apply missing global schema versions transactionally. Keywords: database, schema, migration.
 */
import type Database from "better-sqlite3";

import {
  publishCurrentTable,
  renderAddColumn,
  renderCreateIndexes,
  renderCreateTable,
  sameColumnDefinition,
  sameTableConstraints,
  sameTableDefinition,
  tableColumns,
  tableForeignKeys,
  type ColumnReferences,
  type CurrentTableDefinition,
  type SelectRow,
  type SqlFragment,
  type TableDefinition,
  type TableIndex,
} from "./schema-definition.ts";
import { sql } from "./schema-definition.ts";

const SUBSYSTEM_HISTORY = Symbol("workbench-subsystem-schema-history");
const DATABASE_SCHEMA = Symbol("workbench-database-schema");
const subsystemHistoryData = new WeakMap<SubsystemSchemaHistory, readonly TableHistory[]>();
const databaseSchemaVersionData = new WeakMap<WorkbenchDatabaseSchema, ReadonlyMap<number, readonly TableMigration[]>>();

interface CreateTableMigration {
  readonly kind: "createTable";
  readonly table: TableDefinition;
}

interface AddColumnsMigration {
  readonly kind: "addColumns";
  readonly from: TableDefinition;
  readonly to: TableDefinition;
  readonly columns: readonly string[];
}

interface CreateIndexesMigration {
  readonly kind: "createIndexes";
  readonly from: TableDefinition;
  readonly to: TableDefinition;
  readonly names: readonly string[];
}

interface RebuildCopy {
  readonly targetColumn: string;
  readonly expression: string;
}

interface RebuildTableMigration {
  readonly kind: "rebuildTable";
  readonly from: TableDefinition;
  readonly to: TableDefinition;
  readonly copy: readonly RebuildCopy[];
}

type TableMigration = CreateTableMigration | AddColumnsMigration | CreateIndexesMigration | RebuildTableMigration;

export interface TableVersion<Table extends TableDefinition = TableDefinition> {
  readonly schemaVersion: number;
  readonly table: Table;
  readonly migration: readonly TableMigration[];
}

export interface TableHistory<Current extends TableDefinition = TableDefinition> {
  readonly current: CurrentTableDefinition<Current>;
  readonly versions: readonly TableVersion[];
}

export interface SubsystemSchemaHistory {
  readonly [SUBSYSTEM_HISTORY]: true;
}

export interface WorkbenchDatabaseSchema {
  readonly [DATABASE_SCHEMA]: true;
  readonly currentVersion: number;
  readonly currentTables: readonly CurrentTableDefinition[];
}

function migrations(value: TableMigration | readonly TableMigration[]) {
  return Object.freeze(Array.isArray(value) ? [...value] : [value]);
}

export function tableVersion<const Table extends TableDefinition>(input: {
  schemaVersion: number;
  table: Table;
  migration: TableMigration | readonly TableMigration[];
}): TableVersion<Table> {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new Error(`Invalid schema version: ${input.schemaVersion}`);
  }
  return Object.freeze({ ...input, migration: migrations(input.migration) });
}

export function createTable<Table extends TableDefinition>(table: Table): CreateTableMigration {
  return Object.freeze({ kind: "createTable", table });
}

function assertSameTable(from: TableDefinition, to: TableDefinition) {
  if (from.name !== to.name) throw new Error(`Schema transition changes table name from ${from.name} to ${to.name}`);
}

export function addColumns<From extends TableDefinition, To extends TableDefinition>(input: {
  from: From;
  to: To;
  columns: readonly (keyof To["columns"] & string)[];
}): AddColumnsMigration {
  assertSameTable(input.from, input.to);
  return Object.freeze({
    kind: "addColumns",
    from: input.from,
    to: input.to,
    columns: Object.freeze([...input.columns]),
  });
}

export function createIndexes<From extends TableDefinition, To extends TableDefinition>(input: {
  from: From;
  to: To;
  names: readonly string[];
}): CreateIndexesMigration {
  assertSameTable(input.from, input.to);
  return Object.freeze({
    kind: "createIndexes",
    from: input.from,
    to: input.to,
    names: Object.freeze([...input.names]),
  });
}

type RebuildMap<To extends TableDefinition> = Partial<{
  [Key in keyof To["columns"]]: SqlFragment<SelectRow<To>[Key]>;
}>;

export function rebuildTable<From extends TableDefinition, To extends TableDefinition>(input: {
  from: From;
  to: To;
  map?: (context: {
    from: ColumnReferences<From["columns"]>;
    expression: Pick<typeof sql, "integer" | "text">;
  }) => RebuildMap<To>;
}): RebuildTableMigration {
  assertSameTable(input.from, input.to);
  const sourceColumns = tableColumns(input.from);
  const explicitMap: RebuildMap<To> = input.map?.({ from: sourceColumns, expression: sql }) ?? {};
  const copy: RebuildCopy[] = [];
  for (const [targetColumn, targetDefinition] of Object.entries(input.to.columns)) {
    const explicit = explicitMap[targetColumn];
    if (explicit) {
      for (const reference of explicit.referencedColumns) {
        if (sourceColumns[reference.columnName as keyof typeof sourceColumns] !== reference) {
          throw new Error(`Rebuild of ${input.to.name} maps ${targetColumn} from another table version`);
        }
      }
      copy.push({ targetColumn, expression: explicit.text });
      continue;
    }
    const sourceDefinition = input.from.columns[targetColumn];
    if (sourceDefinition && sourceDefinition.runtime.storageType === targetDefinition.runtime.storageType) {
      copy.push({ targetColumn, expression: quoteIdentifier(targetColumn) });
      continue;
    }
    if (!targetDefinition.runtime.notNull || targetDefinition.runtime.hasDefault) continue;
    throw new Error(`Rebuild of ${input.to.name} requires a mapping for ${targetColumn}`);
  }
  for (const targetColumn of Object.keys(explicitMap)) {
    if (!input.to.columns[targetColumn]) throw new Error(`Rebuild maps unknown target column ${input.to.name}.${targetColumn}`);
  }
  return Object.freeze({
    kind: "rebuildTable",
    from: input.from,
    to: input.to,
    copy: Object.freeze(copy.map((entry) => Object.freeze(entry))),
  });
}

function sameNames(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sorted(values: Iterable<string>) {
  return [...values].sort();
}

function sameIndex(left: TableIndex, right: TableIndex) {
  return left.name === right.name
    && left.unique === right.unique
    && sameNames(left.columns.map(({ columnName }) => columnName), right.columns.map(({ columnName }) => columnName))
    && left.where?.text === right.where?.text;
}

function validateCreateVersion(version: TableVersion) {
  if (version.migration.length !== 1 || version.migration[0].kind !== "createTable") {
    throw new Error(`Initial table version ${version.table.name}@${version.schemaVersion} must contain one createTable migration`);
  }
  if (version.migration[0].table !== version.table) {
    throw new Error(`Initial migration does not create ${version.table.name}@${version.schemaVersion}`);
  }
}

function validateTransition(previous: TableDefinition, version: TableVersion) {
  const operations = version.migration;
  for (const operation of operations) {
    if (operation.kind === "createTable") throw new Error(`Existing table ${version.table.name} cannot use createTable again`);
    if (operation.from !== previous || operation.to !== version.table) {
      throw new Error(`Migration for ${version.table.name}@${version.schemaVersion} does not use its adjacent table versions`);
    }
  }
  const rebuild = operations.filter((operation) => operation.kind === "rebuildTable");
  if (rebuild.length > 0) {
    if (operations.length !== 1 || rebuild.length !== 1) {
      throw new Error(`Rebuild of ${version.table.name}@${version.schemaVersion} must be the only table migration`);
    }
    return;
  }

  const previousNames = new Set(Object.keys(previous.columns));
  const nextNames = new Set(Object.keys(version.table.columns));
  const added = sorted([...nextNames].filter((name) => !previousNames.has(name)));
  const removed = sorted([...previousNames].filter((name) => !nextNames.has(name)));
  const changed = sorted([...previousNames].filter((name) => {
    const next = version.table.columns[name];
    return next && !sameColumnDefinition(previous.columns[name], next);
  }));
  const declaredAdded = sorted(operations.flatMap((operation) => operation.kind === "addColumns" ? [...operation.columns] : []));
  if (removed.length > 0 || changed.length > 0 || !sameNames(added, declaredAdded)) {
    throw new Error(`Migration for ${version.table.name}@${version.schemaVersion} does not explain its column changes`);
  }
  if (!sameTableConstraints(previous, version.table)) {
    throw new Error(`Migration for ${version.table.name}@${version.schemaVersion} changes constraints without rebuilding`);
  }
  for (const columnName of declaredAdded) {
    const column = version.table.columns[columnName];
    if (column.runtime.primaryKey || column.runtime.unique || column.runtime.autoincrement) {
      throw new Error(`Column ${version.table.name}.${columnName} requires a rebuild`);
    }
    if (column.runtime.notNull && !column.runtime.hasDefault) {
      throw new Error(`Required column ${version.table.name}.${columnName} requires a rebuild mapping`);
    }
  }

  const previousIndexes = new Map(previous.indexes.map((tableIndex) => [tableIndex.name, tableIndex]));
  const nextIndexes = new Map(version.table.indexes.map((tableIndex) => [tableIndex.name, tableIndex]));
  const removedIndexes = [...previousIndexes].filter(([name, tableIndex]) => {
    const next = nextIndexes.get(name);
    return !next || !sameIndex(tableIndex, next);
  }).map(([name]) => name);
  const addedIndexes = sorted([...nextIndexes].filter(([name]) => !previousIndexes.has(name)).map(([name]) => name));
  const declaredIndexes = sorted(operations.flatMap((operation) => operation.kind === "createIndexes" ? [...operation.names] : []));
  if (removedIndexes.length > 0 || !sameNames(addedIndexes, declaredIndexes)) {
    throw new Error(`Migration for ${version.table.name}@${version.schemaVersion} does not explain its index changes`);
  }
}

export function defineTableHistory<const Current extends TableDefinition>(input: {
  versions: readonly TableVersion[];
  current: Current;
}): TableHistory<Current> {
  if (input.versions.length === 0) throw new Error(`Table ${input.current.name} has no schema versions`);
  input.versions.forEach((version, index) => {
    if (version.table.name !== input.current.name) throw new Error(`Table history mixes ${input.current.name} and ${version.table.name}`);
    if (index > 0 && version.schemaVersion <= input.versions[index - 1].schemaVersion) {
      throw new Error(`Table ${input.current.name} schema versions must increase`);
    }
  });
  if (input.versions.at(-1)!.table !== input.current) {
    throw new Error(`Current table ${input.current.name} is not the final registered table version`);
  }
  validateCreateVersion(input.versions[0]);
  for (let index = 1; index < input.versions.length; index += 1) {
    validateTransition(input.versions[index - 1].table, input.versions[index]);
  }
  return Object.freeze({
    current: publishCurrentTable(input.current),
    versions: Object.freeze([...input.versions]),
  });
}

export function defineSubsystemHistory(tableHistories: readonly TableHistory[]): SubsystemSchemaHistory {
  const names = new Set<string>();
  for (const history of tableHistories) {
    if (names.has(history.current.name)) throw new Error(`Duplicate subsystem table history: ${history.current.name}`);
    names.add(history.current.name);
  }
  const history = Object.freeze({ [SUBSYSTEM_HISTORY]: true as const });
  subsystemHistoryData.set(history, Object.freeze([...tableHistories]));
  return history;
}

function uniqueTargets(table: TableDefinition) {
  const targets: string[][] = [];
  for (const [name, column] of Object.entries(table.columns)) {
    if (column.runtime.primaryKey || column.runtime.unique) targets.push([name]);
  }
  for (const constraint of table.constraints) {
    if (constraint.kind === "primaryKey" || constraint.kind === "unique") {
      targets.push(constraint.columns.map(({ columnName }) => columnName));
    }
  }
  return targets;
}

function validateForeignKeys(tables: ReadonlyMap<string, TableDefinition>, schemaVersion: number) {
  for (const table of tables.values()) {
    for (const foreignKey of tableForeignKeys(table)) {
      const target = tables.get(foreignKey.target.table);
      if (!target) throw new Error(`Schema ${schemaVersion} misses foreign table ${foreignKey.target.table}`);
      for (const column of foreignKey.target.columns) {
        if (!target.columns[column]) throw new Error(`Schema ${schemaVersion} misses foreign column ${target.name}.${column}`);
      }
      if (!uniqueTargets(target).some((columns) => sameNames(columns, foreignKey.target.columns))) {
        throw new Error(`Schema ${schemaVersion} foreign target is not unique: ${target.name}(${foreignKey.target.columns.join(",")})`);
      }
    }
  }
}

function migrationTarget(operation: TableMigration) {
  return operation.kind === "createTable" ? operation.table : operation.to;
}

export function defineWorkbenchDatabaseSchema(input: {
  subsystems: readonly SubsystemSchemaHistory[];
}): WorkbenchDatabaseSchema {
  const subsystemHistories = input.subsystems.map((subsystem) => {
    const histories = subsystemHistoryData.get(subsystem);
    if (!histories) throw new Error("Unknown subsystem schema history token");
    return histories;
  });
  const currentTables = subsystemHistories.flatMap((histories) => histories.map((history) => history.current));
  const currentNames = new Set<string>();
  for (const table of currentTables) {
    if (currentNames.has(table.name)) throw new Error(`Duplicate current table: ${table.name}`);
    currentNames.add(table.name);
  }

  const mutableVersions = new Map<number, TableMigration[]>();
  for (const histories of subsystemHistories) {
    for (const history of histories) {
      for (const version of history.versions) {
        const operations = mutableVersions.get(version.schemaVersion) ?? [];
        operations.push(...version.migration);
        mutableVersions.set(version.schemaVersion, operations);
      }
    }
  }
  if (mutableVersions.size === 0) throw new Error("Workbench database schema must declare at least one table version");
  const currentVersion = Math.max(...mutableVersions.keys());
  for (let schemaVersion = 1; schemaVersion <= currentVersion; schemaVersion += 1) {
    if (!mutableVersions.has(schemaVersion)) throw new Error(`Global schema history skips version ${schemaVersion}`);
  }

  const historicalTables = new Map<string, TableDefinition>();
  for (let schemaVersion = 1; schemaVersion <= currentVersion; schemaVersion += 1) {
    for (const operation of mutableVersions.get(schemaVersion)!) {
      const target = migrationTarget(operation);
      historicalTables.set(target.name, target);
    }
    validateForeignKeys(historicalTables, schemaVersion);
  }
  for (const current of currentTables) {
    const historical = historicalTables.get(current.name);
    if (!historical || !sameTableDefinition(current, historical)) {
      throw new Error(`Current table ${current.name} does not match its final history version`);
    }
  }
  if (historicalTables.size !== currentTables.length) throw new Error("Current table inventory does not match schema history");

  const schema = Object.freeze({
    [DATABASE_SCHEMA]: true as const,
    currentVersion,
    currentTables: Object.freeze(currentTables),
  });
  databaseSchemaVersionData.set(
    schema,
    new Map([...mutableVersions].map(([version, operations]) => [version, Object.freeze([...operations])])),
  );
  return schema;
}

function quoteIdentifier(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Invalid SQLite identifier: ${identifier}`);
  return `"${identifier}"`;
}

function executeRebuild(database: Database.Database, operation: RebuildTableMigration, schemaVersion: number) {
  const temporaryName = `__workbench_migrate_${schemaVersion}_${operation.to.name}`;
  database.exec(renderCreateTable(operation.to, { name: temporaryName, ifNotExists: false }));
  if (operation.copy.length > 0) {
    const targets = operation.copy.map(({ targetColumn }) => quoteIdentifier(targetColumn)).join(", ");
    const expressions = operation.copy.map(({ expression }) => expression).join(", ");
    database.exec(`INSERT INTO ${quoteIdentifier(temporaryName)} (${targets}) SELECT ${expressions} FROM ${quoteIdentifier(operation.from.name)};`);
  }
  database.exec(`DROP TABLE ${quoteIdentifier(operation.from.name)};`);
  database.exec(`ALTER TABLE ${quoteIdentifier(temporaryName)} RENAME TO ${quoteIdentifier(operation.to.name)};`);
  for (const statement of renderCreateIndexes(operation.to)) database.exec(statement);
}

function executeMigration(database: Database.Database, operation: TableMigration, schemaVersion: number) {
  if (operation.kind === "createTable") {
    database.exec(renderCreateTable(operation.table));
    for (const statement of renderCreateIndexes(operation.table)) database.exec(statement);
    return;
  }
  if (operation.kind === "addColumns") {
    for (const column of operation.columns) database.exec(renderAddColumn(operation.to, column));
    return;
  }
  if (operation.kind === "createIndexes") {
    const names = new Set(operation.names);
    for (const statement of renderCreateIndexes({
      ...operation.to,
      indexes: operation.to.indexes.filter((tableIndex) => names.has(tableIndex.name)),
    })) database.exec(statement);
    return;
  }
  executeRebuild(database, operation, schemaVersion);
}

export function applyWorkbenchDatabaseSchema(database: Database.Database, schema: WorkbenchDatabaseSchema) {
  const versions = databaseSchemaVersionData.get(schema);
  if (!versions) throw new Error("Unknown Workbench database schema token");
  const installedVersion = database.pragma("user_version", { simple: true }) as number;
  if (installedVersion > schema.currentVersion) {
    throw new Error(`Workbench database schema ${installedVersion} is newer than supported schema ${schema.currentVersion}`);
  }
  for (let schemaVersion = installedVersion + 1; schemaVersion <= schema.currentVersion; schemaVersion += 1) {
    const operations = versions.get(schemaVersion)!;
    const needsRebuild = operations.some((operation) => operation.kind === "rebuildTable");
    const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (needsRebuild && foreignKeysEnabled) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        for (const operation of operations) executeMigration(database, operation, schemaVersion);
        if (needsRebuild) {
          const failures = database.pragma("foreign_key_check") as unknown[];
          if (failures.length > 0) throw new Error(`Foreign-key check failed after schema version ${schemaVersion}`);
        }
        database.pragma(`user_version = ${schemaVersion}`);
      })();
    } finally {
      if (needsRebuild && foreignKeysEnabled) database.pragma("foreign_keys = ON");
    }
  }
}
