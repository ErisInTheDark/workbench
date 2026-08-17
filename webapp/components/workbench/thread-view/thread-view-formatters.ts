/*
 * Exports:
 * - formatThreadTimestamp: format thread timestamps for human-readable display. Keywords: workbench, thread, time.
 * - formatThreadRelativeTimestamp: format thread timestamps as compact relative activity labels. Keywords: workbench, thread, relative time, bumped.
 * - formatThreadDuration: format durations in short d/h/m/s form for thread metadata. Keywords: workbench, thread, duration.
 * - humanizeThreadLabel: turn thread status and type labels into readable text. Keywords: workbench, thread, label.
 * - getThreadTitle: derive the best available thread title. Keywords: workbench, thread, title.
 * - truncateThreadText: shorten thread text for summaries without breaking words awkwardly. Keywords: workbench, thread, summary.
 */

import { resolveWorkbenchThreadTitle } from "../../../lib/workbench/thread/thread-state";

export function formatThreadTimestamp (timestampSeconds: number) {
  return new Date(timestampSeconds * 1000).toLocaleString();
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
  return resolveWorkbenchThreadTitle(thread);
}

export function truncateThreadText (value: string, maxLength = 120) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
