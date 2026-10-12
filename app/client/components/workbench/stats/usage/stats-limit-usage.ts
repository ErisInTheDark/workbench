/*
 * Exports:
 * - LIMIT_WINDOW_KINDS: the window slots a limit sample can report.
 * - StatsLimitBuckets: evenly sized buckets to sum limit use into.
 * - limitResolution: the finest hour-aligned buckets that cover a span within a fixed bucket budget.
 * - largestLimitWindow: the longest window in a limit's newest sample.
 * - currentLimitWindow: where one window stands now, ignoring stale readings from lagging sources.
 * - limitUsageByBucket: how much of one window was used within each bucket, inferred from its climbs and spread over time.
 * - providerWeeklyUsage: each provider's use of its longest window per bucket, scaled to a week of that allowance.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";

type Limit = WorkbenchStatsSectionData<"limits">["rateLimits"][number];
type Sample = Limit["samples"][number];
type WindowKind = (typeof LIMIT_WINDOW_KINDS)[number];

export const LIMIT_WINDOW_KINDS = ["primary", "secondary", "tertiary"] as const;
const WEEK_MINUTES = 7 * 24 * 60;
const HOUR_MS = 3_600_000;
/** Every step divides a day, so fine buckets nest inside the day and week buckets other panels use. */
const FINE_STEPS_MS = [1, 2, 3, 4, 6, 12, 24].map((hours) => hours * HOUR_MS);
const MAX_FINE_BUCKETS = 720;
/** How far back one reported climb in use can spread. */
const SPREAD_CAP_MS = 3 * HOUR_MS;

export interface StatsLimitBuckets {
  startedAt: number;
  bucketMs: number;
  count: number;
}

/** The finest hour-aligned buckets that cover the span within the bucket budget. */
export function limitResolution(startedAt: number, endedAt: number): StatsLimitBuckets {
  const span = Math.max(0, endedAt - startedAt);
  const bucketMs = FINE_STEPS_MS.find((step) => span / step <= MAX_FINE_BUCKETS) ?? FINE_STEPS_MS.at(-1)!;
  return { startedAt, bucketMs, count: Math.max(1, Math.ceil(span / bucketMs)) };
}

/** Only the newest sample decides which windows exist; a window without a duration counts as the shortest. */
export function largestLimitWindow(limit: Limit) {
  const latest = limit.samples.at(-1);
  let largest: { kind: WindowKind; durationMinutes: number | null } | null = null;
  for (const kind of LIMIT_WINDOW_KINDS) {
    const window = latest?.[kind];
    if (window && (!largest || (window.durationMinutes ?? 0) > (largest.durationMinutes ?? 0))) {
      largest = { kind, durationMinutes: window.durationMinutes };
    }
  }
  return largest;
}

interface FollowedWindow {
  durationMinutes: number | null;
  resetsAt: number | null;
  usedPercent: number;
  /** When the use last climbed. */
  changedAt: number;
  /** The newest reading that agreed with the use so far. */
  seenAt: number;
}

interface Climb {
  amount: number;
  from: number;
  to: number;
}

/**
 * Readings come from several processes and can lag: stale lower values flap in, and an old window keeps being reported
 * after an early reset. Within one window use only ever climbs, so a window is followed by its reset time and its highest
 * reading; older windows and lower readings are stale. Each climb is spread back to the previous climb, since use is
 * reported in whole steps that accrued over that time.
 */
function followWindow(samples: readonly Sample[], kind: WindowKind, onClimb?: (climb: Climb) => void) {
  let state: FollowedWindow | null = null;
  const climb = (amount: number, from: number, to: number) => {
    if (amount > 0) onClimb?.({ amount, from: Math.min(from, to), to });
  };
  for (const sample of samples) {
    const reading = sample[kind];
    const at = sample.observedAt;
    if (!reading) continue;
    if (!state || reading.durationMinutes !== state.durationMinutes) {
      // Nothing earlier compares, so the first reading of a window only sets where it stands.
      state = { ...reading, changedAt: at, seenAt: at };
      continue;
    }
    const durationMs = (reading.durationMinutes ?? 0) * 60_000;
    const tolerance = Math.min(HOUR_MS, durationMs / 10);
    const known = reading.resetsAt !== null && state.resetsAt !== null;
    if (known && reading.resetsAt! < state.resetsAt! - tolerance) continue;
    const renewed = known ? reading.resetsAt! > state.resetsAt! + tolerance : reading.usedPercent < state.usedPercent / 2;
    if (renewed) {
      const startedAt = reading.resetsAt !== null && durationMs ? reading.resetsAt - durationMs : state.seenAt;
      climb(reading.usedPercent, Math.max(startedAt, state.seenAt, at - SPREAD_CAP_MS), at);
      state = { ...reading, changedAt: at, seenAt: at };
      continue;
    }
    if (reading.usedPercent < state.usedPercent) continue;
    if (reading.usedPercent > state.usedPercent) {
      // A gap longer than the cap says nothing about when the use happened, so it spreads over the whole gap.
      climb(reading.usedPercent - state.usedPercent, Math.min(state.seenAt, Math.max(state.changedAt, at - SPREAD_CAP_MS)), at);
      state.usedPercent = reading.usedPercent;
      state.changedAt = at;
    }
    // Reset times jitter between readings; following the newest keeps the drift from adding up into a false reset.
    state.resetsAt = reading.resetsAt ?? state.resetsAt;
    state.seenAt = at;
  }
  return state;
}

/** Where one window stands now, ignoring stale readings; null when the newest sample no longer reports it. */
export function currentLimitWindow(samples: readonly Sample[], kind: WindowKind) {
  const latest = samples.at(-1)?.[kind];
  const state = latest ? followWindow(samples, kind) : null;
  return state ? { durationMinutes: state.durationMinutes, resetsAt: state.resetsAt, usedPercent: state.usedPercent } : null;
}

/** How much of one window was used within each bucket. Buckets before the first sample are unknown (null). */
export function limitUsageByBucket(samples: readonly Sample[], kind: WindowKind, buckets: StatsLimitBuckets) {
  const bucketOf = (at: number) => Math.floor((at - buckets.startedAt) / buckets.bucketMs);
  const firstKnown = samples.length ? Math.max(0, bucketOf(samples[0]!.observedAt)) : buckets.count;
  const values = Array.from({ length: buckets.count }, (_, index): number | null => index >= firstKnown ? 0 : null);
  const add = (index: number, amount: number) => {
    if (index >= 0 && index < buckets.count) values[index] = (values[index] ?? 0) + amount;
  };
  followWindow(samples, kind, ({ amount, from, to }) => {
    if (to <= from) {
      add(bucketOf(to), amount);
      return;
    }
    for (let index = bucketOf(from); index <= bucketOf(to); index++) {
      const start = buckets.startedAt + index * buckets.bucketMs;
      const overlap = Math.min(to, start + buckets.bucketMs) - Math.max(from, start);
      if (overlap > 0) add(index, amount * overlap / (to - from));
    }
  });
  return values;
}

/** A provider with several limits follows whichever has the longest window; windows without a duration cannot scale. */
export function providerWeeklyUsage(limits: readonly Limit[], buckets: StatsLimitBuckets) {
  const chosen = new Map<WorkbenchHarness, { limit: Limit; kind: WindowKind; durationMinutes: number }>();
  for (const limit of limits) {
    const window = largestLimitWindow(limit);
    if (!window?.durationMinutes) continue;
    const current = chosen.get(limit.harness);
    if (!current || window.durationMinutes > current.durationMinutes) {
      chosen.set(limit.harness, { limit, kind: window.kind, durationMinutes: window.durationMinutes });
    }
  }
  return [...chosen].sort(([left], [right]) => left.localeCompare(right)).map(([harness, { limit, kind, durationMinutes }]) => ({
    harness,
    values: limitUsageByBucket(limit.samples, kind, buckets).map((value) => value === null ? null : value * durationMinutes / WEEK_MINUTES),
  }));
}
