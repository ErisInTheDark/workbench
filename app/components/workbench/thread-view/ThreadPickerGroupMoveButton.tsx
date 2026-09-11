/*
 * Exports:
 * - default ThreadPickerGroupMoveButton: circular up/down group-transfer action.
 */
"use client";
import WorkbenchIconButton from "../WorkbenchIconButton";

export default function ThreadPickerGroupMoveButton({ direction, disabled = false, label, onClick }: {
  direction: "down" | "up";
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return <WorkbenchIconButton size="small" disabled={disabled} label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true"><path d={direction === "up" ? "M4 9.5L8 5.5L12 9.5" : "M4 6.5L8 10.5L12 6.5"} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>
  </WorkbenchIconButton>;
}
