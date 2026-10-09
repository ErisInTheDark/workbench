"use client";

/*
 * Exports:
 * - default WorkbenchStatsStatus: an always-present inline slot for connection, import progress, and issues, with a details popover.
 */
import { useEffect, useRef, useState } from "react";
import { TriangleAlertIcon as AlertTriangleIcon } from "../workbench-icons";
import useStats from "./use-stats";

interface Issue { key: string; source: string; message: string }

/** Panels show their own loading; this slot reports what concerns the whole view. */
export default function WorkbenchStatsStatus({ error }: {
  /** A failed import or refresh request from the view. */
  error: string;
}) {
  const { ready } = useStats();
  const status = useStats.status().data;
  const readFailures = useStats.failures();
  const progress = status?.historyImport ?? null;
  const failures = status?.failures ?? [];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const issues: Issue[] = [
    ...(error ? [{ key: "error", source: "Statistics", message: error }] : []),
    ...readFailures.map((message, index) => ({ key: `read:${index}`, source: "Statistics", message })),
    ...(progress?.recentFailures ?? []).map((failure, index) => ({
      key: `import:${index}`, source: `${failure.source === "claims" ? "Claim" : "Usage"} import`, message: `${failure.subject} · ${failure.message}`,
    })),
    ...failures.map((failure, index) => ({
      key: `capture:${index}`, source: failure.harness ? `${failure.harness} ${failure.source}` : `Live ${failure.source}`, message: failure.message,
    })),
  ];
  // The importer reports running until its final settlement; a full bar has nothing left to announce.
  const importing = progress?.state === "running" && progress.percent < 100;
  const label = !ready ? "Connecting…" : importing ? `Importing ${progress.percent.toFixed(0)}%` : "";
  const busy = !ready || importing;
  const hasDetails = issues.length > 0 || Boolean(progress && progress.state !== "idle");

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    // Always rendered at a fixed height so status changes never move the page below.
    <div className="relative ml-auto flex h-7 min-w-0 shrink-0 items-center gap-2 text-[0.74rem] text-fg/muted" ref={root}>
      {busy ? <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" /> : null}
      <span aria-live="polite" className="truncate empty:hidden">{label}</span>
      {hasDetails ? (
        <button
          aria-expanded={open}
          className={`
            inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors hover:bg-fg/6
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
            ${issues.length ? "text-hue-40 [--hue-chroma:60%]" : "hover:text-text"}
          `}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
          type="button"
        >
          {issues.length ? <AlertTriangleIcon size={14} /> : null}
          {issues.length ? `${issues.length} ${issues.length === 1 ? "issue" : "issues"}` : "Import details"}
        </button>
      ) : null}
      {open && hasDetails ? (
        <div
          className="
            absolute right-0 top-full z-30 mt-1.5 max-h-80 w-[min(28rem,calc(100vw-2rem))] space-y-3 overflow-y-auto
            rounded-[1.1rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-overlay-glass p-3.5 text-[0.76rem] shadow-float backdrop-blur-xl
          "
          onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
          role="dialog"
        >
          {progress && progress.state !== "idle" ? (
            <div className="space-y-1">
              <p className="m-0 font-semibold text-text">History import {progress.state === "complete" ? "complete" : `${progress.percent.toFixed(0)}%`}</p>
              <p className="m-0 tabular-nums">
                Usage {progress.usage.processed.toLocaleString()}/{progress.usage.total.toLocaleString()}
                {" · "}Claims {progress.claims.processed.toLocaleString()}/{progress.claims.total.toLocaleString()}
              </p>
              {progress.unsupportedClaimCheckpoints ? (
                <p className="m-0">{progress.unsupportedClaimCheckpoints.toLocaleString()} older claim checkpoints predate claim recording and are skipped</p>
              ) : null}
            </div>
          ) : null}
          {issues.length ? (
            <ul className="m-0 space-y-2 p-0">
              {issues.map((issue) => (
                <li className="flex list-none gap-2" key={issue.key}>
                  <AlertTriangleIcon className="mt-0.5 shrink-0 text-hue-40 [--hue-chroma:60%]" size={14} />
                  <span className="min-w-0">
                    <span className="block font-medium text-text first-letter:uppercase">{issue.source}</span>
                    <span className="block break-words">{issue.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
