/*
 * Exports:
 * - default WorkbenchThreadListFullRowContent: render the shared two-row sidebar body or a three-row thread body with leading context, title, status, metadata, and timestamp slots. Keywords: thread, folder, sidebar, row, project, layout.
 */

import type { ReactNode } from "react";

export default function WorkbenchThreadListFullRowContent({
  action,
  contextMenu = false,
  eyebrow,
  metadata,
  statusIcon,
  statusLabel,
  timestamp,
  title,
}: {
  action?: ReactNode;
  contextMenu?: boolean;
  eyebrow?: ReactNode;
  metadata?: ReactNode;
  statusIcon: ReactNode;
  statusLabel: ReactNode;
  timestamp: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none relative z-10 min-w-0 pr-[var(--thread-context-menu-row-padding-right,0.5rem)]"
      data-thread-context-menu-content={contextMenu ? "true" : undefined}
    >
      {eyebrow ? <div className="pointer-events-none min-w-0 px-2 pt-1.5">{eyebrow}</div> : null}
      <div className={`pointer-events-none grid min-w-0 grid-cols-[minmax(0,1fr)_auto] pr-0 pl-2 ${eyebrow ? "pt-0.5" : "pt-1.5"}`}>
        {title}
        {action}
      </div>
      <div className="pointer-events-none mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 pr-0 pb-1.5 pl-2 text-[0.72rem] text-muted">
        {statusIcon}
        {statusLabel}
        {metadata ?? <span />}
        {timestamp}
      </div>
    </div>
  );
}
