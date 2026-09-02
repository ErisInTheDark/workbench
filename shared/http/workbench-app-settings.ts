/*
 * Exports:
 * - WORKBENCH_APP_SETTINGS_PATH: same-origin route for app-wide settings that apply at process boot.
 * - WorkbenchAppSettingsSnapshot/WorkbenchAppSettingsUpdateRequest: requested and process-applied React mode contract.
 */

export const WORKBENCH_APP_SETTINGS_PATH = "/api/workbench-app-settings";

export interface WorkbenchAppSettingsSnapshot {
  appliedReactDevelopmentMode: boolean;
  requestedReactDevelopmentMode: boolean;
}

export interface WorkbenchAppSettingsUpdateRequest {
  reactDevelopmentMode: boolean;
}
