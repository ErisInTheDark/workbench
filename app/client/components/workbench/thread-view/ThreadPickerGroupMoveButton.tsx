/*
 * Exports:
 * - default ThreadPickerGroupMoveButton: circular up/down group-transfer action.
 */
"use client";
import IconButton from "../../ui/IconButton";
import { ChevronDownIcon, ChevronUpIcon } from "../workbench-icons";

export default function ThreadPickerGroupMoveButton({ direction, disabled = false, label, onClick }: {
  direction: "down" | "up";
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return <IconButton size="small" disabled={disabled} label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>
    {direction === "up" ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
  </IconButton>;
}
