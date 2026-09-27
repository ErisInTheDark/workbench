/*
 * Exports:
 * - WORKBENCH_APP_PORT_PATH: same-origin HTTP route for reading and changing the foreground app listener port.
 * - WorkbenchAppPortSource/WorkbenchAppPortSnapshot: active listener state shared by the app server and browser settings UI.
 * - WorkbenchAppPortUpdateRequest: bounded port-change request contract.
 * - WorkbenchAppPortSnapshotSchema/WorkbenchAppPortUpdateRequestSchema: validated JSON boundary.
 */
import { z } from "zod";

export const WORKBENCH_APP_PORT_PATH = "/api/workbench-app-port";

export type WorkbenchAppPortSource = "environment" | "random" | "setting";

export interface WorkbenchAppPortSnapshot {
  appOrigin: string;
  currentPort: number;
  editable: boolean;
  source: WorkbenchAppPortSource;
  stableOrigin?: string | null;
}

export interface WorkbenchAppPortUpdateRequest {
  port: number;
}

export const WorkbenchAppPortSnapshotSchema = z.object({
  appOrigin: z.string().url().refine((value) => {
    const origin = new URL(value);
    return origin.protocol === "http:" && origin.hostname === "127.0.0.1"
      && Boolean(origin.port) && origin.origin === value;
  }, "Expected a bound loopback HTTP origin."),
  currentPort: z.number().int().min(1).max(65_535),
  editable: z.boolean(),
  source: z.enum(["environment", "random", "setting"]),
  stableOrigin: z.url().refine(value => new URL(value).origin === value
    && ["http:", "https:"].includes(new URL(value).protocol)).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (Number(new URL(value.appOrigin).port) !== value.currentPort) {
    context.addIssue({
      code: "custom",
      message: "Origin port must match currentPort.",
      path: ["appOrigin"],
    });
  }
});
export const WorkbenchAppPortUpdateRequestSchema = z.object({
  port: z.number().int().min(1).max(65_535),
}).strict();
