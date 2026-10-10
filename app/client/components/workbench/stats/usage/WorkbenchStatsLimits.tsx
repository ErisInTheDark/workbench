/*
 * Exports:
 * - default WorkbenchStatsLimits: a wrapping row of account-limit cards showing what is left per window with even-rationing notches, and folded history.
 */
import type { WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { formatRateLimitIdentity, formatRateLimitWindowLabel } from "../../../../workbench/rate-limit-display";
import useStats from "../use-stats";
import LineChart from "../../../ui/LineChart";
import Skeleton, { statsRevealClassName } from "../../../ui/Skeleton";
import { formatPercent, formatResetIn } from "../stats-formatters";
import { rationThresholds } from "./stats-ration";

type Limit = WorkbenchStatsSectionData<"limits">["rateLimits"][number];
const WINDOW_KINDS = ["primary", "secondary", "tertiary"] as const;
const WINDOW_FALLBACK = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary" } as const;

/** Only the newest sample decides which windows exist; older samples cannot resurrect a dropped window. */
function currentWindows(limit: Limit) {
  const latest = limit.samples.at(-1);
  return WINDOW_KINDS.flatMap((kind) => {
    const window = latest?.[kind];
    return window ? [{ kind, window, label: formatRateLimitWindowLabel(window.durationMinutes, WINDOW_FALLBACK[kind]) }] : [];
  });
}

function pressure(usedPercent: number) {
  return usedPercent >= 85 ? { bar: "bg-hue-25", text: "text-hue-25" }
    : usedPercent >= 60 ? { bar: "bg-hue-75", text: "text-hue-75" }
      : { bar: "bg-hue-150", text: "text-hue-150" };
}

function observedAgo(observedAt: number, now: number) {
  const minutes = Math.round((now - observedAt) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const left = (usedPercent: number) => Math.max(0, 100 - usedPercent);

/** Account-wide plan limits, so they ignore the scope and period every other panel follows. */
export default function WorkbenchStatsLimits() {
  const { data } = useStats.limits();
  const now = data?.generatedAt ?? 0;
  const limits = (data?.rateLimits ?? []).filter((limit) => currentWindows(limit).length);
  return (
    <section aria-labelledby="stats-limits-heading" className="space-y-2">
      <h2 className="m-0 text-[0.74rem] font-semibold text-fg/muted" id="stats-limits-heading">Plan limits left</h2>
      {!data ? (
        // Two cards of title, two windows and their meters: the usual shape of a reading.
        <div className="flex flex-wrap gap-x-8 gap-y-5">
          {[0, 1].map((index) => (
            <div className="min-w-0 flex-[1_1_15rem] space-y-2.5 sm:max-w-[24rem]" key={index}>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
      ) : !limits.length ? (
        <p className={`m-0 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>No limit readings yet. They appear after a provider reports its plan usage.</p>
      ) : (
        <div className={`flex flex-wrap gap-x-8 gap-y-5 ${statsRevealClassName}`}>
          {limits.map((limit) => {
            const windows = currentWindows(limit);
            const latest = limit.samples.at(-1)!;
            return (
              <div className="min-w-0 flex-[1_1_15rem] space-y-2 sm:max-w-[24rem]" key={`${limit.harness}:${limit.limitId}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="m-0 truncate text-[0.84rem] font-semibold text-text">
                    {formatRateLimitIdentity(limit.harness, limit.limitId, limit.limitName)}
                  </h3>
                  <span className="shrink-0 text-[0.68rem] text-fg/muted">updated {observedAgo(latest.observedAt, now)}</span>
                </div>
                <ul className="m-0 space-y-2 p-0 [--hue-chroma:60%]">
                  {windows.map(({ kind, window, label }) => (
                    <li className="list-none" key={kind}>
                      <div className="flex items-baseline justify-between gap-2 text-[0.74rem] tabular-nums">
                        <span className="font-medium text-text">{label}</span>
                        <span className="text-fg/muted">
                          <span className={`font-semibold ${pressure(window.usedPercent).text}`}>{formatPercent(left(window.usedPercent))} left</span>
                          {formatResetIn(window.resetsAt, now) ? ` · ${formatResetIn(window.resetsAt, now)}` : ""}
                        </span>
                      </div>
                      <div
                        aria-label={`${label} ${formatPercent(left(window.usedPercent))} left`}
                        aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(left(window.usedPercent))}
                        className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-fg/8"
                        role="meter"
                      >
                        <div className={`h-full rounded-full ${pressure(window.usedPercent).bar}`} style={{ width: `${Math.max(1, left(window.usedPercent))}%` }} />
                        {/* Notches in the page colour: what should still be left at each step if what is left now is spread evenly. */}
                        {rationThresholds({ ...window, leftPercent: left(window.usedPercent) }, now).map((threshold) => (
                          <span aria-hidden="true" className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-bg" key={threshold} style={{ left: `${threshold}%` }} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
                {limit.samples.length > 1 ? (
                  <details className="text-[0.72rem] text-fg/muted">
                    <summary className="w-fit cursor-pointer rounded-md px-1 hover:bg-fg/6 hover:text-text">History</summary>
                    <div className="mt-2">
                      <LineChart
                        buckets={limit.samples.map(({ observedAt }) => observedAt)}
                        fixedMaximum={100}
                        formatValue={formatPercent}
                        series={windows.map(({ kind, label }, index) => ({
                          colourClassName: ["text-hue-210", "text-hue-300", "text-hue-140"][index],
                          label,
                          values: limit.samples.map((sample) => sample[kind] ? left(sample[kind].usedPercent) : null),
                        }))}
                        title="Left"
                      />
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
