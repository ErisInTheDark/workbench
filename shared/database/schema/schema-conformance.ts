/*
 * DatabaseConformancePath/DatabaseConformanceIssue: bounded schema-derived browser repair and failure evidence. Keywords: database, schema, conformance.
 * DatabaseConformanceResult: successful conformed data or unrecoverable relational incompatibility. Keywords: database, schema, compatibility.
 * conformSelectedRow: conform one unknown selected row from its current table declaration. Keywords: database, schema, row, conformance.
 * conformSelectedRows: preserve valid selected rows while dropping rows owned by future enum identities. Keywords: database, schema, array, fallback, compatibility.
 */
import type { SelectRow, TableDefinition } from "./schema-definition.ts";

export type DatabaseConformancePath = readonly (number | string)[];

export interface DatabaseConformanceIssue {
  code: "invalidRow" | "invalidValue" | "missingRequired";
  path: DatabaseConformancePath;
}

export type DatabaseConformanceResult<Value> =
  | { data: Value; repairedPaths: DatabaseConformancePath[]; success: true }
  | { issues: DatabaseConformanceIssue[]; repairedPaths: DatabaseConformancePath[]; success: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidColumnValue(
  runtime: TableDefinition["columns"][string]["runtime"],
  value: unknown,
) {
  if (value === null) return !runtime.notNull;
  if (runtime.storageType === "TEXT") {
    if (typeof value !== "string") return false;
    if (runtime.enumValues && !runtime.enumValues.includes(value)) return false;
    if (runtime.jsonText) {
      try {
        JSON.parse(value);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (runtime.booleanInteger && value !== 0 && value !== 1) return false;
  return !runtime.nonNegative || value >= 0;
}

export function conformSelectedRow<Table extends TableDefinition>(
  table: Table,
  value: unknown,
  path: DatabaseConformancePath = [],
): DatabaseConformanceResult<SelectRow<Table>> {
  if (!isRecord(value)) {
    return { issues: [{ code: "invalidRow", path }], repairedPaths: [], success: false };
  }

  const repairedPaths: DatabaseConformancePath[] = [];
  const issues: DatabaseConformanceIssue[] = [];
  const row: Record<string, number | string | null> = {};

  for (const name of Object.keys(value)) {
    if (!(name in table.columns)) repairedPaths.push([...path, name]);
  }

  for (const [name, column] of Object.entries(table.columns)) {
    const columnPath = [...path, name];
    if (!(name in value)) {
      if (!column.runtime.notNull) {
        row[name] = null;
        repairedPaths.push(columnPath);
      } else if (column.runtime.defaultValue !== undefined) {
        row[name] = column.runtime.defaultValue;
        repairedPaths.push(columnPath);
      } else {
        issues.push({ code: "missingRequired", path: columnPath });
      }
      continue;
    }
    const candidate = value[name];
    if (!isValidColumnValue(column.runtime, candidate)) {
      issues.push({ code: "invalidValue", path: columnPath });
      continue;
    }
    row[name] = candidate as number | string | null;
  }

  if (issues.length) return { issues, repairedPaths, success: false };
  return { data: row as SelectRow<Table>, repairedPaths, success: true };
}

function isIdentityColumn(table: TableDefinition, columnName: string) {
  const column = table.columns[columnName];
  return Boolean(column?.runtime.primaryKey) || table.constraints.some((constraint) => (
    constraint.kind === "primaryKey"
    && constraint.columns.some((candidate) => candidate.columnName === columnName)
  ));
}

function hasFutureEnumIdentity(
  table: TableDefinition,
  value: unknown,
  path: DatabaseConformancePath,
  issues: readonly DatabaseConformanceIssue[],
) {
  if (!isRecord(value)) return false;
  return issues.some((issue) => {
    if (issue.code !== "invalidValue" || issue.path.length !== path.length + 1) return false;
    const columnName = issue.path[path.length];
    if (typeof columnName !== "string" || !isIdentityColumn(table, columnName)) return false;
    const enumValues = table.columns[columnName]?.runtime.enumValues;
    const candidate = value[columnName];
    return Boolean(enumValues && typeof candidate === "string" && !enumValues.includes(candidate));
  });
}

export function conformSelectedRows<Table extends TableDefinition>(
  table: Table,
  value: unknown,
  path: DatabaseConformancePath = [],
): DatabaseConformanceResult<SelectRow<Table>[]> {
  if (!Array.isArray(value)) {
    return { issues: [{ code: "invalidValue", path }], repairedPaths: [], success: false };
  }

  const data: SelectRow<Table>[] = [];
  const issues: DatabaseConformanceIssue[] = [];
  const repairedPaths: DatabaseConformancePath[] = [];
  value.forEach((candidate, index) => {
    const rowPath = [...path, index];
    const result = conformSelectedRow(table, candidate, rowPath);
    if ("data" in result) {
      data.push(result.data);
      repairedPaths.push(...result.repairedPaths);
      return;
    }
    if (hasFutureEnumIdentity(table, candidate, rowPath, result.issues)) {
      repairedPaths.push(rowPath);
      return;
    }
    repairedPaths.push(...result.repairedPaths);
    issues.push(...result.issues);
  });
  return issues.length
    ? { issues, repairedPaths, success: false }
    : { data, repairedPaths, success: true };
}
