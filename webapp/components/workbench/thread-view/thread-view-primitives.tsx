/*
 * Exports:
 * - formatThreadTimestamp: format thread timestamps for human-readable display. Keywords: workbench, thread, time.
 * - formatThreadDuration: format durations in short d/h/m/s form for thread metadata. Keywords: workbench, thread, duration.
 * - humanizeThreadLabel: turn thread status and type labels into readable text. Keywords: workbench, thread, label.
 * - getThreadTitle: derive the best available thread title. Keywords: workbench, thread, title.
 * - truncateThreadText: shorten thread text for summaries without breaking words awkwardly. Keywords: workbench, thread, summary.
 * - ThreadTextBlock: render wrapped plain thread text with optional monospace styling. Keywords: workbench, thread, text.
 * - ThreadCommandSummary: render the compact command summary label used in thread turns. Keywords: workbench, thread, command.
 */
"use client";

import type { ReactNode } from "react";
import type {
  ThreadCommandDisplayPart,
  ThreadCommandSummaryDisplay,
} from "../../../lib/workbench/thread/thread-command-matchers";

import ProjectFilePath from "../ProjectFilePath";
import ThreadSummaryText from "./ThreadSummaryText";

const THREAD_INLINE_CODE_CLASS = [
  "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)]",
  "px-[0.34em] py-[0.08em] font-mono text-[0.94em]",
].join(" ");

const THREAD_SKILL_MENTION_CLASS = [
  "rounded-[0.35rem] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]",
  "px-[0.34em] py-[0.08em] font-mono text-[0.94em]",
  "ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_24%,transparent)]",
].join(" ");

export function formatThreadTimestamp (timestampSeconds: number) {
  return new Date(timestampSeconds * 1000).toLocaleString();
}

export function formatThreadDuration (durationMs: number | null) {
  if (durationMs === null) {
    return "";
  }

  const totalMs = Math.max(0, Math.floor(durationMs));
  if (totalMs > 0 && totalMs < 1000) {
    return `${totalMs}ms`;
  }

  let remainingMs = totalMs;
  const days = Math.floor(remainingMs / 86_400_000);
  remainingMs -= days * 86_400_000;
  const hours = Math.floor(remainingMs / 3_600_000);
  remainingMs -= hours * 3_600_000;
  const minutes = Math.floor(remainingMs / 60_000);
  remainingMs -= minutes * 60_000;
  const seconds = Math.floor(remainingMs / 1000);
  remainingMs -= seconds * 1000;

  const parts = [];
  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes) {
    parts.push(`${minutes}m`);
  }
  if (seconds || (!parts.length && !remainingMs)) {
    parts.push(`${seconds}s`);
  }

  if (!parts.length) {
    parts.push("0s");
  }

  return parts.join(" ");
}

export function humanizeThreadLabel (value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

export function getThreadTitle (thread: { id: string; name: string | null; preview: string }) {
  return thread.name || thread.preview || thread.id;
}

export function truncateThreadText (value: string, maxLength = 120) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function ThreadTextBlock ({
  children,
  monospace = false,
}: {
  children: ReactNode;
  monospace?: boolean;
}) {
  return (
    <div className={`whitespace-pre-wrap break-words ${monospace ? "font-mono text-[0.78em] leading-[1.6]" : ""}`}>
      {children}
    </div>
  );
}

function ThreadCommandStageArrowIcon () {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      className="size-5.5 shrink-0 opacity-30"
    >
      <path d="M3.75 10H14.25" strokeLinecap="round" />
      <path d="M10.75 6L14.75 10L10.75 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function splitCommandSummaryStages (parts: ThreadCommandDisplayPart[]) {
  const stages: ThreadCommandDisplayPart[][] = [[]];

  for (const part of parts) {
    if (part.type === "separator") {
      if (stages[stages.length - 1]?.length) {
        stages.push([]);
      }
      continue;
    }

    stages[stages.length - 1]?.push(part);
  }

  return stages.filter((stage) => stage.length);
}

function ThreadCommandStageParts ({ parts }: { parts: ThreadCommandDisplayPart[]; }) {
  return (
    <>
      {parts.map((part, index) => (
        part.type === "separator" ? null : part.type === "skill" ? (
          <span
            key={`skill:${part.path}:${index}`}
            className={THREAD_SKILL_MENTION_CLASS}
            title={part.path}
          >
            /{part.name}
          </span>
        ) : part.type === "path" ? (
          <ProjectFilePath
            key={`path:${part.path}:${part.lineNumber ?? ""}:${part.columnNumber ?? ""}:${index}`}
            className="max-w-full shrink min-w-0 align-baseline"
            columnNumber={part.columnNumber ?? null}
            label={part.label}
            lineNumber={part.lineNumber ?? null}
            path={part.path}
          />
        ) : (
          <span key={`text:${index}`} className="contents">
            {part.variant === "code" ? (
              <code
                className={`${THREAD_INLINE_CODE_CLASS} ${part.clamp ? "inline-block shrink-1 min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom" : ""}`}
                title={part.clamp ? part.text : undefined}
              >
                {part.text}
              </code>
            ) : (
              <ThreadSummaryText text={part.text} />
            )}
          </span>
        )
      ))}
    </>
  );
}

export function ThreadCommandSummary ({ display }: { display: ThreadCommandSummaryDisplay }) {
  const stages = splitCommandSummaryStages(display.summaryParts);

  return (
    <span className="inline-flex max-w-[calc(100%-0.6rem)] min-w-0 flex-wrap items-center gap-x-[0.45rem] gap-y-[0.3rem] align-bottom">
      {display.showShell && display.shell ? (
        <span className="shrink-0 font-mono text-[0.78em] leading-[1.6] text-muted">
          {display.shell}:
        </span>
      ) : null}
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-[0.45rem] gap-y-[0.3rem]">
        {stages.map((stage, index) => (
          index === 0 ? (
            <span key={`stage:${index}`} className="inline-flex min-w-0 max-w-full items-baseline gap-[0.3rem]">
              <ThreadCommandStageParts parts={stage} />
            </span>
          ) : (
            <span
              key={`stage:${index}`}
              className="inline-flex min-w-0 max-w-full items-center gap-[0.3rem]"
            >
              <ThreadCommandStageArrowIcon />
              <span className="inline-flex min-w-0 max-w-full items-baseline gap-[0.3rem]">
                <ThreadCommandStageParts parts={stage} />
              </span>
            </span>
          )
        ))}
      </span>
    </span>
  );
}
