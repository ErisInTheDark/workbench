/*
 * Exports:
 * - WorkbenchAppPortClientSnapshot: server snapshot plus old-process compatibility state for the browser.
 * - readWorkbenchAppPort/updateWorkbenchAppPort: typed same-origin app-port HTTP client.
 * - createWorkbenchAppPortRedirectUrl: replace the origin, preserve the browser route, and optionally transfer browser state identity.
 */
import {
  WORKBENCH_APP_PORT_PATH,
  type WorkbenchAppPortSnapshot,
} from "workbench-shared/http/workbench-app-port";
import { z } from "zod";

import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER } from "../state/workbench-browser-state-identity";

const WorkbenchAppPortSnapshotSchema = z.object({
  appOrigin: z.string().url().refine((value) => {
    const origin = new URL(value);
    return origin.protocol === "http:" && origin.hostname === "127.0.0.1" && Boolean(origin.port) && origin.origin === value;
  }, "Expected a bound loopback HTTP origin."),
  currentPort: z.number().int().min(1).max(65_535),
  editable: z.boolean(),
  source: z.enum(["environment", "random", "setting"]),
}).strict().superRefine((value, context) => {
  if (Number(new URL(value.appOrigin).port) !== value.currentPort) {
    context.addIssue({
      code: "custom",
      message: "Origin port must match currentPort.",
      path: ["appOrigin"],
    });
  }
});

const ErrorResponseSchema = z.object({
  error: z.string().max(500),
}).passthrough();

export type WorkbenchAppPortClientSnapshot =
  | WorkbenchAppPortSnapshot
  | {
    appOrigin: string;
    currentPort: number;
    editable: false;
    source: "unavailable";
  };

function currentOriginSnapshot(currentHref: string): WorkbenchAppPortClientSnapshot {
  const current = new URL(currentHref);
  const currentPort = Number(current.port);
  return {
    appOrigin: current.origin,
    currentPort: Number.isSafeInteger(currentPort) && currentPort > 0 ? currentPort : 80,
    editable: false,
    source: "unavailable",
  };
}

async function responseError(response: Response) {
  const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error : "The Workbench app port request failed.";
}

async function snapshotResponse(response: Response) {
  const parsed = WorkbenchAppPortSnapshotSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    reportClientSchemaError("Rejected Workbench app port response", parsed.error);
    throw new Error("The Workbench app port response was invalid.");
  }
  return parsed.data satisfies WorkbenchAppPortSnapshot;
}

export async function readWorkbenchAppPort(
  fetcher: typeof fetch = fetch,
  currentHref: string = window.location.href,
): Promise<WorkbenchAppPortClientSnapshot> {
  const response = await fetcher(WORKBENCH_APP_PORT_PATH, { cache: "no-store" });
  if (response.status === 404) return currentOriginSnapshot(currentHref);
  if (!response.ok) throw new Error(await responseError(response));
  return await snapshotResponse(response);
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
  return await snapshotResponse(response);
}

export function createWorkbenchAppPortRedirectUrl(
  currentHref: string,
  appOrigin: string,
  browserStateId?: string,
) {
  const current = new URL(currentHref);
  const destination = new URL(appOrigin);
  current.protocol = destination.protocol;
  current.host = destination.host;
  if (browserStateId) current.searchParams.set(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER, browserStateId);
  return current.toString();
}
