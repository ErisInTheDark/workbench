/*
 * Exports:
 * - WorkbenchAppPortClientSnapshot: app listener and handoff capabilities.
 * - readWorkbenchAppPort/updateWorkbenchAppPort: app RPC reads and connection-changing HTTP updates.
 * - createWorkbenchAppPortRedirectUrl: retain stable network origins or follow listener ports without losing browser route/state.
 */
import {
  WORKBENCH_APP_PORT_PATH,
  WorkbenchAppPortSnapshotSchema,
  type WorkbenchAppPortSnapshot,
} from "workbench-shared/http/workbench-app-port";
import { z } from "zod";

import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER } from "../state/workbench-browser-state-identity";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

const ErrorResponseSchema = z.object({
  error: z.string().max(500),
}).passthrough();

export type WorkbenchAppPortClientSnapshot = WorkbenchAppPortSnapshot;

async function responseError(response: Response) {
  const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : "The Workbench app port request failed.";
}

function snapshotResponse(value: unknown) {
  const parsed = WorkbenchAppPortSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    reportClientSchemaError("Rejected Workbench app port response", parsed.error);
    throw new Error("The Workbench app port response was invalid.");
  }
  return parsed.data satisfies WorkbenchAppPortSnapshot;
}

export async function readWorkbenchAppPort(
  rpc: WorkbenchAppRpcClient | null,
): Promise<WorkbenchAppPortClientSnapshot> {
  if (!rpc) throw new Error("App listener settings require the app connection.");
  return snapshotResponse(await rpc.requestRaw({
    method: "app/port/read", params: {},
  }));
}

export async function updateWorkbenchAppPort(
  port: number,
  fetcher: typeof fetch = fetch,
): Promise<WorkbenchAppPortSnapshot> {
  const response = await fetcher(WORKBENCH_APP_PORT_PATH, {
    body: JSON.stringify({ port }),
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) throw new Error(await responseError(response));
  return snapshotResponse(await response.json().catch(() => null));
}

export function createWorkbenchAppPortRedirectUrl(
  currentHref: string,
  appOrigin: string,
  browserStateId?: string,
  stableOrigin?: string | null,
) {
  const current = new URL(currentHref);
  if (stableOrigin && stableOrigin !== current.origin) throw new Error("Stable network origin differs from this browser's origin.");
  const destination = new URL(appOrigin);
  if (!stableOrigin) current.port = destination.port;
  if (browserStateId) current.searchParams.set(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER, browserStateId);
  return current.toString();
}
