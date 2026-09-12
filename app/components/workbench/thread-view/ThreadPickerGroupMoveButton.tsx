/*
 * Exports:
 * - default ThreadPickerGroupMoveButton: circular up/down group-transfer action.
 */
"use client";
import WorkbenchIconButton from "../WorkbenchIconButton";
import { ChevronDownIcon, ChevronUpIcon } from "../workbench-icons";

export default function ThreadPickerGroupMoveButton({ direction, disabled = false, label, onClick }: {
  direction: "down" | "up";
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return <WorkbenchIconButton size="small" disabled={disabled} label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>
    {direction === "up" ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
  </WorkbenchIconButton>;
}
