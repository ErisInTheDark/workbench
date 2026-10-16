/*
 * Exports:
 * - useWorkbenchSettingsEditor: read, write and reset global or logical-project preferences, including schema availability.
 */
"use client";

import { useMemo } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import {
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  readGlobalWorkbenchSettings,
  readLogicalProjectWorkbenchSettings,
  writeGlobalWorkbenchSetting,
  writeLogicalProjectWorkbenchSetting,
  type WorkbenchGlobalSettings,
  type WorkbenchSettingKey,
} from "../../workbench/state/workbench-settings";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";

/** Settings whose app-state rows arrived after logical-project preferences; older databases cannot store them. */
const KEY_RELEASES: Partial<Record<WorkbenchSettingKey, number>> = {
  gitPeerSyncMode: appStateReleases.gitPeerSyncMode.version,
  openMarkdownFilesWith: appStateReleases.fileOpenDestinations.version,
  openOtherFilesWith: appStateReleases.fileOpenDestinations.version,
  openSvgFilesWith: appStateReleases.fileOpenDestinations.version,
  threadCodeDetails: appStateReleases.threadCodeDetails.version,
};

export function useWorkbenchSettingsEditor(logicalProjectId: LogicalProjectId | null, onError: (message: string) => void) {
  const state = useWorkbenchClientStateSnapshot();
  const controller = useWorkbenchClientStateController();
  const global = useMemo(() => readGlobalWorkbenchSettings(state.records), [state.records]);
  const project = useMemo(() => logicalProjectId
    ? readLogicalProjectWorkbenchSettings(logicalProjectId, state.records) : null,
  [logicalProjectId, state.records]);

  return {
    value<K extends WorkbenchSettingKey>(key: K): WorkbenchGlobalSettings[K] {
      const override = project?.[key];
      return override?.enabled ? override.value as WorkbenchGlobalSettings[K] : global[key];
    },
    overridden: (key: WorkbenchSettingKey) => Boolean(project?.[key].enabled),
    unavailable: (key: WorkbenchSettingKey) => state.schemaVersion < Math.max(
      KEY_RELEASES[key] ?? 0,
      logicalProjectId ? appStateReleases.logicalProjectPreferences.version : 0,
    ),
    change<K extends WorkbenchSettingKey>(key: K, value: WorkbenchGlobalSettings[K]) {
      const next = (key === "editorFontSize" && typeof value === "number"
        ? Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value)) : value) as WorkbenchGlobalSettings[K];
      void (logicalProjectId
        ? writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, { enabled: true, value: next })
        : writeGlobalWorkbenchSetting(controller, key, next))
        .catch((error: Error) => onError(error.message));
    },
    reset(key: WorkbenchSettingKey) {
      if (!logicalProjectId || !project) return;
      void writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, { ...project[key], enabled: false })
        .catch((error: Error) => onError(error.message));
    },
  };
}
