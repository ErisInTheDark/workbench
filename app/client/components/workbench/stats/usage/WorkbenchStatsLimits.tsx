/*
 * Exports:
 * - default WorkbenchStatsLimits: a wrapping row of account-limit cards showing what is left per window against even rationing,
 *   with the longest window's use over time folded into a history sparkline.
 */
import { statsRangeShape, type WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { formatRateLimitIdentity, formatRateLimitWindowLabel } from "../../../../workbench/rate-limit-display";
import useStats from "../use-stats";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import Sparkline from "../../../ui/Sparkline";
import { formatPercent } from "../stats-formatters";
import StatsLoading from "../StatsLoading";
import { LIMIT_WINDOW_KINDS, currentLimitWindow, largestLimitWindow, limitResolution, limitUsageByBucket } from "./stats-limit-usage";
import WorkbenchStatsLimitMeter from "./WorkbenchStatsLimitMeter";

type Limit = WorkbenchStatsSectionData<"limits">["rateLimits"][number];
const WINDOW_FALLBACK = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary" } as const;

/** Only the newest sample decides which windows exist; where each stands ignores stale readings from lagging sources. */
function currentWindows(limit: Limit) {
  return LIMIT_WINDOW_KINDS.flatMap((kind) => {
    const window = currentLimitWindow(limit.samples, kind);
    return window ? [{ kind, window, label: formatRateLimitWindowLabel(window.durationMinutes, WINDOW_FALLBACK[kind]) }] : [];
  });
}

function formatDuration(ms: number) {
  const hours = ms / 3_600_000;
  return hours < 24 ? `${hours}h` : `${hours / 24}d`;
}

function observedAgo(observedAt: number, now: number) {
  const minutes = Math.round((now - observedAt) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Account-wide plan limits, so they ignore the scope and period every other panel follows. */
export default function WorkbenchStatsLimits() {
  const { range } = useStats();
  const { data, loading, refining } = useStats.limits();
  const now = data?.generatedAt ?? 0;
  const limits = (data?.rateLimits ?? []).filter((limit) => currentWindows(limit).length);
  const resolution = limitResolution(statsRangeShape(range, now).startedAt, now);
  // Machines answer one by one; until the last does, the cards shown are incomplete.
  const pending = Boolean(data) && (loading || refining);
  return (
    <section aria-busy={!data || pending} aria-labelledby="stats-limits-heading" className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[0.74rem] font-semibold text-fg/muted" id="stats-limits-heading">Plan limits left</h2>
        {pending ? <StatsLoading /> : null}
      </div>
      {!data ? (
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
        <div className={`flex flex-wrap gap-x-8 gap-y-5 ${statsRevealClassName} ${statsReloadingClassName(pending)}`}>
          {limits.map((limit) => {
            const windows = currentWindows(limit);
            const latest = limit.samples.at(-1)!;
            const largest = largestLimitWindow(limit);
            const largestLabel = windows.find(({ kind }) => kind === largest?.kind)?.label;
            const used = largest ? limitUsageByBucket(limit.samples, largest.kind, resolution) : [];
            const peak = Math.max(0, ...used.map((value) => value ?? 0));
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
                      <WorkbenchStatsLimitMeter label={label} now={now} window={window} />
                    </li>
                  ))}
                </ul>
                {used.filter((value) => value !== null).length > 1 ? (
                  <details className="text-[0.72rem] text-fg/muted">
                    <summary className="w-fit cursor-pointer rounded-md px-1 hover:bg-fg/6 hover:text-text">History</summary>
                    <div
                      className="relative mt-1 h-12 [--hue-chroma:50%]"
                      title={`${largestLabel} used per ${formatDuration(resolution.bucketMs)}, peak ${formatPercent(peak)}`}
                    >
                      <Sparkline className="text-hue-210" values={used} />
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
