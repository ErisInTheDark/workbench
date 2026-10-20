/*
 * Exports:
 * - ThreadStepProgress: a step's state and timing, which the row turns into a spinner or a (live) duration.
 * - default ThreadStepRow: one step of work as a single line: kind icon, what happened (a tensed label and its subject, or a
 *   custom summary), then trailing meta ending in the step's progress; a step with detail opens it on tap.
 */
"use client";

import { Fragment, type ReactNode } from "react";

import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import { LoaderIcon } from "../workbench-icons";
import ThreadDurationText from "./ThreadDurationText";
import { isFailedStep, type StepState } from "./thread-step";
import { useThreadItemLiveDuration } from "./use-thread-live-duration";

/**
 * Roomy on its own; a packed list (`step-rows-packed`) tightens every row inside it. The static row needs `!` over its
 * own default padding, so rows with and without detail line up.
 */
const ROW_CLASS = "py-[var(--thread-step-row-py,0.5rem)]";
const STATIC_ROW_CLASS = "!py-[var(--thread-step-row-py,0.5rem)]";
const SUMMARY_CLASS = "text-[0.92em] leading-[1.6] text-fg/muted";

export interface ThreadStepProgress {
  state: StepState;
  /** Recorded duration; while running with a known `startedAtMs`, the time since then instead, ticking. */
  durationMs?: number | null;
  startedAtMs?: number | null;
  /** The step is a wait, so its duration reads "waited …". */
  waited?: boolean;
}

/** A running step without timing spins; otherwise its duration shows, ticking while it runs. */
function Progress({ progress }: { progress: ThreadStepProgress }) {
  const running = progress.state === "inProgress";
  const startedAtMs = running ? progress.startedAtMs ?? null : null;
  const durationMs = useThreadItemLiveDuration(progress.durationMs, startedAtMs);
  if (durationMs === null || durationMs === undefined) return running ? <LoaderIcon size={14} /> : null;
  return progress.waited
    ? <span data-thread-step-duration="waited">waited <ThreadDurationText className="inline" durationMs={durationMs} /></span>
    : <ThreadDurationText durationMs={durationMs} />;
}

export default function ThreadStepRow({
  bodyInset = true,
  children,
  defaultOpen = false,
  icon,
  iconClassName,
  iconLabel,
  keepMounted,
  label,
  meta,
  progress,
  renderContent,
  subject,
  summary,
}: {
  /** Off for a body that brings its own row geometry (a todo row), so it is not indented under the icon. */
  bodyInset?: boolean;
  children?: ReactNode;
  defaultOpen?: boolean;
  icon: ReactNode;
  iconClassName?: string;
  iconLabel?: string;
  /** Keep the body mounted while closed, for bodies with live state of their own. */
  keepMounted?: boolean;
  /** What happened, already tensed for the step's state (see `stepLabel`); it reads as a failure when the step failed. */
  label?: string;
  /** Trailing details before the progress (totals, counts), dot-separated; they never wrap under the summary. */
  meta?: readonly ReactNode[];
  progress?: ThreadStepProgress;
  renderContent?: () => ReactNode;
  /** What the label happened to; truncates first. */
  subject?: ReactNode;
  /** A custom line, for steps whose summary is not a label and subject. */
  summary?: ReactNode;
}) {
  const failed = progress ? isFailedStep(progress.state) : false;
  const shownMeta = [...meta ?? [], progress ? <Progress key="progress" progress={progress} /> : null]
    .filter(part => part !== null && part !== undefined && part !== false);
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
        {summary ?? (
          <span className="flex min-w-0 items-center gap-1.5">
            {label ? <span className={`shrink-0 ${failed ? "text-danger" : ""}`}>{label}</span> : null}
            {typeof subject === "string" ? <span className="min-w-0 truncate font-medium text-text">{subject}</span> : subject}
          </span>
        )}
      </span>
      {shownMeta.length ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[0.85em] text-fg/muted">
          {shownMeta.map((part, index) => (
            <Fragment key={index}>{index ? <span aria-hidden="true">·</span> : null}{part}</Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
  if ((children === undefined || children === null) && !renderContent) {
    return (
      <DisclosureStaticRow
        className={STATIC_ROW_CLASS}
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
      contentClassName={bodyInset ? "mt-1.5 space-y-2 pl-6" : "mt-1 space-y-2"}
      defaultOpen={defaultOpen}
      hideChevron
      keepMounted={keepMounted}
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
