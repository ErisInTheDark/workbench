/*
 * Keywords: generic item, sleep, matcher, countdown, timing.
 * Exports:
 * - SleepItemMatch: validated sleep presentation input.
 * - matchSleepItem: recognise a generic sleep payload without changing its source.
 * - getSleepDisplay: derive countdown and completion from owned timing.
 */
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";

export interface SleepItemMatch {
  kind: "sleep";
  durationMs: number;
}

export function matchSleepItem({ nativeType, safeValue }: { nativeType: string; safeValue: JsonValue }): SleepItemMatch | null {
  if (nativeType !== "sleep" || !safeValue || typeof safeValue !== "object" || Array.isArray(safeValue)) {
    return null;
  }
  const durationMs = safeValue.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? { kind: "sleep", durationMs }
    : null;
}

export function getSleepDisplay({
  durationMs,
  startedAt,
  completedAt,
  turnStatus,
  nowMs,
}: {
  durationMs: number;
  startedAt: number | null;
  completedAt: number | null;
  turnStatus: Turn["status"];
  nowMs: number;
}) {
  const completed = completedAt !== null || turnStatus !== "inProgress";
  const remainingMs = completed || startedAt === null
    ? durationMs
    : Math.max(0, durationMs - Math.max(0, nowMs - startedAt));
  return {
    seconds: Math.ceil(remainingMs / 1_000),
    completed,
    ticking: !completed && startedAt !== null && remainingMs > 0,
  };
}
