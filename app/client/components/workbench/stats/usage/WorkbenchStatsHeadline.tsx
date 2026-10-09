/*
 * Exports:
 * - default WorkbenchStatsHeadline: headline cost, tokens, threads, turns, and cache rate over their trend, each compared with the previous period.
 */
import useStats from "../use-stats";
import WorkbenchStatsSkeleton, { statsReloadingClassName, statsRevealClassName } from "../WorkbenchStatsSkeleton";
import WorkbenchStatsSparkline from "../WorkbenchStatsSparkline";
import { compactNumber, formatMoney, formatPercent, statsDelta } from "../stats-formatters";

/** Only spend has a good direction; other counts change without being better or worse. */
function Delta({ current, previous, judged }: { current: number; previous: number; judged: boolean }) {
  const delta = statsDelta(current, previous);
  if (delta === null) return <span className="text-fg/muted">{current > 0 ? "new this period" : " "}</span>;
  const rounded = Math.round(delta);
  if (rounded === 0) return <span className="text-fg/muted">same as before</span>;
  return (
    <span className={!judged ? "text-fg/muted" : rounded > 0 ? "text-hue-40 [--hue-chroma:60%]" : "text-hue-150 [--hue-chroma:55%]"}>
      {rounded > 0 ? "▲" : "▼"} {Math.abs(rounded)}%<span className="text-fg/muted"> vs previous</span>
    </span>
  );
}

interface Card {
  label: string;
  value: string;
  trend: readonly (number | null)[];
  trendClassName: string;
  comparison?: { current: number; previous: number };
  primary?: boolean;
}

export default function WorkbenchStatsHeadline() {
  const { data: stats, loading } = useStats.usage();
  const cache = stats?.cacheEfficiency.totals.cacheHitPercent ?? null;
  const cards: Card[] = !stats ? [] : [
    {
      label: "API-equivalent cost", value: formatMoney(stats.cost.totalUsd), primary: true,
      trend: stats.cost.buckets.map(({ totalUsd }) => totalUsd), trendClassName: "text-hue-40",
      comparison: { current: stats.cost.totalUsd, previous: stats.previous.costUsd },
    },
    {
      label: "Tokens", value: compactNumber(stats.tokens.totals.all),
      trend: stats.tokens.buckets.map(({ all }) => all), trendClassName: "text-hue-210",
      comparison: { current: stats.tokens.totals.all, previous: stats.previous.tokens },
    },
    {
      label: "Threads", value: compactNumber(stats.summary.threadCount),
      trend: stats.summary.buckets.map(({ threadCount }) => threadCount), trendClassName: "text-hue-260",
      comparison: { current: stats.summary.threadCount, previous: stats.previous.threadCount },
    },
    {
      label: "Turns", value: compactNumber(stats.summary.turnCount),
      trend: stats.summary.buckets.map(({ turnCount }) => turnCount), trendClassName: "text-hue-170",
      comparison: { current: stats.summary.turnCount, previous: stats.previous.turnCount },
    },
    {
      label: "Input cache hits", value: cache === null ? "-" : formatPercent(cache),
      trend: stats.cacheEfficiency.buckets.map(({ cacheHitPercent }) => cacheHitPercent), trendClassName: "text-hue-300",
    },
  ];
  const labels = ["API-equivalent cost", "Tokens", "Threads", "Turns", "Input cache hits"];
  return (
    <dl aria-busy={loading} className={`m-0 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [--hue-chroma:55%] ${statsReloadingClassName(loading && Boolean(stats))}`}>
      {(cards.length ? cards : labels.map((label, index) => ({ label, primary: index === 0 }))).map((card) => {
        const primary = Boolean(card.primary);
        return (
          <div className={`relative min-w-0 overflow-hidden rounded-lg px-3 pb-3 pt-2.5 ${primary ? "col-span-2 sm:col-span-1" : ""}`} key={card.label}>
            {"value" in card ? <WorkbenchStatsSparkline className={card.trendClassName} values={card.trend} /> : null}
            <dt className="relative text-[0.72rem] font-medium text-fg/muted">{card.label}</dt>
            {"value" in card ? (
              <>
                <dd className={`relative m-0 mt-0.5 truncate font-semibold tabular-nums text-text ${primary ? "text-[1.9rem] leading-tight" : "text-[1.35rem] leading-snug"} ${statsRevealClassName}`}>
                  {card.value}
                </dd>
                <dd className={`relative m-0 truncate text-[0.7rem] tabular-nums ${statsRevealClassName}`}>
                  {card.comparison ? <Delta current={card.comparison.current} judged={primary} previous={card.comparison.previous} /> : " "}
                </dd>
              </>
            ) : (
              // Same line boxes as the figures, so the cards keep their height when numbers land.
              <>
                <dd className={`m-0 mt-0.5 flex items-center ${primary ? "h-[2.375rem]" : "h-[1.856rem]"}`}>
                  <WorkbenchStatsSkeleton className={primary ? "h-7 w-28" : "h-5 w-16"} />
                </dd>
                <dd className="m-0 flex h-[1.05rem] items-center"><WorkbenchStatsSkeleton className="h-2.5 w-20" /></dd>
              </>
            )}
          </div>
        );
      })}
    </dl>
  );
}
