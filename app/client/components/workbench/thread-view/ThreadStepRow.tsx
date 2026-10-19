/*
 * Exports:
 * - default ThreadStepRow: one step of work as a single line (kind icon, clipped summary, trailing meta such as duration); a step with detail opens it on tap.
 */
"use client";

import { Fragment, type ReactNode } from "react";

import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";

/** Matches DisclosureStaticRow's own padding, so rows with and without detail line up. */
const ROW_CLASS = "py-2";
const SUMMARY_CLASS = "text-[0.92em] leading-[1.6]";

export default function ThreadStepRow({
  children,
  defaultOpen = false,
  icon,
  iconClassName,
  iconLabel,
  meta,
  renderContent,
  summary,
}: {
  children?: ReactNode;
  defaultOpen?: boolean;
  icon: ReactNode;
  iconClassName?: string;
  iconLabel?: string;
  /** Trailing details (outcome, duration), dot-separated; they never wrap under the summary. */
  meta?: readonly ReactNode[];
  renderContent?: () => ReactNode;
  summary: ReactNode;
}) {
  const shownMeta = meta?.filter(part => part !== null && part !== undefined && part !== false) ?? [];
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">{summary}</span>
      {shownMeta.length ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[0.85em] text-fg/muted">
          {shownMeta.map((part, index) => (
            <Fragment key={index}>{index ? <span aria-hidden="true">·</span> : null}{part}</Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
  if (children === undefined && !renderContent) {
    return (
      <DisclosureStaticRow
        marker={icon}
        markerClassName={iconClassName}
        markerLabel={iconLabel}
        summary={line}
        summaryClassName={SUMMARY_CLASS}
      />
    );
  }
  return (
    <Disclosure
      className={ROW_CLASS}
      contentClassName="mt-1.5 space-y-2 pl-6"
      defaultOpen={defaultOpen}
      hideChevron
      leading={icon}
      leadingClassName={iconClassName}
      leadingLabel={iconLabel}
      renderContent={renderContent}
      summary={line}
      summaryClassName={SUMMARY_CLASS}
    >
      {children}
    </Disclosure>
  );
}
