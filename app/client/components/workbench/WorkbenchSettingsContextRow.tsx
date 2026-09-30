/*
 * Exports:
 * - default WorkbenchSettingsContextRow: select a settings daemon or folder with the shared press-drag menu.
 */
"use client";

import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import { ChevronDownIcon } from "./workbench-icons";

export default function WorkbenchSettingsContextRow ({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onSelect: (id: string) => void;
}) {
  return <WorkbenchPressDragMenu
    label={`Choose ${label.toLowerCase()}`}
    items={options.map(option => ({
      id: option.id,
      checked: option.id === value,
      content: option.label,
    }))}
    onSelect={onSelect}
    triggerAppearance="plain"
    triggerClassName="
      w-fit gap-2 rounded-[0.95rem] border border-text/10 py-2 px-3 text-left text-sm text-fg/muted
      hover:border-[color-mix(in_srgb,var(--text)_22%,transparent)] focus:border-[color-mix(in_srgb,var(--text)_22%,transparent)]
      hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] focus:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]
    "
  >
    <span className="mr-1 shrink-0 text-fg/80 text-sm">{label}</span>
    <span className="min-w-0 max-w-72 truncate font-medium text-text">{options.find(option => option.id === value)?.label ?? "Choose"}</span>
    <ChevronDownIcon size={16} />
  </WorkbenchPressDragMenu>;
}
