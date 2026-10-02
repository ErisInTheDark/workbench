"use client";

/*
 * Exports:
 * - default WorkbenchClaimHotspots: a cloud of contended file links sized by claiming threads; hovering lists those threads as standard thread rows.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import ProjectFilePath from "../ProjectFilePath";
import WorkbenchThreadReferenceList from "../WorkbenchThreadReferenceList";
import WorkbenchTooltip from "../WorkbenchTooltip";
import { compactNumber } from "./stats-formatters";
import { statsThreadIdentity } from "./stats-thread-identity";

type Hotspot = WorkbenchStatsResponse["claimHotspots"][number];

function ClaimantList({ hotspot, path, project }: { hotspot: Hotspot; path: string; project: string | null }) {
  // Claimants arrive largest first; only threads Workbench owns can open, the rest are only counted.
  const references = hotspot.threads.flatMap(({ harness, threadId, title, tokens }) => {
    const thread = statsThreadIdentity({ harness, projectId: hotspot.projectId, threadId });
    return thread ? [{
      detail: <span className="tabular-nums" title="Lifetime tokens">{tokens ? compactNumber(tokens) : "-"}</span>,
      identity: { harness: thread.harness, threadId: thread.threadId }, projectId: thread.projectId, title: title ?? "Untitled thread",
    }] : [];
  });
  const unlisted = hotspot.threadCount - references.length;
  return (
    <div className="w-72 max-w-full space-y-1 text-[0.76rem]">
      <p className="m-0 break-all px-1 font-mono text-[0.72rem] text-fg/muted">{path}</p>
      <p className="m-0 px-1 font-semibold text-text">
        {hotspot.threadCount} {hotspot.threadCount === 1 ? "thread" : "threads"} claimed this{project ? ` in ${project}` : ""}
      </p>
      <div className="-mx-2">
        <WorkbenchThreadReferenceList references={references} />
      </div>
      {unlisted > 0 ? <p className="m-0 px-1 text-fg/muted">{references.length ? `and ${unlisted} more` : "None of them can be opened here"}</p> : null}
    </div>
  );
}

export default function WorkbenchClaimHotspots({ pending = false, projectName, projects, showProjects, stats }: {
  /** Counts arrive before rename history merges renamed files together. */
  pending?: boolean;
  projectName: (projectId: string) => string;
  projects: readonly Pick<WorkbenchProjectOption, "id" | "kind" | "roots">[];
  showProjects: boolean;
  stats: Pick<WorkbenchStatsResponse, "claimHotspots"> | null;
}) {
  const hotspots = stats?.claimHotspots ?? [];
  const counts = hotspots.map(({ threadCount }) => threadCount);
  const minimum = Math.min(...counts);
  const span = Math.max(...counts) - minimum || 1;
  const multipleProjects = showProjects && new Set(hotspots.map(({ projectId }) => projectId)).size > 1;
  // Alphabetical order scatters the big words instead of stacking them all at the start.
  const cloud = [...hotspots].sort((left, right) => left.path.localeCompare(right.path));
  return (
    <section aria-labelledby="claims-heading" className="space-y-3" data-thread-project-file-link-boundary="true">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="claims-heading">Contended files</h2>
        <span aria-live="polite" className="text-[0.72rem] text-fg/muted">
          {pending && stats ? "following renamed files…" : "bigger files were claimed by more threads; hover to see which"}
        </span>
      </div>
      {!cloud.length ? <p className="m-0 py-1 text-[0.8rem] text-fg/muted">{stats ? pending ? "Reading claims…" : "No claims in this period." : "-"}</p> : (
        <ul
          aria-busy={pending}
          className={`m-0 flex flex-wrap items-baseline justify-center gap-x-5 gap-y-2 p-0 py-2 transition-opacity [--hue-chroma:40%] ${pending ? "opacity-60" : ""}`}
        >
          {cloud.map((hotspot) => {
            const weight = (hotspot.threadCount - minimum) / span;
            const project = projects.find(({ id }) => id === hotspot.projectId);
            const rootKnown = project?.roots.some(({ id }) => id === hotspot.rootId);
            // Only multi-root workspaces need the root to disambiguate a path.
            const qualify = (rootId: string, path: string) => project?.kind === "workspace" ? `${rootId}:${path}` : path;
            return (
              <li
                className="max-w-full list-none text-hue-60 leading-tight"
                key={`${hotspot.projectId}:${hotspot.rootId}:${hotspot.path}`}
                style={{ fontSize: `${0.78 + weight * 0.8}rem`, fontWeight: weight > 0.5 ? 600 : 500, opacity: 0.6 + weight * 0.4 }}
              >
                <WorkbenchTooltip
                  content={(
                    <ClaimantList
                      hotspot={hotspot}
                      path={qualify(hotspot.rootId, hotspot.path)}
                      project={multipleProjects ? projectName(hotspot.projectId) : null}
                    />
                  )}
                  interactive
                  placement="top"
                >
                  <span className="inline-flex max-w-full">
                    <ProjectFilePath
                      className="min-w-0"
                      nativeTitle={false}
                      path={qualify(hotspot.rootId, hotspot.path)}
                      projectId={rootKnown ? hotspot.projectId : null}
                      disambiguationPaths={hotspots.filter((row) => row.projectId === hotspot.projectId).map((row) => qualify(row.rootId, row.path))}
                    />
                  </span>
                </WorkbenchTooltip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
