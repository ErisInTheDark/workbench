/*
 * Exports:
 * - default WorkbenchThemeSetting: theme row whose opener and drag-menu rows show each theme live: its colours, fonts and ambient canvas.
 */
"use client";

import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchTheme } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import { WORKBENCH_SETTING_DEFINITIONS } from "../../workbench/state/workbench-settings";
import IconButton from "../ui/IconButton";
import PressDragMenu from "../ui/PressDragMenu";
import { useSettings } from "./use-settings";
import WorkbenchAmbientCanvas, { getAmbientCanvasVariant } from "./WorkbenchAmbientCanvas";
import { ChevronDownIcon, ResetIcon } from "./workbench-icons";

const definition = WORKBENCH_SETTING_DEFINITIONS.theme;

/** The opener and every menu row render this same card; it covers its row, so menu highlight shows as a brightness lift. */
function ThemeCard({ theme, selected }: { theme: WorkbenchTheme; selected: boolean }) {
  const option = definition.options?.find(candidate => candidate.value === theme);
  const ambient = getAmbientCanvasVariant(theme);
  return <span data-workbench-theme-preview={theme} className={`
    relative isolate flex min-h-[4.75rem] w-[23rem] max-w-full flex-col justify-center overflow-hidden rounded-xl
    [background:var(--app-bg-image)] px-3.5 py-3 text-left font-[family-name:var(--font-sans)] text-text transition
    [[data-highlighted]_&]:brightness-105
    ${selected ? "shadow-[inset_0_0_0_2px_var(--accent)]" : ""}
  `}>
    {ambient ? <WorkbenchAmbientCanvas className="-z-10" density="preview" variant={ambient} /> : null}
    <span className="flex items-center gap-2 text-sm font-medium">
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-[var(--accent)]" />{option?.label ?? theme}
    </span>
    {option?.description ? <span className="mt-0.5 block text-detail text-fg/muted">{option.description}</span> : null}
  </span>;
}

export default function WorkbenchThemeSetting({ logicalProjectId, onError }: {
  logicalProjectId: LogicalProjectId | null;
  onError: (message: string) => void;
}) {
  const settings = useSettings(logicalProjectId);
  const report = (error: Error) => onError(error.message);
  const value = settings.get("theme");
  const current = definition.options?.find(option => option.value === value);
  const unavailable = settings.unavailable("theme");
  return <section className="relative flex min-w-0 flex-col items-start gap-2 py-3">
    <h3 className="m-0 text-sm font-semibold text-text">{definition.label}</h3>
    <PressDragMenu
      label={`Theme: ${current?.label ?? value}`}
      align="start"
      disabled={unavailable}
      flushItems
      triggerAppearance="plain"
      triggerClassName="max-w-full rounded-xl"
      items={(definition.options ?? []).map(option => ({
        id: option.value,
        checked: option.value === value,
        content: <ThemeCard theme={option.value} selected={option.value === value} />,
      }))}
      onSelect={id => {
        const option = definition.options?.find(item => item.value === id);
        if (option) void settings.set("theme", option.value).catch(report);
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <ThemeCard theme={value} selected />
        <ChevronDownIcon size={16} className="shrink-0 text-fg/muted" />
      </span>
    </PressDragMenu>
    {settings.overridden("theme") ? <IconButton
      type="button" display="hover-border" label="Reset Theme to global" title="Reset Theme to global"
      className="absolute right-2 top-3 lg:-right-12" disabled={unavailable}
      onClick={() => { void settings.reset("theme").catch(report); }}
    ><ResetIcon size={18} /></IconButton> : null}
    {unavailable ? <p className="m-0 w-full text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
  </section>;
}
