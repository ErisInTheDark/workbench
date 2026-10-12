/*
 * Exports:
 * - rationStepMinutes: the rationing step for a limit window: hours, days, or quarter-months.
 * - RationMark/RationShare/RationPart: one point or one step along a what-is-left meter, with its even-pace ideal.
 * - rationParts: the meter's parts from the reset (0%) to now (what is left), alternating marks and shares.
 */
const HOUR = 60;
const DAY = 24 * HOUR;

/** 5h windows ration by hour, weekly by day, and anything longer by 7.5 days (a quarter of a 30-day month). */
export function rationStepMinutes(durationMinutes: number) {
  if (durationMinutes <= DAY) return HOUR;
  if (durationMinutes <= 14 * DAY) return DAY;
  return 7.5 * DAY;
}

/** A moment along the meter: the reset, a step boundary, or now. */
export interface RationMark {
  kind: "mark";
  at: number;
  edge: "reset" | "now" | null;
  /** What should still be left at this moment if what is left now is spread evenly until the reset. */
  leftPercent: number;
  /** What would be left at this moment had the whole window been spent at an even pace. */
  idealPercent: number;
}

/** The span between two marks: what can be spent in it. */
export interface RationShare {
  kind: "share";
  from: number;
  to: number;
  sharePercent: number;
  idealPercent: number;
}

export type RationPart = RationMark | RationShare;

/**
 * What is left now, spread evenly over the time left until the reset. Steps count back from the reset, so the current
 * partial step gets its proportional share. Parts run left to right along the meter: reset, share, mark, ..., share, now.
 */
export function rationParts(window: { durationMinutes: number | null; leftPercent: number; resetsAt: number | null }, now: number): RationPart[] {
  const { durationMinutes, leftPercent, resetsAt } = window;
  if (!durationMinutes || resetsAt === null || leftPercent <= 0) return [];
  const remainingMs = resetsAt - now;
  if (remainingMs <= 0) return [];
  const durationMs = durationMinutes * 60_000;
  const stepMs = rationStepMinutes(durationMinutes) * 60_000;
  const leftAt = (at: number) => leftPercent * (resetsAt - at) / remainingMs;
  const idealAt = (at: number) => Math.min(100, 100 * (resetsAt - at) / durationMs);
  const moments = [resetsAt];
  for (let boundary = resetsAt - stepMs; boundary > now; boundary -= stepMs) moments.push(boundary);
  moments.push(now);
  return moments.flatMap((at, index): RationPart[] => {
    const mark: RationMark = {
      kind: "mark", at, leftPercent: leftAt(at), idealPercent: idealAt(at),
      edge: index === 0 ? "reset" : index === moments.length - 1 ? "now" : null,
    };
    if (!index) return [mark];
    const later = moments[index - 1]!;
    return [{
      kind: "share", from: at, to: later,
      sharePercent: leftAt(at) - leftAt(later), idealPercent: idealAt(at) - idealAt(later),
    }, mark];
  });
}
