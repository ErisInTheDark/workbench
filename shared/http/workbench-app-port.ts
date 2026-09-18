/*
 * Exports:
 * - WORKBENCH_APP_PORT_PATH: same-origin HTTP route for reading and changing the foreground app listener port.
 * - WorkbenchAppPortSource/WorkbenchAppPortSnapshot: active listener state shared by the app server and browser settings UI.
 * - WorkbenchAppPortUpdateRequest: bounded port-change request contract.
 */

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
