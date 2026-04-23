/*
 * Exports:
 * - dialogButtonClassName: share the action button classes used across workbench dialogs. Keywords: workbench, dialog, button.
 * - WorkbenchDialogProps: type the reusable workbench dialog shell props. Keywords: workbench, dialog, props.
 * - WorkbenchDialog: render the shared modal shell for workbench confirmation and create-entry flows. Keywords: workbench, dialog, modal.
 */
import type { ReactNode } from "react";

export const dialogButtonClassName = "rounded-xl px-3 py-1.5 text-sm transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none";

export interface WorkbenchDialogProps {
  actions: ReactNode;
  children: ReactNode;
  eyebrow: string;
  id: string;
  isOpen?: boolean;
  onBackdropClick?: () => void;
  summaryId?: string;
  title: string;
  titleId: string;
}

export function WorkbenchDialog ({
  actions,
  children,
  eyebrow,
  id,
  isOpen,
  onBackdropClick,
  summaryId,
  title,
  titleId,
}: WorkbenchDialogProps) {
  return (
    <div
      id={id}
      hidden={typeof isOpen === "boolean" ? !isOpen : true}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      data-workbench-dialog="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_74%,transparent)] px-5 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onBackdropClick?.();
        }
      }}
    >
      <div className="w-full max-w-md rounded-[1.4rem] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-5 py-4 shadow-float">
        <p className="m-0 text-[0.84rem] tracking-[0.02em] text-muted">{eyebrow}</p>
        <h2 id={titleId} className="mt-0.5 text-base font-semibold leading-tight">
          {title}
        </h2>
        {children}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {actions}
        </div>
      </div>
    </div>
  );
}
