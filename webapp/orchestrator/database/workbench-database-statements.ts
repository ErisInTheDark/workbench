/*
 * WorkbenchDatabaseValue/WorkbenchDatabaseRow: values carried across the database worker boundary. Keywords: database, statement, protocol.
 * WorkbenchDatabaseMutation: opaque mutation built from a current table descriptor. Keywords: database, statement, mutation.
 * WorkbenchDatabaseQuery: typed query built from a current table descriptor. Keywords: database, statement, query.
 * insertRow/upsertRow/updateRows/deleteRows/selectRows: build current-schema-only declarative statements. Keywords: database, statement, current schema.
 * compileWorkbenchDatabaseStatement: validate and compile one declarative statement inside the database worker. Keywords: database, statement, compiler.
 */
import type {
  CurrentTableDefinition,
  InsertRow,
  SelectRow,
  TableDefinition,
} from "../../lib/workbench/database/schema/schema-definition.ts";

export type WorkbenchDatabaseValue = string | number | null;
export type WorkbenchDatabaseRow = Record<string, WorkbenchDatabaseValue>;

type ColumnName<Table extends TableDefinition> = Extract<keyof Table["columns"], string>;
type RowFilter<Table extends TableDefinition> = Partial<SelectRow<Table>>;
type RowChanges<Table extends TableDefinition> = Partial<SelectRow<Table>>;
export type WorkbenchDatabaseRowInFilter<Table extends TableDefinition> = Partial<{
  [Key in ColumnName<Table>]: readonly Exclude<SelectRow<Table>[Key], null>[];
}>;
type Sort<Table extends TableDefinition> = Readonly<{
  column: ColumnName<Table>;
  direction?: "ASC" | "DESC";
}>;

interface SerializedStatement {
  readonly tableName: string;
}

export type WorkbenchDatabaseMutation =
  | (SerializedStatement & {
    readonly kind: "insert";
    readonly values: readonly (readonly [string, WorkbenchDatabaseValue])[];
  })
  | (SerializedStatement & {
    readonly kind: "upsert";
    readonly values: readonly (readonly [string, WorkbenchDatabaseValue])[];
    readonly conflictColumns: readonly string[];
    readonly updateColumns: readonly string[];
  })
  | (SerializedStatement & {
    readonly kind: "update";
    readonly changes: readonly (readonly [string, WorkbenchDatabaseValue])[];
    readonly where: readonly (readonly [string, WorkbenchDatabaseValue])[];
  })
  | (SerializedStatement & {
    readonly kind: "delete";
    readonly where: readonly (readonly [string, WorkbenchDatabaseValue])[];
  });

export type WorkbenchDatabaseQuery<Row extends WorkbenchDatabaseRow = WorkbenchDatabaseRow> =
  SerializedStatement & {
    readonly kind: "select";
    readonly where: readonly (readonly [string, WorkbenchDatabaseValue])[];
    readonly whereIn: readonly (readonly [string, readonly Exclude<WorkbenchDatabaseValue, null>[]])[];
    readonly orderBy: readonly Readonly<{ column: string; direction: "ASC" | "DESC" }>[];
    readonly limit?: number;
    readonly offset?: number;
    readonly __row?: Row;
  };

export interface CompiledWorkbenchDatabaseStatement {
  readonly sql: string;
  readonly parameters: readonly WorkbenchDatabaseValue[];
}

function entries(row: Record<string, WorkbenchDatabaseValue | undefined>) {
  return Object.entries(row).filter((entry): entry is [string, WorkbenchDatabaseValue] => entry[1] !== undefined);
}

function requireEntries(label: string, values: readonly (readonly [string, WorkbenchDatabaseValue])[]) {
  if (values.length === 0) throw new Error(`${label} requires at least one column`);
  return values;
}

export function insertRow<Table extends CurrentTableDefinition>(
  table: Table,
  row: InsertRow<Table>,
): WorkbenchDatabaseMutation {
  return {
    kind: "insert",
    tableName: table.name,
    values: requireEntries("Insert", entries(row)),
  };
}

export function upsertRow<
  Table extends CurrentTableDefinition,
  Conflict extends ColumnName<Table>,
  Update extends ColumnName<Table>,
>(
  table: Table,
  row: InsertRow<Table>,
  options: Readonly<{
    conflictColumns: readonly Conflict[];
    updateColumns: readonly Update[];
  }>,
): WorkbenchDatabaseMutation {
  if (options.conflictColumns.length === 0) throw new Error("Upsert requires at least one conflict column");
  if (options.updateColumns.length === 0) throw new Error("Upsert requires at least one update column");
  return {
    kind: "upsert",
    tableName: table.name,
    values: requireEntries("Upsert", entries(row)),
    conflictColumns: options.conflictColumns,
    updateColumns: options.updateColumns,
  };
}

export function updateRows<Table extends CurrentTableDefinition>(
  table: Table,
  changes: RowChanges<Table>,
  where: RowFilter<Table>,
): WorkbenchDatabaseMutation {
  return {
    kind: "update",
    tableName: table.name,
    changes: requireEntries("Update", entries(changes)),
    where: requireEntries("Update filter", entries(where)),
  };
}

export function deleteRows<Table extends CurrentTableDefinition>(
  table: Table,
  where: RowFilter<Table>,
): WorkbenchDatabaseMutation {
  return {
    kind: "delete",
    tableName: table.name,
    where: requireEntries("Delete filter", entries(where)),
  };
}

export function selectRows<Table extends CurrentTableDefinition>(
  table: Table,
  options: Readonly<{
    where?: RowFilter<Table>;
    whereIn?: WorkbenchDatabaseRowInFilter<Table>;
    orderBy?: readonly Sort<Table>[];
    limit?: number;
    offset?: number;
  }> = {},
): WorkbenchDatabaseQuery<SelectRow<Table>> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new Error("Select limit must be a non-negative integer");
  }
  if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
    throw new Error("Select offset must be a non-negative integer");
  }
  return {
    kind: "select",
    tableName: table.name,
    where: entries(options.where ?? {}),
    whereIn: Object.entries(options.whereIn ?? {}).map(([column, values]) => [
      column,
      values ?? [],
    ]),
    orderBy: (options.orderBy ?? []).map(({ column, direction = "ASC" }) => ({ column, direction })),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
  };
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function tableFor(
  tables: Readonly<Record<string, CurrentTableDefinition>>,
  statement: SerializedStatement,
) {
  const table = tables[statement.tableName];
  if (!table) throw new Error(`Unknown current database table: ${statement.tableName}`);
  return table;
}

function checkedColumns(
  table: CurrentTableDefinition,
  columns: readonly string[],
) {
  for (const column of columns) {
    if (!Object.hasOwn(table.columns, column)) {
      throw new Error(`Unknown column ${table.name}.${column}`);
    }
  }
  return columns;
}

function whereSql(
  table: CurrentTableDefinition,
  where: readonly (readonly [string, WorkbenchDatabaseValue])[],
  whereIn: readonly (readonly [string, readonly Exclude<WorkbenchDatabaseValue, null>[]])[],
  parameters: WorkbenchDatabaseValue[],
) {
  checkedColumns(table, where.map(([column]) => column));
  checkedColumns(table, whereIn.map(([column]) => column));
  const fragments = where.map(([column, value]) => {
    if (value === null) return `${quoteIdentifier(column)} IS NULL`;
    parameters.push(value);
    return `${quoteIdentifier(column)} = ?`;
  });
  for (const [column, values] of whereIn) {
    if (values.length === 0) {
      fragments.push("0 = 1");
      continue;
    }
    parameters.push(...values);
    fragments.push(`${quoteIdentifier(column)} IN (${values.map(() => "?").join(", ")})`);
  }
  if (fragments.length === 0) return "";
  return ` WHERE ${fragments.join(" AND ")}`;
}

export function compileWorkbenchDatabaseStatement(
  tables: Readonly<Record<string, CurrentTableDefinition>>,
  statement: WorkbenchDatabaseMutation | WorkbenchDatabaseQuery,
): CompiledWorkbenchDatabaseStatement {
  const table = tableFor(tables, statement);
  const tableName = quoteIdentifier(table.name);
  const parameters: WorkbenchDatabaseValue[] = [];

  if (statement.kind === "insert" || statement.kind === "upsert") {
    const columns = checkedColumns(table, statement.values.map(([column]) => column));
    parameters.push(...statement.values.map(([, value]) => value));
    const base = `INSERT INTO ${tableName} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    if (statement.kind === "insert") return { sql: base, parameters };
    checkedColumns(table, statement.conflictColumns);
    checkedColumns(table, statement.updateColumns);
    const updates = statement.updateColumns.map((column) => (
      `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`
    ));
    return {
      sql: `${base} ON CONFLICT (${statement.conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET ${updates.join(", ")}`,
      parameters,
    };
  }

  if (statement.kind === "update") {
    checkedColumns(table, statement.changes.map(([column]) => column));
    const changes = statement.changes.map(([column, value]) => {
      parameters.push(value);
      return `${quoteIdentifier(column)} = ?`;
    });
    return {
      sql: `UPDATE ${tableName} SET ${changes.join(", ")}${whereSql(table, statement.where, [], parameters)}`,
      parameters,
    };
  }

  if (statement.kind === "delete") {
    return {
      sql: `DELETE FROM ${tableName}${whereSql(table, statement.where, [], parameters)}`,
      parameters,
    };
  }

  checkedColumns(table, statement.orderBy.map(({ column }) => column));
  let sql = `SELECT * FROM ${tableName}${whereSql(table, statement.where, statement.whereIn, parameters)}`;
  if (statement.orderBy.length > 0) {
    sql += ` ORDER BY ${statement.orderBy.map(({ column, direction }) => `${quoteIdentifier(column)} ${direction}`).join(", ")}`;
  }
  if (statement.limit !== undefined) {
    sql += " LIMIT ?";
    parameters.push(statement.limit);
  } else if (statement.offset !== undefined) {
    sql += " LIMIT -1";
  }
  if (statement.offset !== undefined) {
    sql += " OFFSET ?";
    parameters.push(statement.offset);
  }
  return { sql, parameters };
}
