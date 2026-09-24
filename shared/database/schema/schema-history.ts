/*
 * Exports:
 * - TableMigration/TableVersion/TableHistory: typed table migration history.
 * - SubsystemSchemaHistory/WorkbenchDatabaseSchema: assembled schema contracts.
 * - tableVersion/createTable/addColumns/createIndexes/rebuildTable/deleteRows/sqlData: migration declarations.
 * - copyDistinctValues: admit retained column values into a unique reference key before a rebuild.
 * - defineTableHistory/retireTableHistory/defineSubsystemHistory: table lifecycle declarations.
 * - defineWorkbenchDatabaseSchema: validate and assemble global schema history.
 * - readWorkbenchDatabaseMigrationRange/readWorkbenchDatabaseSchemaHistory: inspect migration state.
 * - applyWorkbenchDatabaseSchema: transactionally apply missing releases.
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
const subsystemHistoryData = new WeakMap<SubsystemSchemaHistory, readonly SchemaTableHistory[]>();
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

interface DeleteRowsMigration {
  readonly kind: "deleteRows";
  readonly tableName: string;
  readonly where: string;
}

interface SqlDataMigration {
  readonly kind: "sqlData";
  readonly statements: readonly string[];
}

interface CopyDistinctValuesMigration {
  readonly kind: "copyDistinctValues";
  readonly from: TableDefinition;
  readonly sourceColumn: string;
  readonly to: TableDefinition;
  readonly targetColumn: string;
}

interface DropTableMigration {
  readonly kind: "dropTable";
  readonly table: TableDefinition;
}

export type TableMigration =
  | CreateTableMigration | AddColumnsMigration | CreateIndexesMigration | RebuildTableMigration
  | DeleteRowsMigration | DropTableMigration | CopyDistinctValuesMigration | SqlDataMigration;

export interface TableVersion<Table extends TableDefinition = TableDefinition> {
  readonly schemaVersion: number;
  readonly table: Table;
  readonly migration: readonly TableMigration[];
}

export interface TableHistory<Current extends TableDefinition = TableDefinition> {
  readonly current: CurrentTableDefinition<Current>;
  readonly versions: readonly TableVersion[];
}

interface RetiredTableHistory {
  readonly current: null;
  readonly retirement: {
    readonly schemaVersion: number;
    readonly migration: DropTableMigration;
  };
  readonly versions: readonly TableVersion[];
}

type SchemaTableHistory = TableHistory | RetiredTableHistory;

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

export function copyDistinctValues<From extends TableDefinition, To extends TableDefinition>(input: {
  from: From;
  sourceColumn: keyof From["columns"] & string;
  to: To;
  targetColumn: keyof To["columns"] & string;
}): CopyDistinctValuesMigration {
  const source = input.from.columns[input.sourceColumn];
  const target = input.to.columns[input.targetColumn];
  if (!source || !target || source.runtime.storageType !== target.runtime.storageType) {
    throw new Error("Distinct-value copy requires compatible source and target columns");
  }
  if (!uniqueTargets(input.to).some(columns => sameNames(columns, [input.targetColumn]))) {
    throw new Error("Distinct-value copy requires a unique target column");
  }
  for (const [name, column] of Object.entries(input.to.columns)) {
    if (name !== input.targetColumn && column.runtime.notNull && !column.runtime.hasDefault) {
      throw new Error(`Distinct-value copy cannot supply required target column ${name}`);
    }
  }
  return Object.freeze({ kind: "copyDistinctValues", ...input });
}

export function deleteRows(tableName: string, where: SqlFragment<boolean>): DeleteRowsMigration {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error(`Invalid SQLite identifier: ${tableName}`);
  if (!where.text.trim()) throw new Error(`Row deletion for ${tableName} requires a predicate`);
  return Object.freeze({ kind: "deleteRows", tableName, where: where.text });
}

export function sqlData(statements: readonly string[]): SqlDataMigration {
  if (!statements.length || statements.some(statement => !statement.trim())) {
    throw new Error("SQL data migration requires non-empty statements");
  }
  return Object.freeze({ kind: "sqlData", statements: Object.freeze([...statements]) });
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
    if (operation.kind === "deleteRows" || operation.kind === "sqlData") continue;
    if (operation.kind === "copyDistinctValues") {
      if (operation.from !== previous) throw new Error("Distinct-value copy must read the preceding table version");
      continue;
    }
    if (operation.kind === "dropTable") throw new Error(`Table ${version.table.name} cannot retire inside a table version`);
    if (operation.from !== previous || operation.to !== version.table) {
      throw new Error(`Migration for ${version.table.name}@${version.schemaVersion} does not use its adjacent table versions`);
    }
  }
  const rebuild = operations.filter((operation) => operation.kind === "rebuildTable");
  if (rebuild.length > 0) {
    if (rebuild.length !== 1 || operations.at(-1) !== rebuild[0]
      || operations.some(operation => operation.kind !== "deleteRows" && operation.kind !== "copyDistinctValues"
        && operation.kind !== "sqlData" && operation.kind !== "rebuildTable")) {
      throw new Error(`Rebuild of ${version.table.name}@${version.schemaVersion} may accompany only row deletions and distinct-value copies`);
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

export function retireTableHistory(history: TableHistory, schemaVersion: number): RetiredTableHistory {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= history.versions.at(-1)!.schemaVersion) {
    throw new Error(`Table retirement for ${history.current.name} must follow its final schema version`);
  }
  return Object.freeze({
    current: null,
    retirement: Object.freeze({
      schemaVersion,
      migration: Object.freeze({ kind: "dropTable" as const, table: history.current }),
    }),
    versions: history.versions,
  });
}

export function defineSubsystemHistory(tableHistories: readonly SchemaTableHistory[]): SubsystemSchemaHistory {
  const names = new Set<string>();
  for (const history of tableHistories) {
    const name = history.current?.name ?? ("retirement" in history ? history.retirement.migration.table.name : "");
    if (names.has(name)) throw new Error(`Duplicate subsystem table history: ${name}`);
    names.add(name);
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
  if (operation.kind === "createTable") return operation.table;
  if (operation.kind === "addColumns" || operation.kind === "createIndexes" || operation.kind === "rebuildTable") {
    return operation.to;
  }
  return null;
}

export function defineWorkbenchDatabaseSchema(input: {
  subsystems: readonly SubsystemSchemaHistory[];
}): WorkbenchDatabaseSchema {
  const subsystemHistories = input.subsystems.map((subsystem) => {
    const histories = subsystemHistoryData.get(subsystem);
    if (!histories) throw new Error("Unknown subsystem schema history token");
    return histories;
  });
  const currentTables = subsystemHistories.flatMap((histories) =>
    histories.flatMap((history) => history.current ? [history.current] : []));
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
      if ("retirement" in history) {
        const operations = mutableVersions.get(history.retirement.schemaVersion) ?? [];
        operations.push(history.retirement.migration);
        mutableVersions.set(history.retirement.schemaVersion, operations);
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
      if (operation.kind === "copyDistinctValues") {
        const target = historicalTables.get(operation.to.name);
        if (!target || !sameTableDefinition(target, operation.to)) {
          throw new Error(`Distinct-value copy target ${operation.to.name} must already exist at schema ${schemaVersion}`);
        }
      }
      const target = migrationTarget(operation);
      if (target) historicalTables.set(target.name, target);
      else if (operation.kind === "dropTable") historicalTables.delete(operation.table.name);
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
  if (operation.kind === "sqlData") {
    for (const statement of operation.statements) database.exec(statement);
    return;
  }
  if (operation.kind === "copyDistinctValues") {
    const source = quoteIdentifier(operation.sourceColumn);
    const target = quoteIdentifier(operation.targetColumn);
    database.exec(`INSERT INTO ${quoteIdentifier(operation.to.name)} (${target})
      SELECT DISTINCT ${source} FROM ${quoteIdentifier(operation.from.name)}
      WHERE ${source} IS NOT NULL ON CONFLICT (${target}) DO NOTHING;`);
    return;
  }
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
  if (operation.kind === "deleteRows") {
    database.exec(`DELETE FROM ${quoteIdentifier(operation.tableName)} WHERE ${operation.where};`);
    return;
  }
  if (operation.kind === "dropTable") {
    database.exec(`DROP TABLE ${quoteIdentifier(operation.table.name)};`);
    return;
  }
  executeRebuild(database, operation, schemaVersion);
}

export function readWorkbenchDatabaseMigrationRange(
  database: Database.Database,
  schema: WorkbenchDatabaseSchema,
  { targetVersion = schema.currentVersion }: { targetVersion?: number } = {},
) {
  if (!databaseSchemaVersionData.has(schema)) throw new Error("Unknown Workbench database schema token");
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > schema.currentVersion) {
    throw new Error(`Invalid Workbench database schema target: ${targetVersion}`);
  }
  const installedVersion = database.pragma("user_version", { simple: true }) as number;
  if (installedVersion > schema.currentVersion) {
    throw new Error(`Workbench database schema ${installedVersion} is newer than supported schema ${schema.currentVersion}`);
  }
  if (installedVersion > targetVersion) {
    throw new Error(`Workbench database schema ${installedVersion} is newer than target schema ${targetVersion}`);
  }
  return { installedVersion, targetVersion };
}

export function readWorkbenchDatabaseSchemaHistory(schema: WorkbenchDatabaseSchema) {
  const versions = databaseSchemaVersionData.get(schema);
  if (!versions) throw new Error("Unknown Workbench database schema token");
  return Object.freeze([...versions]
    .sort(([left], [right]) => left - right)
    .map(([version, operations]) => Object.freeze({ version, operations })));
}

export function applyWorkbenchDatabaseSchema(
  database: Database.Database,
  schema: WorkbenchDatabaseSchema,
  options: { targetVersion?: number } = {},
) {
  const { installedVersion, targetVersion } = readWorkbenchDatabaseMigrationRange(database, schema, options);
  const versions = databaseSchemaVersionData.get(schema)!;
  for (let schemaVersion = installedVersion + 1; schemaVersion <= targetVersion; schemaVersion += 1) {
    const operations = versions.get(schemaVersion)!;
    const changesTableStructure = operations.some((operation) => operation.kind === "rebuildTable" || operation.kind === "dropTable");
    const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (changesTableStructure && foreignKeysEnabled) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        for (const operation of operations) executeMigration(database, operation, schemaVersion);
        if (changesTableStructure) {
          const failures = database.pragma("foreign_key_check") as unknown[];
          if (failures.length > 0) throw new Error(`Foreign-key check failed after schema version ${schemaVersion}`);
        }
        database.pragma(`user_version = ${schemaVersion}`);
      })();
    } finally {
      if (changesTableStructure && foreignKeysEnabled) database.pragma("foreign_keys = ON");
    }
  }
}
