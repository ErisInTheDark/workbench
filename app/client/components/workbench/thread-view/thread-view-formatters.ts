/*
 * Exports:
 * - formatLongTimestamp: full local date and time for timestamp tooltips and accessible labels.
 * - formatThreadRelativeTimestamp: format thread timestamps as relative ("5m ago") or single-unit short ("5m") activity labels.
 * - humanizeThreadLabel: turn thread status and type labels into readable text. Keywords: workbench, thread, label.
 * - getThreadTitle: derive the best available thread title. Keywords: workbench, thread, title.
 * - truncateThreadText: shorten thread text for summaries without breaking words awkwardly. Keywords: workbench, thread, summary.
 */

import { resolveWorkbenchThreadTitle } from "workbench-shared/workbench/thread/thread-state";

const LONG_TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });

export function formatLongTimestamp (timestampMs: number) {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? LONG_TIMESTAMP_FORMAT.format(date) : "";
}

/** `relative` reads "5m ago"; `short` is the single unit alone ("now", "5m") for tight controls. */
export function formatThreadRelativeTimestamp (timestampSeconds: number, nowMs: number, style: "relative" | "short" = "relative") {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0 || !Number.isFinite(nowMs)) {
    return "";
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampSeconds * 1000) / 1000));
  if (elapsedSeconds < 45) {
    return style === "short" ? "now" : "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const unit = elapsedMinutes < 60 ? `${elapsedMinutes}m`
    : elapsedHours < 24 ? `${elapsedHours}h`
      : `${Math.floor(elapsedHours / 24)}d`;
  return style === "short" ? unit : `${unit} ago`;
}

export function humanizeThreadLabel (value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

export function getThreadTitle (thread: { id: string; name: string | null; preview: string }) {
  return resolveWorkbenchThreadTitle(thread);
}

export function truncateThreadText (value: string, maxLength = 120) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
