/*
 * Exports:
 * - default ThreadComposerPickerHeader: render the shared composer-picker title, actions, and return-to-message control. Keywords: thread, composer, picker, header, actions.
 */
"use client";

import type { ReactNode } from "react";

import { PanelCloseIcon } from "../workbench-icons";

const pickerIconButtonClassName = "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[color-mix(in_srgb,var(--text)_10%,transparent)] disabled:hover:bg-transparent disabled:hover:text-muted";

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
        <p className="m-0 text-[1.2em] font-semibold text-muted">{title}</p>
        {supportingText ? (
          <p className="mt-1 mb-0 text-[0.78em] leading-[1.6] text-muted">{supportingText}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            aria-label={action.label}
            aria-pressed={action.isActive}
            title={action.label}
            className={pickerIconButtonClassName}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.icon}
          </button>
        ))}
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          className={pickerIconButtonClassName}
          onClick={onClose}
        >
          <PanelCloseIcon />
        </button>
      </div>
    </div>
  );
}
