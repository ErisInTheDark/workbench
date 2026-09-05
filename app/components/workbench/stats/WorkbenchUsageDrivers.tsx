/*
 * Exports:
 * - default WorkbenchUsageDrivers: render ranked model and top-thread spend drivers. Keywords: stats, models, threads, ranking.
 */
import type { MouseEvent } from "react";

import { createThreadHref } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { compactNumber, formatMoney, providerLabel } from "./stats-formatters";

export default function WorkbenchUsageDrivers({
  global,
  onNavigateThread,
  projectNamesById,
  stats,
}: {
  global: boolean;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projectNamesById: ReadonlyMap<string, string>;
  stats: Pick<WorkbenchStatsResponse, "models" | "topThreads"> | null;
}) {
  return (
    <section aria-labelledby="drivers-heading" className="space-y-3">
      <h2 className="m-0 text-[1rem] font-semibold text-text" id="drivers-heading">Usage drivers</h2>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="m-0 mb-3 text-[0.78rem] font-semibold text-muted">By model</h3>
          {stats?.models.length ? (
            <ol className="m-0 grid auto-rows-[2rem] p-0">
              {stats.models.slice(0, 12).map((model) => (
                <li className="flex min-w-0 items-baseline justify-between gap-4" key={`${model.provider}:${model.model}`}>
                  <span className="min-w-0 truncate text-[0.8rem] text-text">
                    <span className="text-muted">{providerLabel(model.provider)} · </span>{model.model}
                    {model.inferredModelTokens || model.defaultModelTokens ? <span className="ml-1 text-muted" title="Some model attribution was inferred">~</span> : null}
                  </span>
                  <span className="shrink-0 text-right text-[0.72rem] text-muted">
                    {compactNumber(model.tokens)} · {formatMoney(model.costUsd)} · {model.threadCount} threads
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="m-0 text-[0.8rem] text-muted">{stats ? "No model usage in this range." : "-"}</p>}
        </div>
        <div className="min-w-0">
          <h3 className="m-0 mb-3 text-[0.78rem] font-semibold text-muted">Top threads</h3>
          {stats?.topThreads.length ? (
            <ol className="m-0 grid auto-rows-[2rem] p-0">
              {stats.topThreads.map((thread) => (
                <li className="flex min-w-0 items-baseline justify-between gap-4" key={`${thread.projectId}:${thread.threadId}`}>
                  <a
                    className="min-w-0 truncate rounded-sm text-[0.8rem] font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    href={createThreadHref(thread.projectId, thread.threadId)}
                    onClick={(event) => onNavigateThread(event, thread.projectId, thread.threadId)}
                  >
                    {thread.title || thread.threadId}
                    {global ? (
                      <span className="ml-2 font-normal text-muted">
                        {projectNamesById.get(thread.projectId) ?? thread.projectId}
                      </span>
                    ) : null}
                  </a>
                  <span className="shrink-0 text-right text-[0.72rem] text-muted">
                    {compactNumber(thread.tokens)} · {formatMoney(thread.costUsd)} · {thread.sharePercent.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="m-0 text-[0.8rem] text-muted">{stats ? "No thread usage in this range." : "-"}</p>}
        </div>
      </div>
    </section>
  );
}
