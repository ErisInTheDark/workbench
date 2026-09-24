/*
 * Exports:
 * - conformWorkbenchClientStateResponse: repair compatible app/browser schema skew from the browser's current table declarations. Keywords: app, browser, SQLite, conformance.
 */
import { appStateClientTables } from "workbench-shared/state/workbench-app-state-schema";
import {
  conformSelectedRows,
  type DatabaseConformanceIssue,
  type DatabaseConformancePath,
  type DatabaseConformanceResult,
} from "workbench-shared/database/schema/schema-conformance";
import type {
  WorkbenchClientStateResponse,
  WorkbenchClientStateRows,
} from "workbench-shared/state/workbench-client-state";
import { WorkbenchDaemonRegistrationSchema } from "workbench-shared/state/workbench-client-state";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidValue(path: DatabaseConformancePath): DatabaseConformanceIssue {
  return { code: "invalidValue", path };
}

export function conformWorkbenchClientStateResponse(
  value: unknown,
): DatabaseConformanceResult<WorkbenchClientStateResponse> {
  if (!isRecord(value)) {
    return { issues: [{ code: "invalidRow", path: [] }], repairedPaths: [], success: false };
  }

  const repairedPaths: DatabaseConformancePath[] = [];
  const issues: DatabaseConformanceIssue[] = [];
  const knownRootKeys = new Set([
    "daemonRegistrationId",
    "kind",
    "oldestAvailableRevision",
    "revision",
    "rows",
    "registrations",
    "schemaVersion",
  ]);
  for (const key of Object.keys(value)) {
    if (!knownRootKeys.has(key)) repairedPaths.push([key]);
  }

  const kind = value.kind;
  if (kind !== "delta" && kind !== "snapshot") issues.push(invalidValue(["kind"]));
  if (typeof value.daemonRegistrationId !== "string" || !value.daemonRegistrationId) {
    issues.push(invalidValue(["daemonRegistrationId"]));
  }
  const revision = value.revision;
  const oldestAvailableRevision = value.oldestAvailableRevision;
  const schemaVersion = value.schemaVersion ?? 0;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    issues.push(invalidValue(["revision"]));
  }
  if (
    !Number.isSafeInteger(oldestAvailableRevision)
    || (oldestAvailableRevision as number) < 0
    || (Number.isSafeInteger(revision) && (oldestAvailableRevision as number) > (revision as number))
  ) {
    issues.push(invalidValue(["oldestAvailableRevision"]));
  }
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 0) {
    issues.push(invalidValue(["schemaVersion"]));
  } else if (!Object.hasOwn(value, "schemaVersion")) {
    repairedPaths.push(["schemaVersion"]);
  }
  const registrations = value.registrations === undefined
    ? null : z.array(WorkbenchDaemonRegistrationSchema).safeParse(value.registrations);
  if (registrations && !registrations.success) {
    reportClientSchemaError("Rejected Workbench daemon registrations", registrations.error);
    issues.push(invalidValue(["registrations"]));
  }

  const rowsValue = isRecord(value.rows) ? value.rows : {};
  if (!isRecord(value.rows)) issues.push(invalidValue(["rows"]));
  for (const key of Object.keys(rowsValue)) {
    if (!(key in appStateClientTables)) repairedPaths.push(["rows", key]);
  }

  const rows: Partial<WorkbenchClientStateRows> = {};
  for (const [name, table] of Object.entries(appStateClientTables)) {
    if (!(name in rowsValue)) {
      rows[name as keyof WorkbenchClientStateRows] = [];
      repairedPaths.push(["rows", name]);
      continue;
    }
    const result = conformSelectedRows(table, rowsValue[name], ["rows", name]);
    repairedPaths.push(...result.repairedPaths);
    if ("data" in result) rows[name as keyof WorkbenchClientStateRows] = result.data as never;
    else issues.push(...result.issues);
  }

  if (issues.length) return { issues, repairedPaths, success: false };
  return {
    data: {
      daemonRegistrationId: value.daemonRegistrationId as string,
      kind: kind as "delta" | "snapshot",
      oldestAvailableRevision: oldestAvailableRevision as number,
      revision: revision as number,
      rows: rows as WorkbenchClientStateRows,
      ...(registrations?.success ? { registrations: registrations.data } : {}),
      schemaVersion: schemaVersion as number,
    },
    repairedPaths,
    success: true,
  };
}
