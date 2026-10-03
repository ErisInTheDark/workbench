/*
 * Exports:
 * - default WorkbenchProjectLabel: render identity-level or concrete project labels without inventing a representative folder.
 */

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
import WorkbenchProjectLocationLabel from "./WorkbenchProjectLocationLabel";

function getWorkbenchProjectDisplayPath(project: WorkbenchProjectOption) {
  const relativePath = project.relativePath || project.id || ".";
  return project.kind === "workspace"
    ? `${relativePath} · ${project.roots.length} roots`
    : relativePath;
}

function getWorkbenchProjectFullPath(project: WorkbenchProjectOption) {
  return project.kind === "workspace"
    ? project.roots.map((root) => `${root.id}: ${root.rootPath}`).join("\n")
    : project.rootPath;
}

const WorkbenchProjectLabel = Object.assign(function WorkbenchProjectLabel({
  active = false,
  project,
  variant = "card",
}: {
  active?: boolean;
  project: WorkbenchProjectOption | WorkbenchLogicalProject;
  variant?: "card" | "heading" | "thread";
}) {
  if ("matchKey" in project) {
    const location = project.locations.find(item => item.project)
      ?? project.observedLocations?.[0] ?? project.locations[0];
    const name = project.displayName ?? project.label;
    const hasDistinctRemoteLabel = project.matchKey.startsWith("remote://") && project.label !== name;
    const secondary = hasDistinctRemoteLabel ? project.label : project.displayPath ?? null;
    return (
      <span className="flex min-w-0 items-center gap-2" title={[
        ...project.locations, ...(project.observedLocations ?? []),
      ].map(item => `${item.hostname}: ${item.rootPath}`).join("\n") || project.matchKey}>
        <WorkbenchProjectIcon project={project} variant={variant} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={`${workbenchThreadListLabelClassName} min-w-0 truncate text-text${active || variant === "heading" ? " font-semibold" : ""}`}>
            {name}
          </span>
          {secondary && secondary !== name ? <span className="min-w-0 flex-1 text-[0.72rem] font-normal text-fg/muted">
            {hasDistinctRemoteLabel ? secondary
              : <WorkbenchProjectLocationLabel displayPath={secondary} hostname={location?.hostname ?? ""} />}
          </span> : null}
        </span>
      </span>
    );
  }
  const projectName = `${project.name || project.id}${project.kind === "workspace" ? " workspace" : ""}`;
  if (variant === "thread") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 leading-tight" title={getWorkbenchProjectFullPath(project)}>
        <WorkbenchProjectIcon project={project} variant="thread" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[0.68rem] font-medium text-fg/72">{projectName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.64rem] font-normal text-fg/muted">{getWorkbenchProjectDisplayPath(project)}</span>
        </span>
      </span>
    );
  }
  if (variant === "heading") {
    return (
      <span className="flex min-w-0 items-center gap-2 leading-tight" title={getWorkbenchProjectFullPath(project)}>
        <WorkbenchProjectIcon project={project} variant="heading" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 truncate text-[1.05rem] font-semibold text-text">{projectName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] font-normal text-fg/muted">{getWorkbenchProjectDisplayPath(project)}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <WorkbenchProjectIcon project={project} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`${workbenchThreadListLabelClassName} shrink-0 text-text${active ? " font-semibold" : ""}`}>{projectName}</span>
        {project.kind === "workbench-library" ? null : (
          <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] font-normal text-fg/muted">{getWorkbenchProjectDisplayPath(project)}</span>
        )}
      </span>
    </span>
  );
}, {
  getDisplayPath: getWorkbenchProjectDisplayPath,
  getFullPath: getWorkbenchProjectFullPath,
});

export default WorkbenchProjectLabel;
