/*
 * Exports:
 * - default ThreadComposerPickerHeader: shared composer-picker title, actions and close control.
 */
"use client";

import type { ReactNode } from "react";

import { PanelCloseIcon } from "../workbench-icons";
import WorkbenchIconButton from "../WorkbenchIconButton";

interface ThreadComposerPickerHeaderAction {
  disabled?: boolean;
  icon: ReactNode;
  isActive?: boolean;
  label: string;
  onClick: () => void;
}

export default function ThreadComposerPickerHeader({
  actions = [],
  closeLabel = "Back to message",
  onClose,
  supportingText,
  title,
}: {
  actions?: readonly ThreadComposerPickerHeaderAction[];
  closeLabel?: string;
  onClose: () => void;
  supportingText?: string | null;
  title: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 shrink-1">
        <p className="m-0 text-[1.2em] font-semibold text-fg/muted">{title}</p>
        {supportingText ? (
          <p className="mt-1 mb-0 text-[0.78em] leading-[1.6] text-fg/muted">{supportingText}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start">
        {actions.map((action) => (
          <WorkbenchIconButton
            key={action.label}
            label={action.label}
            aria-pressed={action.isActive}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.icon}
          </WorkbenchIconButton>
        ))}
        <WorkbenchIconButton
          label={closeLabel}
          onClick={onClose}
        >
          <PanelCloseIcon size={16} />
        </WorkbenchIconButton>
      </div>
    </div>
  );
}
