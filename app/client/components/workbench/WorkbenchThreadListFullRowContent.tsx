/*
 * Exports:
 * - default WorkbenchThreadListFullRowContent: render the shared two-row sidebar body or a three-row thread body with leading context, title, status (optionally preceded by a leading label), metadata, and timestamp slots.
 */

import type { ReactNode } from "react";

export default function WorkbenchThreadListFullRowContent({
  action,
  contextMenu = false,
  eyebrow,
  metadata,
  statusIcon,
  statusLabel,
  statusLeading,
  timestamp,
  title,
}: {
  action?: ReactNode;
  contextMenu?: boolean;
  eyebrow?: ReactNode;
  metadata?: ReactNode;
  statusIcon: ReactNode;
  statusLabel: ReactNode;
  /** Shown before the status icon, such as a coloured subagent name. */
  statusLeading?: ReactNode;
  timestamp: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className={`
        pointer-events-none relative z-10 min-w-0 pr-2
        ${contextMenu ? "coarse-touch:pr-12" : ""}
      `}
    >
      {eyebrow ? <div className="pointer-events-none min-w-0 px-2 pt-1.5">{eyebrow}</div> : null}
      <div className={`pointer-events-none grid min-w-0 grid-cols-[minmax(0,1fr)_auto] pr-0 pl-2 ${eyebrow ? "pt-0.5" : "pt-1.5"}`}>
        {title}
        {action}
      </div>
      <div className={`pointer-events-none mt-0.5 grid min-w-0 items-center gap-1.5 pr-0 pb-1.5 pl-2 text-[0.72rem] text-fg/muted ${statusLeading ? "grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]" : "grid-cols-[auto_minmax(0,1fr)_auto_auto]"}`}>
        {statusLeading ? <span className="min-w-0 truncate font-medium">{statusLeading}</span> : null}
        {statusIcon}
        {statusLabel}
        {metadata ?? <span />}
        {timestamp}
      </div>
    </div>
  );
}
