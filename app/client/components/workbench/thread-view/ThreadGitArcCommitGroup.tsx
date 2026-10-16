/*
 * Exports:
 * - plural: count label for a group summary.
 * - threadGitArcCommitRowClassName: separator and inset for one commit row inside a group or list.
 * - default ThreadGitArcCommitGroup: a collapsed group of commit rows (accepted commits, pending proposals, stack layers) with one summary line and recessed well.
 */
"use client";

import type { ReactNode } from "react";

import Disclosure from "../../ui/Disclosure";

/** Group counts: "1 commit", "3 proposals". */
export function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const threadGitArcCommitRowClassName ="border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3";

export default function ThreadGitArcCommitGroup({
  action,
  children,
  count,
  icon,
  iconLabel,
  inline = false,
  keepMounted,
  title,
  ...rest
}: {
  action?: ReactNode;
  children: ReactNode;
  count: string;
  icon: ReactNode;
  iconLabel: string;
  /** Sits among a card's own detail rows: their inset and type, no separator line. */
  inline?: boolean;
  /** Rows stay mounted while closed, so their cards keep state. */
  keepMounted?: boolean;
  title: string;
} & { [attribute: `data-${string}`]: string }) {
  return (
    <Disclosure
      {...rest}
      className={inline ? undefined : "border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]"}
      contentClassName={`
        mb-2 overflow-hidden rounded-[0.65rem] bg-fg/4 [&>*:first-child]:border-t-0
        ${inline ? "" : "mx-2"}
      `}
      keepMounted={keepMounted}
      leading={icon}
      leadingLabel={iconLabel}
      summary={(
        <span className="flex min-w-0 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 truncate font-medium text-text">{title}</span>
            <span className="text-fg/muted">{count}</span>
          </span>
          {action}
        </span>
      )}
      summaryClassName={inline ? "py-1 text-[0.88em] leading-[1.6]" : "px-3 py-2 text-[0.76em] leading-[1.45]"}
    >
      {children}
    </Disclosure>
  );
}
