/*
 * Exports:
 * - default WorkbenchCacheEfficiency: input cache hit rate per period, and the large threads with the lowest hit rates.
 */
import { useWorkbenchProjectNavigation } from "../../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchThreadHoverTooltip from "../../WorkbenchThreadHoverTooltip";
import useStats from "../use-stats";
import ShareList from "../../../ui/ShareList";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import StreamChart from "../../../ui/StreamChart";
import { compactNumber, formatPercent, formatStatsBucket } from "../stats-formatters";
import { statsThreadIdentity } from "../stats-thread-identity";

/** Mirrors the daemon cut so older daemons that still send small threads read the same. */
const MINIMUM_UNCACHED_FOR_HIT_RATE = 500_000;

export default function WorkbenchCacheEfficiency() {
  // Live thread details load from this machine, so hover cards show only for local threads.
  const { isLocal, openThread, projectName, showProjects, threadRoute } = useStats();
  const { data: stats, loading } = useStats.usage();
  const cache = stats?.cacheEfficiency;
  const projectHref = useWorkbenchProjectNavigation();
  const misses = (cache?.worstThreads ?? [])
    .map((thread) => ({ ...thread, uncached: thread.inputTokens - thread.cachedInputTokens }))
    .filter(({ uncached }) => uncached >= MINIMUM_UNCACHED_FOR_HIT_RATE);
  const hitRate = cache?.totals.cacheHitPercent ?? null;
  const rates = cache?.buckets.map((bucket) => bucket.cacheHitPercent) ?? [];
  // The worst period sits on the baseline; a whole-percent floor below 100 keeps a flat line visible.
  const floor = Math.min(99, Math.floor(Math.min(...rates.filter((rate) => rate !== null))));
  // The best period reaches the top, rounded up to a whole percent, so the band fills the chart instead of hugging the floor.
  const ceiling = Math.min(100, Math.max(floor + 1, Math.ceil(Math.max(...rates.filter((rate) => rate !== null)))));
  return (
    <section aria-busy={loading} aria-labelledby="cache-efficiency-heading" className={`space-y-3 [--hue-chroma:50%] ${statsReloadingClassName(loading && Boolean(stats))}`}>
      <h2 className="m-0 text-[1rem] font-semibold text-text" id="cache-efficiency-heading">
        Input caching
        {hitRate !== null ? <span className={`ml-2 text-[0.82rem] font-medium text-hue-300 ${statsRevealClassName}`}>{formatPercent(hitRate)} hit rate</span> : null}
      </h2>
      {!cache ? (
        <div aria-hidden="true" className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-40 w-full opacity-60" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="space-y-2">
            <Skeleton className="mx-2 h-3 w-56" />
            <ShareList empty="" loadingRows={3} rows={null} />
          </div>
        </div>
      ) : hitRate === null ? (
        <p className={`m-0 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>No recorded input for these filters.</p>
      ) : (
        <div className={`grid gap-8 lg:grid-cols-2 ${statsRevealClassName}`}>
          <div className="min-w-0 space-y-2">
            <h3 className="m-0 text-[0.74rem] font-semibold text-fg/muted">Hit rate per period</h3>
            <StreamChart
              buckets={cache.buckets.map((bucket) => bucket.startedAt)}
              className="h-40"
              formatBucket={(startedAt) => formatStatsBucket(startedAt, stats?.bucketUnit ?? "day")}
              formatValue={formatPercent}
              label="Input cache hit rate per period"
              maximum={Number.isFinite(ceiling) ? ceiling : 100}
              minimum={Number.isFinite(floor) ? floor : 0}
              series={[{ key: "hitRate", label: "Hit rate", textClassName: "text-hue-300", values: rates }]}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <h3 className="m-0 px-2 text-[0.74rem] font-semibold text-fg/muted">Lowest hit rates · threads with 500K+ uncached input</h3>
            <ShareList
              // Opaque, so the red uncached track never tints the hit share.
              barClassName="bg-[color-mix(in_srgb,var(--text)_22%,var(--bg))]"
              empty="No large threads missed the cache."
              rows={misses.map((thread) => ({
                key: `${thread.projectId}:${thread.threadId}`,
                label: (
                  <WorkbenchThreadHoverTooltip thread={isLocal(thread.daemonId) ? statsThreadIdentity(thread) : null} title={thread.title || thread.threadId}>
                    <a
                      className="rounded-sm hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      href={projectHref(threadRoute(thread))}
                      onClick={(event) => openThread(event, thread)}
                    >
                      {thread.title || thread.threadId}
                    </a>
                  </WorkbenchThreadHoverTooltip>
                ),
                detail: `${showProjects ? `${projectName(thread.projectId, thread.daemonId)} · ` : ""}${compactNumber(thread.uncached)} uncached`,
                share: thread.cacheHitPercent / 100,
                value: formatPercent(thread.cacheHitPercent),
              }))}
              trackClassName="bg-hue-25 [--hue-chroma:65%]"
            />
          </div>
        </div>
      )}
    </section>
  );
}
