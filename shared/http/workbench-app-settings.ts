/*
 * Exports:
 * - WORKBENCH_APP_SETTINGS_PATH: same-origin route for app-wide settings that apply at process boot.
 * - WorkbenchAppSettingsSnapshot/WorkbenchAppSettingsUpdateRequest: requested and process-applied React mode contract.
 * - WorkbenchAppSettingsSnapshotSchema/WorkbenchAppSettingsUpdateRequestSchema: validated JSON boundary.
 */
import { z } from "zod";

export const WORKBENCH_APP_SETTINGS_PATH = "/api/workbench-app-settings";

export interface WorkbenchAppSettingsSnapshot {
  appliedReactDevelopmentMode: boolean;
  requestedReactDevelopmentMode: boolean;
}

export interface WorkbenchAppSettingsUpdateRequest {
  reactDevelopmentMode: boolean;
}

export const WorkbenchAppSettingsSnapshotSchema = z.object({
  appliedReactDevelopmentMode: z.boolean(),
  requestedReactDevelopmentMode: z.boolean(),
}).strict();
export const WorkbenchAppSettingsUpdateRequestSchema = z.object({
  reactDevelopmentMode: z.boolean(),
}).strict();
