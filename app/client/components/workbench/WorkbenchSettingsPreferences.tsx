/*
 * Exports:
 * - default WorkbenchSettingsPreferences: edit global or logical-project preferences through the shared registry.
 */
"use client";

import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import {
  WORKBENCH_SETTING_DEFINITIONS,
  type WorkbenchGlobalSettings,
  type WorkbenchSettingKey,
} from "../../workbench/state/workbench-settings";
import { ResetIcon } from "./workbench-icons";
import IconButton from "../ui/IconButton";
import OptionCards, { OptionCard } from "../ui/OptionCards";
import StepSlider from "../ui/StepSlider";
import { useWorkbenchSettingsEditor } from "./use-workbench-settings-editor";

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
  const settings = useWorkbenchSettingsEditor(logicalProjectId, onError);

  return <>{keys.map(key => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    const value = settings.value(key);
    const unavailable = settings.unavailable(key);
    const resetButton = settings.overridden(key) ? <IconButton
      type="button" display="hover-border" label={`Reset ${definition.label} to global`}
      title={`Reset ${definition.label} to global`}
      className="absolute right-2 top-1/2 -translate-y-1/2 lg:-right-12"
      disabled={unavailable}
      onClick={() => settings.reset(key)}
    ><ResetIcon size={18} /></IconButton> : null;
    if (definition.type === "boolean" && typeof value === "boolean") return <section key={key}
      className="relative rounded-[0.85rem] py-1">
      <OptionCard label={definition.label} description={definition.description}
        isSingleChoice={false} isChecked={value} disabled={unavailable}
        onClick={() => settings.change(key, !value as never)} />
      {resetButton}
      {unavailable ? <p className="text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
    </section>;
    return <section key={key} className="relative space-y-3 py-3">
      <div>
        <h3 className="m-0 text-sm font-semibold text-text">{definition.label}</h3>
        {definition.description ? <p className="m-0 mt-1 text-xs leading-5 text-fg/muted">{definition.description}</p> : null}
      </div>
      {key === "editorFontSize"
        ? <StepSlider ariaLabel={definition.label} disabled={unavailable}
          value={typeof value === "number" ? value : 1.08} steps={sizeSteps}
          onChange={next => settings.change(key, next as never)} />
        : definition.options ? <OptionCards<WorkbenchGlobalSettings[WorkbenchSettingKey]>
          ariaLabel={definition.label} columns={definition.columns ?? "one"} disabled={unavailable}
          mode="radio" options={definition.options} value={value}
          onChange={next => settings.change(key, next as never)} /> : null}
      {resetButton}
      {unavailable ? <p className="text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
    </section>;
  })}</>;
}
