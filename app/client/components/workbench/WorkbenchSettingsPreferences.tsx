/*
 * Exports:
 * - default WorkbenchSettingsPreferences: edit global or logical-project preferences through the shared registry.
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
  WORKBENCH_SETTING_DEFINITIONS,
  writeGlobalWorkbenchSetting,
  writeLogicalProjectWorkbenchSetting,
  type WorkbenchGlobalSettings,
  type WorkbenchSettingKey,
} from "../../workbench/state/workbench-settings";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";
import { ResetIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchOptionCards, { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import WorkbenchStepSlider from "./WorkbenchStepSlider";

const sizeSteps = [0.9, 1, 1.08, 1.18, 1.32, 1.48].map((value, index) => ({ label: String(index + 1), value }));

export default function WorkbenchSettingsPreferences({
  keys,
  logicalProjectId,
  onError,
}: {
  keys: readonly WorkbenchSettingKey[];
  logicalProjectId: LogicalProjectId | null;
  onError: (message: string) => void;
}) {
  const state = useWorkbenchClientStateSnapshot();
  const controller = useWorkbenchClientStateController();
  const global = useMemo(() => readGlobalWorkbenchSettings(state.records), [state.records]);
  const project = useMemo(() => logicalProjectId
    ? readLogicalProjectWorkbenchSettings(logicalProjectId, state.records) : null,
  [logicalProjectId, state.records]);

  function change<K extends WorkbenchSettingKey>(key: K, value: WorkbenchGlobalSettings[K]) {
    const next = (key === "editorFontSize" && typeof value === "number"
      ? Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value)) : value) as WorkbenchGlobalSettings[K];
    void (logicalProjectId
      ? writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, { enabled: true, value: next })
      : writeGlobalWorkbenchSetting(controller, key, next))
      .catch((error: Error) => onError(error.message));
  }

  function reset(key: WorkbenchSettingKey) {
    if (!logicalProjectId || !project) return;
    void writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, {
      ...project[key],
      enabled: false,
    }).catch((error: Error) => onError(error.message));
  }

  return <>{keys.map(key => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    const override = project?.[key];
    const value = override?.enabled ? override.value : global[key];
    const unavailable = logicalProjectId
      ? state.schemaVersion < appStateReleases.logicalProjectPreferences.version
      : key === "threadCodeDetails" && state.schemaVersion < appStateReleases.threadCodeDetails.version;
    const resetButton = override?.enabled ? <WorkbenchIconButton
      type="button" display="hover-border" label={`Reset ${definition.label} to global`}
      title={`Reset ${definition.label} to global`}
      className="absolute right-2 top-1/2 -translate-y-1/2 lg:-right-12"
      disabled={unavailable}
      onClick={() => reset(key)}
    ><ResetIcon size={18} /></WorkbenchIconButton> : null;
    if (definition.type === "boolean" && typeof value === "boolean") return <section key={key}
      className="relative rounded-[0.85rem] py-1">
      <WorkbenchOptionCard label={definition.label} description={definition.description}
        isSingleChoice={false} isChecked={value} disabled={unavailable}
        onClick={() => change(key, !value as never)} />
      {resetButton}
      {unavailable ? <p className="text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
    </section>;
    return <section key={key} className="relative space-y-3 py-3">
      <div>
        <h3 className="m-0 text-sm font-semibold text-text">{definition.label}</h3>
        {definition.description ? <p className="m-0 mt-1 text-xs leading-5 text-fg/muted">{definition.description}</p> : null}
      </div>
      {key === "editorFontSize"
        ? <WorkbenchStepSlider ariaLabel={definition.label} disabled={unavailable}
          value={typeof value === "number" ? value : 1.08} steps={sizeSteps}
          onChange={next => change(key, next as never)} />
        : definition.options ? <WorkbenchOptionCards<WorkbenchGlobalSettings[WorkbenchSettingKey]>
          ariaLabel={definition.label} columns={definition.columns ?? "one"} disabled={unavailable}
          mode="radio" options={definition.options} value={value}
          onChange={next => change(key, next as never)} /> : null}
      {resetButton}
      {unavailable ? <p className="text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
    </section>;
  })}</>;
}
