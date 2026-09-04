/*
 * Exports:
 * - default WorkbenchClaimHotspots: render ranked files by distinct claiming thread count. Keywords: stats, Git, claims, hotspots.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";

export default function WorkbenchClaimHotspots({
  global,
  projectNamesById,
  stats,
}: {
  global: boolean;
  projectNamesById: ReadonlyMap<string, string>;
  stats: WorkbenchStatsResponse;
}) {
  return (
    <section aria-labelledby="claims-heading" className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="claims-heading">Claim traffic</h2>
        <span className="text-[0.72rem] text-muted">distinct threads declaring each file</span>
      </div>
      {stats.claimHotspots.length ? (
        <ol className="m-0 grid gap-x-8 gap-y-2 p-0 lg:grid-cols-2">
          {stats.claimHotspots.map((hotspot) => (
            <li className="flex min-w-0 items-baseline justify-between gap-4" key={`${hotspot.projectId}:${hotspot.rootId}:${hotspot.path}`}>
              <span className="min-w-0 truncate font-mono text-[0.76rem] text-text" title={hotspot.path}>
                {global ? `${projectNamesById.get(hotspot.projectId) ?? hotspot.projectId} · ` : ""}{hotspot.rootId}:{hotspot.path}
              </span>
              <span className="shrink-0 text-[0.72rem] text-muted">{hotspot.threadCount} threads</span>
            </li>
          ))}
        </ol>
      ) : <p className="m-0 text-[0.8rem] text-muted">No claim history in this range.</p>}
    </section>
  );
}
