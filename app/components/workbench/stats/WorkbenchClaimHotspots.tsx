/*
 * Exports:
 * - default WorkbenchClaimHotspots: render ranked files by distinct claiming thread count. Keywords: stats, Git, claims, hotspots.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import ProjectFilePath from "../ProjectFilePath";

export default function WorkbenchClaimHotspots({
  global,
  projectNamesById,
  stats,
  projects,
}: {
  global: boolean;
  projectNamesById: ReadonlyMap<string, string>;
  stats: Pick<WorkbenchStatsResponse, "claimHotspots"> | null;
  projects: readonly Pick<WorkbenchProjectOption, "id" | "kind" | "roots">[];
}) {
  return (
    <section aria-labelledby="claims-heading" className="space-y-3" data-thread-project-file-link-boundary="true">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="claims-heading">Claim traffic</h2>
        <span className="text-[0.72rem] text-fg/muted">distinct threads declaring each file</span>
      </div>
      <div>
        {stats?.claimHotspots.length ? (
          <ol className="m-0 grid auto-rows-[2rem] gap-x-8 p-0 lg:grid-cols-2">
            {stats.claimHotspots.map((hotspot) => {
              const project = projects.find(({ id }) => id === hotspot.projectId);
              const rootKnown = project?.roots.some(({ id }) => id === hotspot.rootId);
              const qualify = (rootId: string, path: string) => project?.kind === "git" ? path : `${rootId}:${path}`;
              const openPath = qualify(hotspot.rootId, hotspot.path);
              return (
                <li className="flex min-w-0 items-baseline justify-between gap-4" key={`${hotspot.projectId}:${hotspot.rootId}:${hotspot.path}`}>
                  <span className="flex min-w-0 items-baseline gap-2 text-[0.76rem]">
                    {global ? <span className="truncate text-fg/muted">{projectNamesById.get(hotspot.projectId) ?? hotspot.projectId}</span> : null}
                    <ProjectFilePath
                      className="min-w-0 shrink"
                      path={openPath}
                      projectId={rootKnown ? hotspot.projectId : null}
                      disambiguationPaths={stats.claimHotspots.filter((row) => row.projectId === hotspot.projectId).map((row) => qualify(row.rootId, row.path))}
                    />
                  </span>
                  <span className="shrink-0 text-[0.72rem] text-fg/muted">{hotspot.threadCount} threads</span>
                </li>
              );
            })}
          </ol>
        ) : <p className="m-0 text-[0.8rem] text-fg/muted">{stats ? "No claim history in this range." : "-"}</p>}
      </div>
    </section>
  );
}
