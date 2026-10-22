/*
 * Exports:
 * - ThreadStepProgress: a step's state and timing, which the row turns into a spinner or a (live) duration.
 * - default ThreadStepRow: one step of work as a single line: kind icon, what happened (a tensed label and its subject, or a
 *   custom summary), then trailing meta ending in the step's progress; a step with detail opens it on tap. Its lead and
 *   meta are marked `data-thread-step-part` for entry motion; while in progress its words shimmer at medium weight.
 */
"use client";

import { Fragment, type ReactNode } from "react";

import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import { shimmerTextClassName } from "../../../tailwind/shimmer-text-classes";
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
  live = false,
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
  /** Still in progress, for steps whose progress the row does not carry (a custom summary); its words shimmer. */
  live?: boolean;
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
  const isLive = live || progress?.state === "inProgress";
  const shownMeta = [...meta ?? [], progress ? <Progress key="progress" progress={progress} /> : null]
    .filter(part => part !== null && part !== undefined && part !== false);
  // Lead (icon, label and subject) and meta are the parts a step's entry motion moves, each about its own centre.
  const marker = <span className="flex" data-thread-step-part="lead">{icon}</span>;
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
        {/* Hugs the text, so motion about the lead's centre is about what is written, not the empty row. A step in
            progress shimmers all of it, chips included, like the live status. */}
        <span className={`flex min-w-0 max-w-full items-center ${isLive && !failed ? `${shimmerTextClassName} font-medium` : ""}`} data-thread-step-part="lead">
        {summary ?? (
          <span className="flex min-w-0 items-center gap-1.5">
            {label ? <span className={`shrink-0 ${failed ? "text-danger" : ""}`}>{label}</span> : null}
            {typeof subject === "string" ? <span className="min-w-0 truncate font-medium text-text">{subject}</span> : subject}
          </span>
        )}
        </span>
      </span>
      {shownMeta.length ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[0.85em] text-fg/muted" data-thread-step-part="meta">
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
        marker={marker}
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
      leading={marker}
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
