/*
 * Exports:
 * - default WorkbenchCacheEfficiency: present independent cache percentages and lowest-cache thread links.
 */
import type { MouseEvent } from "react";
import { createThreadHref } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { hasStatsCategoryCosts } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import { compactNumber } from "./stats-formatters";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

const inputCategories = STATS_TOKEN_SERIES.filter(({ key }) => key !== "output");
const cacheCategory = STATS_TOKEN_SERIES.find(({ key }) => key === "cache")!;

export default function WorkbenchCacheEfficiency({
  global,
  onNavigateThread,
  projectNamesById,
  stats,
}: {
  global: boolean;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projectNamesById: ReadonlyMap<string, string>;
  stats: WorkbenchStatsResponse | null;
}) {
  const cache = stats && hasStatsCategoryCosts(stats) ? stats.cacheEfficiency : undefined;
  return (
    <section aria-labelledby="cache-efficiency-heading" className="space-y-3 [--hue-chroma:50%]">
      <div className="space-y-1">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="cache-efficiency-heading">Input cache efficiency</h2>
        <p className="m-0 text-[0.75rem] text-muted">
          Cache % is cached input as a percentage of all recorded input. Cache writes are not hits.
          Token-category toggles do not change these percentages.
        </p>
      </div>
      {!cache ? (
        <p className="m-0 text-[0.8rem] text-muted">
          {stats ? "Independent cache statistics are unavailable from this server version." : "Waiting for cache statistics."}
        </p>
      ) : cache.totals.cacheHitPercent === null ? (
        <p className="m-0 text-[0.8rem] text-muted">No recorded input for these filters.</p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <WorkbenchStatsChart
              buckets={cache.buckets.map((bucket) => bucket.startedAt)}
              fixedMaximum={100}
              formatValue={(value) => `${value.toFixed(1)}%`}
              series={[{
                colourClassName: cacheCategory.colourClassName,
                label: "Cache %",
                values: cache.buckets.map((bucket) => bucket.cacheHitPercent),
              }]}
              title="Cache % over time"
            />
            <p className="m-0 text-[0.7rem] text-muted">
              Fixed 0-100% scale. Gaps mean no recorded input. Overall cache % is weighted by input volume.
            </p>
          </div>
          <div className="min-w-0 space-y-3">
            <h3 className="m-0 text-[0.78rem] font-semibold text-muted">Lowest cache % threads</h3>
            <ol className="m-0 space-y-3 p-0">
              {cache.worstThreads.map((thread) => {
                const tokens = thread.cacheWriteInputTokens === undefined ? null : {
                  all: thread.inputTokens,
                  input: thread.inputTokens,
                  cachedInput: thread.cachedInputTokens,
                  cacheWriteInput: thread.cacheWriteInputTokens,
                  uncachedInput: thread.inputTokens - thread.cachedInputTokens - thread.cacheWriteInputTokens,
                  output: 0,
                };
                return (
                  <li className="flex min-w-0 items-baseline justify-between gap-3" key={thread.threadId}>
                    <a
                      className="min-w-0 truncate rounded-sm text-[0.8rem] font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                      href={createThreadHref(thread.projectId, thread.threadId)}
                      onClick={(event) => onNavigateThread(event, thread.projectId, thread.threadId)}
                      title={thread.title || thread.threadId}
                    >
                      {thread.title || thread.threadId}
                      {global ? (
                        <span className="ml-2 font-normal text-muted">{projectNamesById.get(thread.projectId) ?? thread.projectId}</span>
                      ) : null}
                    </a>
                    <span className="max-w-[65%] shrink-0 text-right text-[0.72rem] tabular-nums text-muted">
                      <span className={`font-semibold ${cacheCategory.colourClassName}`}>{thread.cacheHitPercent.toFixed(1)}%</span>
                      {tokens ? (
                        <span className="flex flex-wrap justify-end gap-x-2 gap-y-1 text-[0.68rem]">
                          {inputCategories.map(({ key, label, colourClassName, Icon, count }) => (
                            <span className={`inline-flex items-center gap-1 font-bold ${colourClassName}`} key={key}>
                              <Icon className="shrink-0" size={12} />{label} {compactNumber(count(tokens))}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="m-0 text-[0.7rem] text-muted">
              Lowest first within the selected filters. New or small threads can have low cache % without wasting much input.
              {" "}Cache includes cache writes, but cache % counts reads only.
            </p>
            {cache.worstThreads.some((thread) => thread.cacheWriteInputTokens === undefined) ? (
              <p className="m-0 text-[0.7rem] text-muted">Category counts are unavailable from this server version.</p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
