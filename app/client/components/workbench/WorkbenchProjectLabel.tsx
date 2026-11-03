/*
 * Exports:
 * - default WorkbenchProjectLabel: render identity-level or concrete project labels without inventing a representative folder;
 *   `describeLogical` gives a logical project's name and the folder or remote label shown beside it, for non-visual labels.
 */

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
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

type LogicalProjectSecondary =
  | { kind: "remote"; label: string }
  | { kind: "location"; displayPath: string; hostname: string };

/** A source row's own folder outranks the shared remote label, so rows on different daemons stay distinguishable. */
function describeLogicalProject(project: WorkbenchLogicalProject, source?: ProjectLocationReference): {
  name: string;
  secondary: LogicalProjectSecondary | null;
  text: string | null;
} {
  const sourceLocation = source ? [
    ...project.locations,
    ...(project.observedLocations ?? []),
  ].find(item => item.daemonId === source.daemonId
    && ("target" in item ? item.target.projectId : item.projectId) === source.projectId) : null;
  const location = sourceLocation ?? project.locations.find(item => item.project)
    ?? project.observedLocations?.[0] ?? project.locations[0];
  const name = project.displayName ?? project.label;
  const displayPath = sourceLocation
    ? "displayPath" in sourceLocation && sourceLocation.displayPath
      ? sourceLocation.displayPath
      : `${sourceLocation.hostname}:${sourceLocation.rootPath}`
    : project.displayPath ?? null;
  const secondary: LogicalProjectSecondary | null = !sourceLocation
    && project.matchKey.startsWith("remote://") && project.label !== name
    ? { kind: "remote", label: project.label }
    : displayPath && displayPath !== name
      ? { kind: "location", displayPath, hostname: location?.hostname ?? "" }
      : null;
  const text = secondary?.kind === "remote" ? secondary.label : secondary?.displayPath ?? null;
  return { name, secondary, text };
}

const WorkbenchProjectLabel = Object.assign(function WorkbenchProjectLabel({
  active = false,
  project,
  source,
  variant = "card",
}: {
  active?: boolean;
  project: WorkbenchProjectOption | WorkbenchLogicalProject;
  source?: ProjectLocationReference;
  /** `tab` is the thread row's compact form, with a smaller icon. */
  variant?: "card" | "heading" | "tab" | "thread";
}) {
  if ("matchKey" in project) {
    const { name, secondary } = describeLogicalProject(project, source);
    return (
      <span className={`flex min-w-0 items-center ${variant === "tab" ? "gap-1" : "gap-2"}`} title={[
        ...project.locations, ...(project.observedLocations ?? []),
      ].map(item => `${item.hostname}: ${item.rootPath}`).join("\n") || project.matchKey}>
        <WorkbenchProjectIcon project={project} variant={variant} />
        <span className={`flex min-w-0 flex-1 items-baseline ${variant === "tab" ? "gap-1" : "gap-2"}`}>
          <span className={`${workbenchThreadListLabelClassName} min-w-0 truncate text-text${active || variant === "heading" ? " font-semibold" : ""}`}>
            {name}
          </span>
          {secondary ? <span className="min-w-0 flex-1 text-[0.72rem] font-normal text-fg/muted">
            {secondary.kind === "remote" ? secondary.label
              : <WorkbenchProjectLocationLabel displayPath={secondary.displayPath} hostname={secondary.hostname} />}
          </span> : null}
        </span>
      </span>
    );
  }
  const projectName = `${project.name || project.id}${project.kind === "workspace" ? " workspace" : ""}`;
  if (variant === "thread" || variant === "tab") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 leading-tight" title={getWorkbenchProjectFullPath(project)}>
        <WorkbenchProjectIcon project={project} variant={variant} />
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
  describeLogical: describeLogicalProject,
  getDisplayPath: getWorkbenchProjectDisplayPath,
  getFullPath: getWorkbenchProjectFullPath,
});

export default WorkbenchProjectLabel;
