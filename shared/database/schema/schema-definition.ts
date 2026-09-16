/*
 * ColumnDefinition: immutable SQLite column declaration carrying storage and insert types. Keywords: database, schema, column.
 * ColumnMap: immutable named column declarations. Keywords: database, schema, columns.
 * ColumnReference: identifier-aware reference to one declared column. Keywords: database, schema, column.
 * ColumnReferences: typed column references for one table. Keywords: database, schema, columns.
 * ForeignTarget: logical foreign table and column target. Keywords: database, schema, foreign-key.
 * TableConstraint: supported table-level constraint union. Keywords: database, schema, constraint.
 * TableIndex: supported current index declaration. Keywords: database, schema, index.
 * TableDefinition: immutable unversioned SQLite table declaration. Keywords: database, schema, table.
 * CurrentTableDefinition: table declaration admitted by production statement owners. Keywords: database, schema, current.
 * SelectRow: selected SQLite row inferred from one table declaration. Keywords: database, schema, types.
 * InsertRow: inserted SQLite row inferred from one table declaration. Keywords: database, schema, types.
 * SqlFragment: identifier-aware schema SQL fragment. Keywords: database, schema, sql.
 * text: declare a SQLite TEXT column. Keywords: database, schema, column.
 * blob: declare binary SQLite storage without JSON or text conversion.
 * integer: declare a SQLite INTEGER column. Keywords: database, schema, column.
 * booleanInteger: declare a constrained SQLite boolean integer column. Keywords: database, schema, column.
 * enumText: declare a constrained SQLite text enum column. Keywords: database, schema, column.
 * jsonText: declare an opaque JSON text column. Keywords: database, schema, column.
 * defineTable: declare one typed STRICT table. Keywords: database, schema, table.
 * evolveTable: derive one immutable table version from its previous version. Keywords: database, schema, version.
 * check: declare a table CHECK constraint. Keywords: database, schema, constraint.
 * unique: declare a table UNIQUE constraint. Keywords: database, schema, constraint.
 * primaryKey: declare a composite table primary key. Keywords: database, schema, constraint.
 * foreignKey: declare a composite foreign key. Keywords: database, schema, constraint.
 * index: declare an ordinary or partial table index. Keywords: database, schema, index.
 * literal: declare a schema-owned SQL literal. Keywords: database, schema, sql.
 * sql: compose identifier-aware schema SQL. Keywords: database, schema, sql.
 * renderCreateTable: render one STRICT table declaration. Keywords: database, schema, sql.
 * renderCreateIndexes: render a table's indexes. Keywords: database, schema, index.
 * renderAddColumn: render one ALTER TABLE ADD COLUMN statement. Keywords: database, schema, migration.
 * tableColumns: get typed immutable column references for a table. Keywords: database, schema, columns.
 * tableForeignKeys: list logical foreign-key targets owned by a table. Keywords: database, schema, foreign-key.
 * sameColumnDefinition: compare explicit column semantics. Keywords: database, schema, equality.
 * sameTableDefinition: compare explicit table semantics. Keywords: database, schema, equality.
 * sameTableConstraints: compare explicit table constraint semantics. Keywords: database, schema, equality.
 * sameTableIndexes: compare explicit table index semantics. Keywords: database, schema, equality.
 * publishCurrentTable: brand a validated table for production statement owners. Keywords: database, schema, current.
 */

const CURRENT_TABLE = Symbol("workbench-current-table");
const TABLE_COLUMNS = Symbol("workbench-table-columns");
const SQL_FRAGMENT = Symbol("workbench-schema-sql");
const SQL_LITERAL = Symbol("workbench-schema-literal");
const SQL_EXPRESSION_VALUE = Symbol("workbench-schema-expression-value");

type StorageValue = string | number | Uint8Array;
type OnDeleteAction = "CASCADE" | "RESTRICT" | "SET NULL";

interface ColumnRuntime {
  storageType: "INTEGER" | "TEXT" | "BLOB";
  notNull: boolean;
  hasDefault: boolean;
  defaultValue?: string | number;
  primaryKey: boolean;
  autoincrement: boolean;
  unique: boolean;
  reference?: ForeignTarget;
  enumValues?: readonly string[];
  booleanInteger: boolean;
  jsonText: boolean;
  nonNegative: boolean;
}

export class ColumnDefinition<Value extends StorageValue, NotNull extends boolean = false, HasDefault extends boolean = false> {
  declare readonly __value: Value;
  declare readonly __notNull: NotNull;
  declare readonly __hasDefault: HasDefault;

  readonly runtime: Readonly<ColumnRuntime>;

  constructor(runtime: ColumnRuntime) {
    this.runtime = Object.freeze({
      ...runtime,
      enumValues: runtime.enumValues ? Object.freeze([...runtime.enumValues]) : undefined,
      reference: runtime.reference ? Object.freeze({ ...runtime.reference, columns: Object.freeze([...runtime.reference.columns]) }) : undefined,
    });
  }

  notNull() {
    return this.#copy<Value, true, HasDefault>({ notNull: true });
  }

  default(value: Value & (string | number)) {
    return this.#copy<Value, NotNull, true>({ hasDefault: true, defaultValue: value });
  }

  primaryKey<const AutoIncrement extends boolean = false>(options?: { autoincrement?: AutoIncrement }) {
    const autoincrement = options?.autoincrement ?? false;
    if (autoincrement && this.runtime.storageType !== "INTEGER") {
      throw new Error("AUTOINCREMENT requires an INTEGER primary key");
    }
    return this.#copy<Value, true, HasDefault extends true ? true : AutoIncrement>({
      primaryKey: true,
      notNull: true,
      autoincrement,
      hasDefault: this.runtime.hasDefault || autoincrement,
    });
  }

  unique() {
    return this.#copy<Value, NotNull, HasDefault>({ unique: true });
  }

  references(table: string, column: string, options?: { onDelete?: OnDeleteAction }) {
    return this.#copy<Value, NotNull, HasDefault>({
      reference: { table, columns: [column], onDelete: options?.onDelete },
    });
  }

  nonNegative() {
    if (this.runtime.storageType !== "INTEGER") throw new Error("nonNegative requires an INTEGER column");
    return this.#copy<Value, NotNull, HasDefault>({ nonNegative: true });
  }

  #copy<NextValue extends StorageValue, NextNotNull extends boolean, NextHasDefault extends boolean>(
    changes: Partial<ColumnRuntime>,
  ) {
    return new ColumnDefinition<NextValue, NextNotNull, NextHasDefault>({ ...this.runtime, ...changes });
  }
}

type AnyColumn = ColumnDefinition<StorageValue, boolean, boolean>;
export type ColumnMap = Readonly<Record<string, AnyColumn>>;
type ColumnValue<Column extends AnyColumn> = Column extends ColumnDefinition<infer Value, infer NotNull, boolean>
  ? NotNull extends true ? Value : Value | null
  : never;
type RequiredInsertKeys<Columns extends ColumnMap> = {
  [Key in keyof Columns]: Columns[Key] extends ColumnDefinition<StorageValue, true, false> ? Key : never;
}[keyof Columns];
type OptionalInsertKeys<Columns extends ColumnMap> = Exclude<keyof Columns, RequiredInsertKeys<Columns>>;

export type SelectRow<Table extends { columns: ColumnMap }> = {
  [Key in keyof Table["columns"]]: ColumnValue<Table["columns"][Key]>;
};

export type InsertRow<Table extends { columns: ColumnMap }> = {
  [Key in RequiredInsertKeys<Table["columns"]>]: ColumnValue<Table["columns"][Key]>;
} & {
  [Key in OptionalInsertKeys<Table["columns"]>]?: ColumnValue<Table["columns"][Key]>;
};

export interface ColumnReference<Value = StorageValue | null> {
  readonly kind: "column";
  readonly tableName: string;
  readonly columnName: string;
  readonly [SQL_EXPRESSION_VALUE]?: Value;
}

export type ColumnReferences<Columns extends ColumnMap> = {
  readonly [Key in keyof Columns]: ColumnReference<ColumnValue<Columns[Key]>>;
};

export interface ForeignTarget {
  table: string;
  columns: readonly string[];
  onDelete?: OnDeleteAction;
}

export type TableConstraint =
  | { kind: "check"; expression: SqlFragment }
  | { kind: "foreignKey"; columns: readonly ColumnReference[]; target: ForeignTarget }
  | { kind: "primaryKey"; columns: readonly ColumnReference[] }
  | { kind: "unique"; columns: readonly ColumnReference[] };

export interface TableIndex {
  readonly name: string;
  readonly columns: readonly ColumnReference[];
  readonly unique: boolean;
  readonly where?: SqlFragment;
}

interface TableExtras {
  constraints?: readonly TableConstraint[];
  indexes?: readonly TableIndex[];
}

export interface TableDefinition<Name extends string = string, Columns extends ColumnMap = ColumnMap> {
  readonly kind: "table";
  readonly name: Name;
  readonly columns: Columns;
  readonly constraints: readonly TableConstraint[];
  readonly indexes: readonly TableIndex[];
  readonly [TABLE_COLUMNS]: ColumnReferences<Columns>;
}

export type CurrentTableDefinition<Table extends TableDefinition = TableDefinition> = Table & {
  readonly [CURRENT_TABLE]: true;
};

export interface SqlFragment<Value = never> {
  readonly [SQL_FRAGMENT]: true;
  readonly text: string;
  readonly referencedColumns: readonly ColumnReference[];
  readonly [SQL_EXPRESSION_VALUE]?: Value;
}

interface SchemaLiteral {
  readonly [SQL_LITERAL]: true;
  readonly value: string | number | null;
}

function baseColumn(storageType: ColumnRuntime["storageType"]) {
  return {
    storageType,
    notNull: false,
    hasDefault: false,
    primaryKey: false,
    autoincrement: false,
    unique: false,
    booleanInteger: false,
    jsonText: false,
    nonNegative: false,
  } satisfies ColumnRuntime;
}

export function text() {
  return new ColumnDefinition<string>(baseColumn("TEXT"));
}

export function blob() {
  return new ColumnDefinition<Uint8Array>(baseColumn("BLOB"));
}

export function integer() {
  return new ColumnDefinition<number>(baseColumn("INTEGER"));
}

export function booleanInteger() {
  return new ColumnDefinition<0 | 1>({ ...baseColumn("INTEGER"), booleanInteger: true });
}

export function enumText<const Values extends readonly [string, ...string[]]>(...values: Values) {
  return new ColumnDefinition<Values[number]>({ ...baseColumn("TEXT"), enumValues: values });
}

export function jsonText() {
  return new ColumnDefinition<string>({ ...baseColumn("TEXT"), jsonText: true });
}

function assertIdentifier(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Invalid SQLite identifier: ${identifier}`);
}

function columnName(reference: ColumnReference) {
  return reference.columnName;
}

function createColumnReferences<Columns extends ColumnMap>(tableName: string, columns: Columns) {
  return Object.freeze(Object.fromEntries(Object.keys(columns).map((name) => [name, Object.freeze({
    kind: "column" as const,
    tableName,
    columnName: name,
  })]))) as ColumnReferences<Columns>;
}

export function tableColumns<Table extends TableDefinition>(table: Table) {
  return table[TABLE_COLUMNS] as ColumnReferences<Table["columns"]>;
}

export function tableForeignKeys(table: TableDefinition) {
  const columnForeignKeys = Object.entries(table.columns).flatMap(([name, column]) => column.runtime.reference
    ? [{ columns: [name] as readonly string[], target: column.runtime.reference }]
    : []);
  const tableForeignKeys = table.constraints.flatMap((constraint) => constraint.kind === "foreignKey"
    ? [{ columns: constraint.columns.map(columnName), target: constraint.target }]
    : []);
  return [...columnForeignKeys, ...tableForeignKeys];
}

export function defineTable<const Name extends string, const Columns extends ColumnMap>(
  name: Name,
  columns: Columns,
  extras?: (table: ColumnReferences<Columns>) => TableExtras,
) {
  assertIdentifier(name);
  const columnNames = Object.keys(columns);
  if (columnNames.length === 0) throw new Error(`Table ${name} must declare at least one column`);
  for (const column of columnNames) assertIdentifier(column);
  const references = createColumnReferences(name, columns);
  const resolvedExtras = extras?.(references) ?? {};
  const assertLocalColumns = (ownedReferences: readonly ColumnReference[], owner: string) => {
    if (ownedReferences.length === 0) throw new Error(`Table ${name} ${owner} must reference at least one column`);
    const seen = new Set<string>();
    for (const reference of ownedReferences) {
      if (references[reference.columnName] !== reference) {
        throw new Error(`Table ${name} ${owner} references a column owned by another table version`);
      }
      if (seen.has(reference.columnName)) throw new Error(`Table ${name} ${owner} repeats column ${reference.columnName}`);
      seen.add(reference.columnName);
    }
  };
  const assertFragmentColumns = (fragment?: SqlFragment) => {
    for (const reference of fragment?.referencedColumns ?? []) {
      if (references[reference.columnName] !== reference) {
        throw new Error(`Table ${name} SQL references a column owned by another table version`);
      }
    }
  };
  for (const constraint of resolvedExtras.constraints ?? []) {
    if (constraint.kind === "check") assertFragmentColumns(constraint.expression);
    else assertLocalColumns(constraint.columns, constraint.kind);
  }
  for (const tableIndex of resolvedExtras.indexes ?? []) {
    assertLocalColumns(tableIndex.columns, `index ${tableIndex.name}`);
    assertFragmentColumns(tableIndex.where);
  }
  return Object.freeze({
    kind: "table" as const,
    name,
    columns: Object.freeze({ ...columns }),
    constraints: Object.freeze([...(resolvedExtras.constraints ?? [])]),
    indexes: Object.freeze([...(resolvedExtras.indexes ?? [])]),
    [TABLE_COLUMNS]: references,
  }) satisfies TableDefinition<Name, Columns>;
}

type EvolvedColumns<Previous extends ColumnMap, Added extends ColumnMap, Dropped extends keyof Previous> = {
  [Key in Exclude<keyof Previous, Dropped> | keyof Added]: Key extends keyof Added
    ? Added[Key]
    : Key extends keyof Previous ? Previous[Key] : never;
};

export function evolveTable<
  const Name extends string,
  const Previous extends ColumnMap,
  const Added extends ColumnMap = Record<never, never>,
  const Dropped extends keyof Previous = never,
>(
  previous: TableDefinition<Name, Previous>,
  change: {
    add?: Added;
    drop?: readonly Dropped[];
    extras?: (table: ColumnReferences<EvolvedColumns<Previous, Added, Dropped>>) => TableExtras;
  },
) {
  const dropped = new Set<string>((change.drop ?? []).map(String));
  const columns = Object.fromEntries([
    ...Object.entries(previous.columns).filter(([name]) => !dropped.has(name)),
    ...Object.entries(change.add ?? {}),
  ]) as EvolvedColumns<Previous, Added, Dropped>;
  if (Object.keys(columns).length !== Object.keys(previous.columns).length - dropped.size + Object.keys(change.add ?? {}).length) {
    throw new Error(`Table ${previous.name} evolution contains duplicate added columns`);
  }
  return defineTable(previous.name, columns, change.extras ?? ((table) => {
    const reference = (column: ColumnReference) => {
      const nextReference = table[column.columnName as keyof typeof table];
      if (!nextReference) throw new Error(`Table ${previous.name} evolution preserves a missing column ${column.columnName}`);
      return nextReference;
    };
    const fragment = (value: SqlFragment) => Object.freeze({
      ...value,
      referencedColumns: Object.freeze(value.referencedColumns.map(reference)),
    });
    return {
      constraints: previous.constraints.map((constraint) => {
        if (constraint.kind === "check") return check(fragment(constraint.expression));
        if (constraint.kind === "foreignKey") {
          return foreignKey(constraint.columns.map(reference), constraint.target);
        }
        if (constraint.kind === "primaryKey") return primaryKey(constraint.columns.map(reference));
        return unique(constraint.columns.map(reference));
      }),
      indexes: previous.indexes.map((tableIndex) => index(
        tableIndex.name,
        tableIndex.columns.map(reference),
        { unique: tableIndex.unique, where: tableIndex.where ? fragment(tableIndex.where) : undefined },
      )),
    };
  }));
}

export function check(expression: SqlFragment): TableConstraint {
  return Object.freeze({ kind: "check", expression });
}

export function unique(columns: readonly ColumnReference[]): TableConstraint {
  return Object.freeze({ kind: "unique", columns: Object.freeze([...columns]) });
}

export function primaryKey(columns: readonly ColumnReference[]): TableConstraint {
  return Object.freeze({ kind: "primaryKey", columns: Object.freeze([...columns]) });
}

export function foreignKey(
  columns: readonly ColumnReference[],
  target: { table: string; columns: readonly string[]; onDelete?: OnDeleteAction },
): TableConstraint {
  assertIdentifier(target.table);
  for (const column of target.columns) assertIdentifier(column);
  if (columns.length === 0) throw new Error("Foreign keys must reference at least one column");
  if (columns.length !== target.columns.length) throw new Error("Foreign key column counts must match");
  if (new Set(target.columns).size !== target.columns.length) throw new Error("Foreign key target columns must be unique");
  return Object.freeze({
    kind: "foreignKey",
    columns: Object.freeze([...columns]),
    target: Object.freeze({ ...target, columns: Object.freeze([...target.columns]) }),
  });
}

export function index(
  name: string,
  columns: readonly ColumnReference[],
  options?: { unique?: boolean; where?: SqlFragment },
): TableIndex {
  assertIdentifier(name);
  return Object.freeze({
    name,
    columns: Object.freeze([...columns]),
    unique: options?.unique ?? false,
    where: options?.where,
  });
}

export function literal(value: string | number | null): SchemaLiteral {
  return Object.freeze({ [SQL_LITERAL]: true as const, value });
}

function quoteIdentifier(identifier: string) {
  assertIdentifier(identifier);
  return `"${identifier}"`;
}

function renderLiteral(value: string | number | null) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`SQLite schema literal must be a safe integer: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

type SqlInterpolation = ColumnReference | SchemaLiteral | SqlFragment;

function composeSql<Value>(strings: TemplateStringsArray, values: readonly SqlInterpolation[]): SqlFragment<Value> {
  let text = strings[0];
  const referencedColumns: ColumnReference[] = [];
  values.forEach((value, index) => {
    if (SQL_LITERAL in value) text += renderLiteral(value.value);
    else if (SQL_FRAGMENT in value) {
      text += value.text;
      referencedColumns.push(...value.referencedColumns);
    } else if (value.kind === "column") {
      text += quoteIdentifier(value.columnName);
      referencedColumns.push(value);
    }
    else throw new Error("Unsupported schema SQL interpolation");
    text += strings[index + 1];
  });
  return Object.freeze({ [SQL_FRAGMENT]: true as const, text, referencedColumns: Object.freeze(referencedColumns) });
}

function schemaSql(strings: TemplateStringsArray, ...values: SqlInterpolation[]) {
  return composeSql<never>(strings, values);
}

export const sql = Object.assign(schemaSql, {
  text: (strings: TemplateStringsArray, ...values: SqlInterpolation[]) => composeSql<string>(strings, values),
  integer: (strings: TemplateStringsArray, ...values: SqlInterpolation[]) => composeSql<number>(strings, values),
});

function renderReference(target: ForeignTarget) {
  const columns = target.columns.map(quoteIdentifier).join(", ");
  return `REFERENCES ${quoteIdentifier(target.table)} (${columns})${target.onDelete ? ` ON DELETE ${target.onDelete}` : ""}`;
}

function renderColumn(name: string, column: AnyColumn) {
  const runtime = column.runtime;
  const parts = [quoteIdentifier(name), runtime.storageType];
  if (runtime.notNull) parts.push("NOT NULL");
  if (runtime.primaryKey) parts.push("PRIMARY KEY");
  if (runtime.autoincrement) parts.push("AUTOINCREMENT");
  if (runtime.unique) parts.push("UNIQUE");
  if (runtime.defaultValue !== undefined) parts.push("DEFAULT", renderLiteral(runtime.defaultValue));
  if (runtime.reference) parts.push(renderReference(runtime.reference));
  if (runtime.booleanInteger) parts.push(`CHECK (${quoteIdentifier(name)} IN (0, 1))`);
  if (runtime.enumValues) parts.push(`CHECK (${quoteIdentifier(name)} IN (${runtime.enumValues.map(renderLiteral).join(", ")}))`);
  if (runtime.jsonText) {
    const valid = `json_valid(${quoteIdentifier(name)})`;
    parts.push(`CHECK (${runtime.notNull ? valid : `${quoteIdentifier(name)} IS NULL OR ${valid}`})`);
  }
  if (runtime.nonNegative) {
    const check = `${quoteIdentifier(name)} >= 0`;
    parts.push(`CHECK (${runtime.notNull ? check : `${quoteIdentifier(name)} IS NULL OR ${check}`})`);
  }
  return parts.join(" ");
}

function renderConstraint(constraint: TableConstraint) {
  if (constraint.kind === "check") return `CHECK (${constraint.expression.text})`;
  if (constraint.kind === "primaryKey") return `PRIMARY KEY (${constraint.columns.map(columnName).map(quoteIdentifier).join(", ")})`;
  if (constraint.kind === "unique") return `UNIQUE (${constraint.columns.map(columnName).map(quoteIdentifier).join(", ")})`;
  return `FOREIGN KEY (${constraint.columns.map(columnName).map(quoteIdentifier).join(", ")}) ${renderReference(constraint.target)}`;
}

export function renderCreateTable(table: TableDefinition, options?: { name?: string; ifNotExists?: boolean }) {
  const name = options?.name ?? table.name;
  const ifNotExists = options?.ifNotExists ?? true;
  const entries = [
    ...Object.entries(table.columns).map(([columnName, column]) => renderColumn(columnName, column)),
    ...table.constraints.map(renderConstraint),
  ];
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(name)} (\n  ${entries.join(",\n  ")}\n) STRICT;`;
}

export function renderCreateIndexes(table: TableDefinition, options?: { tableName?: string; ifNotExists?: boolean }) {
  const tableName = options?.tableName ?? table.name;
  const ifNotExists = options?.ifNotExists ?? true;
  return table.indexes.map((tableIndex) => {
    const uniqueSql = tableIndex.unique ? "UNIQUE " : "";
    const whereSql = tableIndex.where ? ` WHERE ${tableIndex.where.text}` : "";
    return `CREATE ${uniqueSql}INDEX ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(tableIndex.name)} ON ${quoteIdentifier(tableName)} (${tableIndex.columns.map(columnName).map(quoteIdentifier).join(", ")})${whereSql};`;
  });
}

export function renderAddColumn(table: TableDefinition, column: string) {
  const definition = table.columns[column];
  if (!definition) throw new Error(`Unknown column ${table.name}.${column}`);
  return `ALTER TABLE ${quoteIdentifier(table.name)} ADD COLUMN ${renderColumn(column, definition)};`;
}

function sameForeignTarget(left?: ForeignTarget, right?: ForeignTarget) {
  if (!left || !right) return left === right;
  return left.table === right.table
    && left.onDelete === right.onDelete
    && left.columns.length === right.columns.length
    && left.columns.every((column, index) => column === right.columns[index]);
}

export function sameColumnDefinition(left: AnyColumn, right: AnyColumn) {
  const a = left.runtime;
  const b = right.runtime;
  return a.storageType === b.storageType
    && a.notNull === b.notNull
    && a.hasDefault === b.hasDefault
    && a.defaultValue === b.defaultValue
    && a.primaryKey === b.primaryKey
    && a.autoincrement === b.autoincrement
    && a.unique === b.unique
    && sameForeignTarget(a.reference, b.reference)
    && a.booleanInteger === b.booleanInteger
    && a.jsonText === b.jsonText
    && a.nonNegative === b.nonNegative
    && (a.enumValues?.length ?? 0) === (b.enumValues?.length ?? 0)
    && (a.enumValues ?? []).every((value, index) => value === b.enumValues?.[index]);
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReferenceList(left: readonly ColumnReference[], right: readonly ColumnReference[]) {
  return sameStringList(left.map(columnName), right.map(columnName));
}

function sameConstraint(left: TableConstraint, right: TableConstraint) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "check" && right.kind === "check") return left.expression.text === right.expression.text;
  if (left.kind === "foreignKey" && right.kind === "foreignKey") {
    return sameReferenceList(left.columns, right.columns) && sameForeignTarget(left.target, right.target);
  }
  return "columns" in left && "columns" in right && sameReferenceList(left.columns, right.columns);
}

export function sameTableConstraints(left: TableDefinition, right: TableDefinition) {
  return left.constraints.length === right.constraints.length
    && left.constraints.every((constraint, index) => sameConstraint(constraint, right.constraints[index]));
}

export function sameTableIndexes(left: TableDefinition, right: TableDefinition) {
  return left.indexes.length === right.indexes.length
    && left.indexes.every((tableIndex, index) => {
      const other = right.indexes[index];
      return tableIndex.name === other?.name
        && tableIndex.unique === other.unique
        && sameReferenceList(tableIndex.columns, other.columns)
        && tableIndex.where?.text === other.where?.text;
    });
}

export function sameTableDefinition(left: TableDefinition, right: TableDefinition) {
  const leftColumns = Object.keys(left.columns);
  const rightColumns = Object.keys(right.columns);
  return left.name === right.name
    && sameStringList(leftColumns, rightColumns)
    && leftColumns.every((name) => sameColumnDefinition(left.columns[name], right.columns[name]))
    && sameTableConstraints(left, right)
    && sameTableIndexes(left, right);
}

export function publishCurrentTable<Table extends TableDefinition>(table: Table): CurrentTableDefinition<Table> {
  return Object.freeze({ ...table, [CURRENT_TABLE]: true }) as CurrentTableDefinition<Table>;
}
