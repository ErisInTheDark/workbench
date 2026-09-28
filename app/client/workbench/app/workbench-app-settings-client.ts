/*
 * Exports:
 * - readWorkbenchAppSettings/updateWorkbenchAppSettings: typed same-origin client for process-applied app settings.
 */
import {
  WorkbenchAppSettingsSnapshotSchema,
  type WorkbenchAppSettingsSnapshot,
} from "workbench-shared/http/workbench-app-settings";

import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

function snapshotResponse(value: unknown) {
  const parsed = WorkbenchAppSettingsSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    reportClientSchemaError("Rejected Workbench app settings response", parsed.error);
    throw new Error("The Workbench app settings response was invalid.");
  }
  return parsed.data satisfies WorkbenchAppSettingsSnapshot;
}

export async function readWorkbenchAppSettings(
  rpc: WorkbenchAppRpcClient | null,
): Promise<WorkbenchAppSettingsSnapshot> {
  if (!rpc) throw new Error("App settings require the app connection.");
  return snapshotResponse(await rpc.requestRaw({
    method: "app/settings/read", params: {},
  }));
}

export async function updateWorkbenchAppSettings(
  reactDevelopmentMode: boolean,
  rpc: WorkbenchAppRpcClient | null,
): Promise<WorkbenchAppSettingsSnapshot> {
  if (!rpc) throw new Error("App settings require the app connection.");
  return snapshotResponse(await rpc.requestRaw({
    method: "app/settings/update", params: { reactDevelopmentMode },
  }));
}
