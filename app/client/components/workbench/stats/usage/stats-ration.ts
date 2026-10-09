/*
 * Exports:
 * - rationStepMinutes: the rationing step for a limit window: hours, days, or quarter-months.
 * - rationThresholds: share (percent) that should still be left at each future step if what is left now is spread evenly until reset.
 */
const HOUR = 60;
const DAY = 24 * HOUR;

/** 5h windows ration by hour, weekly by day, and anything longer by 7.5 days (a quarter of a 30-day month). */
export function rationStepMinutes(durationMinutes: number) {
  if (durationMinutes <= DAY) return HOUR;
  if (durationMinutes <= 14 * DAY) return DAY;
  return 7.5 * DAY;
}

/**
 * What is left now, spread evenly over the time left until the reset. Steps count back from the reset, so the
 * current partial step gets its proportional share; each value is the share that should still be left when that
 * step boundary arrives.
 */
export function rationThresholds(window: { durationMinutes: number | null; leftPercent: number; resetsAt: number | null }, now: number) {
  if (!window.durationMinutes || window.resetsAt === null || window.leftPercent <= 0) return [];
  const remainingMs = window.resetsAt - now;
  if (remainingMs <= 0) return [];
  const stepMs = rationStepMinutes(window.durationMinutes) * 60_000;
  const thresholds: number[] = [];
  for (let boundary = window.resetsAt - stepMs; boundary > now; boundary -= stepMs) {
    thresholds.push(window.leftPercent * (window.resetsAt - boundary) / remainingMs);
  }
  return thresholds.reverse();
}
