"use client";

/*
 * Exports:
 * - default WorkbenchClaimHotspots: a cloud of contended file links sized by claiming threads; hovering lists those threads as standard thread rows.
 */
import { LogicalProjectIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import ProjectFilePath from "../../ProjectFilePath";
import WorkbenchThreadReferenceList from "../../WorkbenchThreadReferenceList";
import WorkbenchTooltip from "../../WorkbenchTooltip";
import useStats from "../use-stats";
import WorkbenchStatsSkeleton, { statsReloadingClassName, statsRevealClassName } from "../WorkbenchStatsSkeleton";
import { compactNumber } from "../stats-formatters";
import { statsThreadIdentity } from "../stats-thread-identity";

type Hotspot = WorkbenchStatsSectionData<"claims">["claimHotspots"][number];

// A word cloud's worth of placeholder words, sized like a typical spread of claim counts.
const SKELETON_WORDS = [
  ["w-24", "h-3.5"], ["w-36", "h-5"], ["w-20", "h-3"], ["w-44", "h-6"], ["w-28", "h-4"], ["w-32", "h-3.5"], ["w-24", "h-4.5"],
  ["w-40", "h-3"], ["w-16", "h-3.5"], ["w-52", "h-7"], ["w-28", "h-3"], ["w-36", "h-4"], ["w-20", "h-3.5"], ["w-32", "h-5"],
];

function ClaimantList({ hotspot, isLocal, path, project }: {
  hotspot: Hotspot; isLocal: (daemonId: string | null | undefined) => boolean; path: string; project: string | null;
}) {
  // Claimants arrive largest first; only threads Workbench owns can open, the rest are only counted.
  const references = hotspot.threads.flatMap(({ daemonId, harness, threadId, title, tokens }) => {
    const thread = statsThreadIdentity({ harness, projectId: hotspot.projectId, threadId });
    // Another machine's thread opens by id through its logical project.
    const logicalProjectId = isLocal(daemonId) ? null : LogicalProjectIdSchema.safeParse(hotspot.logicalProjectId).data ?? null;
    return thread ? [{
      detail: <span className="tabular-nums" title="Lifetime tokens">{tokens ? compactNumber(tokens) : "-"}</span>,
      identity: { harness: thread.harness, threadId: thread.threadId }, logicalProjectId,
      projectId: thread.projectId, title: title ?? "Untitled thread",
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

export default function WorkbenchClaimHotspots() {
  const { isLocal, projectName, projects, showProjects } = useStats();
  const { data: stats, loading, refining } = useStats.claims();
  // Counts arrive before rename history merges renamed files together.
  const pending = refining;
  const hotspots = stats?.claimHotspots ?? [];
  const counts = hotspots.map(({ threadCount }) => threadCount);
  const minimum = Math.min(...counts);
  const span = Math.max(...counts) - minimum || 1;
  const multipleProjects = showProjects && new Set(hotspots.map(({ logicalProjectId, projectId }) => logicalProjectId ?? projectId)).size > 1;
  // Alphabetical order scatters the big words instead of stacking them all at the start.
  const cloud = [...hotspots].sort((left, right) => left.path.localeCompare(right.path));
  return (
    <section
      aria-busy={loading || pending}
      aria-labelledby="claims-heading"
      className={`space-y-3 ${statsReloadingClassName(loading && Boolean(stats))}`}
      data-thread-project-file-link-boundary="true"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="claims-heading">Contended files</h2>
        {pending ? <span aria-live="polite" className="text-[0.72rem] text-fg/muted">following renamed files…</span> : null}
      </div>
      {!stats ? (
        // Clouds run three to five lines; holding that height keeps the feedback below from jumping.
        <div aria-hidden="true" className="flex min-h-44 flex-wrap content-center items-center justify-center gap-x-5 gap-y-4 py-2">
          {SKELETON_WORDS.map(([width, height], index) => <WorkbenchStatsSkeleton className={`${width} ${height}`} key={index} />)}
        </div>
      ) : !cloud.length ? <p className={`m-0 py-1 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>{pending ? "Reading claims…" : "No claims in this period."}</p> : (
        <ul
          aria-busy={pending}
          className={`m-0 flex min-h-44 flex-wrap content-center items-baseline justify-center gap-x-5 gap-y-2 p-0 py-2 transition-opacity [--hue-chroma:40%] ${statsRevealClassName} ${pending ? "opacity-60" : ""}`}
        >
          {cloud.map((hotspot) => {
            const weight = (hotspot.threadCount - minimum) / span;
            // Only this machine's files open in the editor; another machine's show as plain paths.
            const project = isLocal(hotspot.daemonId) ? projects.find(({ id }) => id === hotspot.projectId) : undefined;
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
                      isLocal={isLocal}
                      path={qualify(hotspot.rootId, hotspot.path)}
                      project={multipleProjects ? hotspot.logicalProjectId ? projectName(hotspot.logicalProjectId) : projectName(hotspot.projectId, hotspot.daemonId) : null}
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
      {stats?.historyFailures.length ? (
        <p className={`m-0 text-[0.72rem] text-fg/muted ${statsRevealClassName}`} title={stats.historyFailures.join("\n")}>
          Some rename history could not be read, so a renamed file may still count under its old and new names.
        </p>
      ) : null}
    </section>
  );
}
