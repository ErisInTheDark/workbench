/*
 * Exports:
 * - readWorkbenchAppSettings/updateWorkbenchAppSettings: typed same-origin client for process-applied app settings.
 */
import {
  WORKBENCH_APP_SETTINGS_PATH,
  WorkbenchAppSettingsSnapshotSchema,
  type WorkbenchAppSettingsSnapshot,
} from "workbench-shared/http/workbench-app-settings";
import { z } from "zod";

import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

const ErrorResponseSchema = z.object({
  error: z.string().max(500),
}).passthrough();

async function responseError(response: Response) {
  const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : "The Workbench app settings request failed.";
}

function snapshotResponse(value: unknown) {
  const parsed = WorkbenchAppSettingsSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    reportClientSchemaError("Rejected Workbench app settings response", parsed.error);
    throw new Error("The Workbench app settings response was invalid.");
  }
  return parsed.data satisfies WorkbenchAppSettingsSnapshot;
}

export async function readWorkbenchAppSettings(
  fetcher: typeof fetch = fetch,
  rpc?: WorkbenchAppRpcClient,
): Promise<WorkbenchAppSettingsSnapshot | null> {
  if (rpc?.available) return snapshotResponse(await rpc.requestRaw({
    method: "app/settings/read", params: {},
  }));
  const response = await fetcher(WORKBENCH_APP_SETTINGS_PATH, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await responseError(response));
  return snapshotResponse(await response.json().catch(() => null));
}

export async function updateWorkbenchAppSettings(
  reactDevelopmentMode: boolean,
  fetcher: typeof fetch = fetch,
  rpc?: WorkbenchAppRpcClient,
): Promise<WorkbenchAppSettingsSnapshot> {
  if (rpc?.available) return snapshotResponse(await rpc.requestRaw({
    method: "app/settings/update", params: { reactDevelopmentMode },
  }));
  const response = await fetcher(WORKBENCH_APP_SETTINGS_PATH, {
    body: JSON.stringify({ reactDevelopmentMode }),
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) throw new Error(await responseError(response));
  return snapshotResponse(await response.json().catch(() => null));
}
