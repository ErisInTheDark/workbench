/*
 * Exports:
 * - WORKBENCH_APP_SETTINGS_PATH: same-origin route for app-wide settings that apply at process boot.
 * - WorkbenchAppSettingsSnapshot/WorkbenchAppSettingsUpdateRequest: requested and process-applied React mode, plus the app's source repository, contract.
 * - WorkbenchAppSettingsSnapshotSchema/WorkbenchAppSettingsUpdateRequestSchema: validated JSON boundary.
 */
import { z } from "zod";

export const WORKBENCH_APP_SETTINGS_PATH = "/api/workbench-app-settings";

export interface WorkbenchAppSettingsSnapshot {
  appliedReactDevelopmentMode: boolean;
  requestedReactDevelopmentMode: boolean;
  /** Repository the app compiles its frontend from; development tooling settings show only for that project. */
  sourceRootPath?: string;
}

export interface WorkbenchAppSettingsUpdateRequest {
  reactDevelopmentMode: boolean;
}

export const WorkbenchAppSettingsSnapshotSchema = z.object({
  appliedReactDevelopmentMode: z.boolean(),
  requestedReactDevelopmentMode: z.boolean(),
  // Optional so new browser code still accepts an app process from before this field.
  sourceRootPath: z.string().min(1).max(4096).optional(),
}).strict();
export const WorkbenchAppSettingsUpdateRequestSchema = z.object({
  reactDevelopmentMode: z.boolean(),
}).strict();
