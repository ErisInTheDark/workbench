/*
 * Exports:
 * - WorkbenchSettingsStatusTone: readiness tone of one daemon capability.
 * - default WorkbenchSettingsStatusRow: bordered settings row with a name, status dot, detail, actions, an error card and optional body.
 */
"use client";

import type { ReactNode } from "react";
import ErrorCard from "../ui/ErrorCard";

export type WorkbenchSettingsStatusTone = "ready" | "action" | "failed" | "pending";

const toneClassName: Record<WorkbenchSettingsStatusTone, string> = {
  ready: "text-success",
  action: "text-[color:var(--attention)]",
  failed: "text-danger",
  pending: "text-fg/muted",
};

export default function WorkbenchSettingsStatusRow({ label, tone, status, detail, error = "", body, children }: {
  label: string;
  tone: WorkbenchSettingsStatusTone;
  status: string;
  detail: string;
  error?: string;
  /** Content under the header, inside the card. */
  body?: ReactNode;
  /** Row actions, aligned to the end. */
  children?: ReactNode;
}) {
  return <div className="py-1">
    <div className="rounded-[0.95rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[0.86em] font-medium leading-[1.5] text-text">{label}</span>
            <span role="status" className={`inline-flex items-center gap-1.5 text-[0.76em] leading-[1.5] ${toneClassName[tone]}`}>
              <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${tone === "pending" ? "motion-safe:animate-pulse" : ""}`} />
              {status}
            </span>
          </div>
          <p className="m-0 mt-0.5 whitespace-pre-line break-words text-[0.78em] leading-[1.55] text-fg/muted">{detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">{children}</div>
      </div>
      {error ? <ErrorCard className="mt-2 px-3 py-2 text-[0.92em]">{error}</ErrorCard> : null}
      {body}
    </div>
  </div>;
}
