/*
 * Exports:
 * - formatLongTimestamp: full local date and time for timestamp tooltips and accessible labels.
 * - formatThreadRelativeTimestamp: format thread timestamps as compact relative activity labels. Keywords: workbench, thread, relative time, bumped.
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

export function formatThreadRelativeTimestamp (timestampSeconds: number, nowMs: number) {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0 || !Number.isFinite(nowMs)) {
    return "";
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampSeconds * 1000) / 1000));
  if (elapsedSeconds < 45) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
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
