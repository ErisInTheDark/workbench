/*
 * Exports:
 * - default WorkbenchCacheEfficiency: input cache hit rate per period, and the large threads with the lowest hit rates.
 */
import type { MouseEvent } from "react";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchThreadHoverTooltip from "../WorkbenchThreadHoverTooltip";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import WorkbenchStatsShareList from "./WorkbenchStatsShareList";
import { compactNumber, formatPercent } from "./stats-formatters";
import { statsThreadIdentity } from "./stats-thread-identity";

/** Mirrors the daemon cut so older daemons that still send small threads read the same. */
const MINIMUM_UNCACHED_FOR_HIT_RATE = 500_000;

export default function WorkbenchCacheEfficiency({ onNavigateThread, projectName, showProjects, stats }: {
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projectName: (projectId: string) => string;
  showProjects: boolean;
  stats: Pick<WorkbenchStatsResponse, "cacheEfficiency"> | null;
}) {
  const cache = stats?.cacheEfficiency;
  const projectHref = useWorkbenchProjectNavigation();
  const misses = (cache?.worstThreads ?? [])
    .map((thread) => ({ ...thread, uncached: thread.inputTokens - thread.cachedInputTokens }))
    .filter(({ uncached }) => uncached >= MINIMUM_UNCACHED_FOR_HIT_RATE);
  const hitRate = cache?.totals.cacheHitPercent ?? null;
  const rates = cache?.buckets.map((bucket) => bucket.cacheHitPercent) ?? [];
  // The worst period sits on the baseline; a whole-percent floor below 100 keeps a flat line visible.
  const floor = Math.min(99, Math.floor(Math.min(...rates.filter((rate) => rate !== null))));
  return (
    <section aria-labelledby="cache-efficiency-heading" className="space-y-3 [--hue-chroma:50%]">
      <h2 className="m-0 text-[1rem] font-semibold text-text" id="cache-efficiency-heading">
        Input caching
        {hitRate !== null ? <span className="ml-2 text-[0.82rem] font-medium text-hue-300">{formatPercent(hitRate)} hit rate</span> : null}
      </h2>
      {!cache || hitRate === null ? (
        <p className="m-0 text-[0.8rem] text-fg/muted">{stats ? "No recorded input for these filters." : "-"}</p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <WorkbenchStatsChart
            appearance="area"
            buckets={cache.buckets.map((bucket) => bucket.startedAt)}
            fixedMaximum={100}
            formatValue={formatPercent}
            minimum={Number.isFinite(floor) ? floor : 0}
            series={[{ colourClassName: "text-hue-300", label: "Hit rate", values: rates }]}
            title="Hit rate per period"
          />
          <div className="min-w-0 space-y-2">
            <h3 className="m-0 px-2 text-[0.74rem] font-semibold text-fg/muted">Lowest hit rates · threads with 500K+ uncached input</h3>
            <WorkbenchStatsShareList
              // Opaque, so the red uncached track never tints the hit share.
              barClassName="bg-[color-mix(in_srgb,var(--text)_22%,var(--bg))]"
              empty="No large threads missed the cache."
              rows={misses.map((thread) => ({
                key: `${thread.projectId}:${thread.threadId}`,
                label: (
                  <WorkbenchThreadHoverTooltip thread={statsThreadIdentity(thread)} title={thread.title || thread.threadId}>
                    <a
                      className="rounded-sm hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      href={projectHref(createThreadRoute(thread.projectId, thread.threadId))}
                      onClick={(event) => onNavigateThread(event, thread.projectId, thread.threadId)}
                    >
                      {thread.title || thread.threadId}
                    </a>
                  </WorkbenchThreadHoverTooltip>
                ),
                detail: `${showProjects ? `${projectName(thread.projectId)} · ` : ""}${compactNumber(thread.uncached)} uncached`,
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
