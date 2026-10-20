"use client";

/*
 * Exports:
 * - default WorkbenchStatsLimits: an even grid of limit cards, one per account, showing what is left per window against even
 *   rationing, with the longest window's use over time folded into a history sparkline.
 */
import { useState } from "react";
import { statsRangeShape, type WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { formatRateLimitIdentity, formatRateLimitWindowLabel } from "../../../../workbench/rate-limit-display";
import useStats from "../use-stats";
import IconButton from "../../../ui/IconButton";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import Sparkline from "../../../ui/Sparkline";
import { EyeIcon, EyeOffIcon } from "../../workbench-icons";
import { formatPercent } from "../stats-formatters";
import StatsLoading from "../StatsLoading";
import {
  LIMIT_WINDOW_KINDS, currentLimitWindow, largestLimitWindow, limitAccountNames, limitResolution, limitUsageByBucket,
  type LimitAccountName, type StatsLimitBuckets,
} from "./stats-limit-usage";
import WorkbenchStatsLimitMeter from "./WorkbenchStatsLimitMeter";

type Limit = WorkbenchStatsSectionData<"limits">["rateLimits"][number];
const WINDOW_FALLBACK = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary" } as const;
/** Equal columns wide enough for an account's title, whatever lands in each row. */
const cardGridClassName = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-8 gap-y-5";

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

/** One account's limit. Its name shows only beside the provider's other accounts, masked until revealed. */
function LimitCard({ limit, name, now, resolution }: {
  limit: Limit; name: LimitAccountName | null; now: number; resolution: StatsLimitBuckets;
}) {
  const [revealed, setRevealed] = useState(false);
  const windows = currentWindows(limit);
  const latest = limit.samples.at(-1)!;
  const largest = largestLimitWindow(limit);
  const largestLabel = windows.find(({ kind }) => kind === largest?.kind)?.label;
  const used = largest ? limitUsageByBucket(limit.samples, largest.kind, resolution) : [];
  const peak = Math.max(0, ...used.map((value) => value ?? 0));
  const masked = name !== null && name.short !== name.full;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 flex min-w-0 items-center gap-1 text-[0.84rem] font-semibold text-text">
          <span className="truncate">
            {formatRateLimitIdentity(limit.harness, limit.limitId, limit.limitName)}
            {name ? <span className="font-normal text-fg/muted"> · {revealed ? name.full : name.short}</span> : null}
          </span>
          {masked ? (
            <IconButton
              aria-pressed={revealed} display="hover-border" label={revealed ? "Hide account" : "Show account"}
              onClick={() => setRevealed(!revealed)} size="compact"
            >
              {revealed ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
            </IconButton>
          ) : null}
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
}

/** Account-wide plan limits, so they ignore the scope and period every other panel follows. */
export default function WorkbenchStatsLimits() {
  const { range } = useStats();
  const { data, loading, refining } = useStats.limits();
  const now = data?.generatedAt ?? 0;
  const limits = (data?.rateLimits ?? []).filter((limit) => currentWindows(limit).length);
  const names = limitAccountNames(limits);
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
        <div className={cardGridClassName}>
          {[0, 1].map((index) => (
            <div className="min-w-0 space-y-2.5" key={index}>
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
        <div className={`
          ${cardGridClassName}
          ${statsRevealClassName}
          ${statsReloadingClassName(pending)}
        `}>
          {limits.map((limit, index) => (
            <LimitCard
              key={`${limit.harness}:${limit.account?.key ?? `unknown-${index}`}:${limit.limitId}`}
              limit={limit} name={names[index] ?? null} now={now} resolution={resolution}
            />
          ))}
        </div>
      )}
    </section>
  );
}
