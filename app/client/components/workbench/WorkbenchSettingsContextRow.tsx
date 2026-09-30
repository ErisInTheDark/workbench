/*
 * Exports:
 * - default WorkbenchSettingsContextRow: select a settings daemon or folder with the shared press-drag menu.
 */
"use client";

import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import { ChevronDownIcon } from "./workbench-icons";

export default function WorkbenchSettingsContextRow({
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
  return <div className="flex min-w-0 items-center justify-between gap-3 rounded-[0.95rem] border border-text/10 px-3 py-1.5 text-sm">
    <span className="shrink-0 font-medium text-text">{label}</span>
    <WorkbenchPressDragMenu
      label={`Choose ${label.toLowerCase()}`}
      items={options.map(option => ({
        id: option.id,
        checked: option.id === value,
        content: option.label,
      }))}
      onSelect={onSelect}
    >
      <span className="min-w-0 max-w-72 truncate text-text">{options.find(option => option.id === value)?.label ?? "Choose"}</span>
      <ChevronDownIcon size={14} />
    </WorkbenchPressDragMenu>
  </div>;
}
