/*
 * Exports:
 * - default WorkbenchThemeSetting: theme row whose drag menu previews each theme in its own fonts and colours.
 */
"use client";

import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchTheme } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import { WORKBENCH_SETTING_DEFINITIONS } from "../../workbench/state/workbench-settings";
import IconButton from "../ui/IconButton";
import PressDragMenu from "../ui/PressDragMenu";
import { useSettings } from "./use-settings";
import { ChevronDownIcon, ResetIcon } from "./workbench-icons";

const definition = WORKBENCH_SETTING_DEFINITIONS.theme;

function ThemeSwatch({ theme, label, description }: { theme: WorkbenchTheme; label: string; description?: string }) {
  return <span data-workbench-theme-preview={theme} className="
    flex min-w-0 flex-col rounded-lg border border-[color-mix(in_srgb,var(--accent)_45%,transparent)]
    bg-[var(--app-bg-solid)] px-3 py-1.5 text-left font-[family-name:var(--font-sans)] text-sm text-text
  ">
    <span className="flex items-center gap-2 font-medium">
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-[var(--accent)]" />{label}
    </span>
    {description ? <span className="text-detail text-fg/muted">{description}</span> : null}
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
  return <section className="relative flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
    <div className="min-w-0">
      <h3 className="m-0 text-sm font-semibold text-text">{definition.label}</h3>
      <p className="m-0 mt-1 text-detail text-fg/muted">{definition.description}</p>
    </div>
    <PressDragMenu
      label={`Theme: ${current?.label ?? value}`}
      align="end"
      disabled={unavailable}
      triggerAppearance="plain"
      triggerClassName="rounded-lg"
      items={(definition.options ?? []).map(option => ({
        id: option.value,
        checked: option.value === value,
        content: <ThemeSwatch theme={option.value} label={option.label} description={option.description} />,
      }))}
      onSelect={id => {
        const option = definition.options?.find(item => item.value === id);
        if (option) void settings.set("theme", option.value).catch(report);
      }}
    >
      <span className="flex items-center gap-1">
        <ThemeSwatch theme={value} label={current?.label ?? value} description={current?.description} />
        <ChevronDownIcon size={16} className="text-fg/muted" />
      </span>
    </PressDragMenu>
    {settings.overridden("theme") ? <IconButton
      type="button" display="hover-border" label="Reset Theme to global" title="Reset Theme to global"
      className="absolute right-2 top-1/2 -translate-y-1/2 lg:-right-12" disabled={unavailable}
      onClick={() => { void settings.reset("theme").catch(report); }}
    ><ResetIcon size={18} /></IconButton> : null}
    {unavailable ? <p className="m-0 w-full text-xs text-fg/muted">Available after the app database is reloaded.</p> : null}
  </section>;
}
